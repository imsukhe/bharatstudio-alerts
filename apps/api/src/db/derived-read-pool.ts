import postgres, { type Sql } from 'postgres';

// RT-10 / RT-11 (FULL-PRODUCT-DEFINITION.md §19.0, §31.18.0). This is the
// bounded, isolated connection pool for widget/dashboard/analytics reads —
// the same "a separate pool for a separate class of work" pattern already
// used in this codebase (`db/public-channel-repository.ts`'s
// `createSqlClient`, `db/overlay-wakeup.ts`'s direct-listener connection,
// `db/template-import-runner.ts`'s importer connection), applied to a new
// class of work rather than inventing a new mechanism.
//
// Two independent, additive protections live on this one pool, both
// configuration-driven and both unset by default (§2 of the owning
// command — never an invented number):
//
//   RT-10 isolation: `max` bounds how many physical connections this pool
//   may ever hold, separate from the main application pool
//   (`db/public-channel-repository.ts`'s `createSqlClient`, currently
//   `max: 10`) — a widget/analytics burst saturating THIS pool cannot take
//   a connection away from a payment-order write, which never uses this
//   pool.
//
//   RT-11 timeout: `statement_timeout` is set once, at physical-connection
//   startup, via postgres.js's `connection` option
//   (`node_modules/postgres` `src/index.js` merges `options.connection`
//   into the Postgres StartupMessage — verified against the installed
//   3.4.9 source, not assumed) — so every query that ever runs on this
//   pool's connections is bounded, for the life of the pool, with no
//   per-query wiring required at each call site. A pathological query
//   against THIS pool is cancelled by Postgres itself
//   (SQLSTATE 57014 `query_canceled`); `isStatementTimeoutError` below
//   recognises that and every call site that uses this pool turns it into
//   the RT-11.3 clear, retryable error.
//
// Both are applied ONLY to the specific read stores this task wires to this
// pool (see `index.ts`'s `derivedReadSql`) — every payment write, webhook
// commit and migration keeps using the main pool or its own service's
// connections entirely, so this pool cannot be the mechanism that delays or
// times out a durable-path statement (RT-10.4, RT-11.2). That is enforced
// by which call sites are wired to this pool, not by a runtime check —
// documented explicitly in `active/tasks/RT-10.md` / `RT-11.md`'s Boundaries
// section.

export type DerivedReadPoolConfig = {
  /** RT-10 §3.1. Unset = share the main pool = today's behaviour, unchanged. */
  poolMax?: number;
  /** RT-11 §3.1. Unset = no statement_timeout = today's behaviour, unchanged. */
  statementTimeoutMs?: number;
};

const STATEMENT_TIMEOUT_SQLSTATE = '57014'; // query_canceled

export class ReadTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`derived read exceeded the configured statement_timeout of ${timeoutMs}ms`);
    this.name = 'ReadTimeoutError';
  }
}

/** True when `error` is Postgres's own statement_timeout cancellation (57014), never a different failure misreported as a timeout. */
export function isStatementTimeoutError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === STATEMENT_TIMEOUT_SQLSTATE;
}

/**
 * Wraps a derived-read call so a 57014 cancellation surfaces as
 * `ReadTimeoutError`, never as an opaque database error (RT-11.3).
 */
export async function runDerivedRead<T>(
  timeoutMs: number | undefined,
  run: () => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (timeoutMs !== undefined && isStatementTimeoutError(error)) {
      try {
        onTimeout?.();
      } catch {
        // A metrics defect must never mask the real error being raised.
      }
      throw new ReadTimeoutError(timeoutMs);
    }
    throw error;
  }
}

/**
 * Creates the derived-read `Sql` handle every governed store (RT-10's
 * `index.ts` wiring) is constructed with. When neither RT-10 nor RT-11 is
 * configured this returns the SAME `mainSql` instance passed in, completely
 * unwrapped — that is the kill switch for both rows: "do not create a
 * second pool, and do not intercept a single query" (unset = today's
 * behaviour, unchanged, §2 of the owning command).
 *
 * When configured, this creates the isolated pool (RT-10) and/or wraps
 * every tagged-template call through it so a 57014 cancellation is
 * translated to `ReadTimeoutError` automatically (RT-11) — no individual
 * store file (`goal-overlay-store.ts`, `challenge-overlay-store.ts`, etc.)
 * needs to know this exists. A `Proxy` is used rather than re-implementing
 * `Sql` because postgres.js's `Sql` is callable (as a tagged-template
 * function) AND carries other methods/properties (`.begin`, `.end`, …);
 * only the call itself is intercepted, everything else passes through
 * unchanged.
 */
// This codebase's own existing precedent for "a secondary pool's size" —
// `db/public-channel-repository.ts`'s `createSqlClient` has used `max: 10`
// since before this task. Reused here, never invented fresh, only when an
// operator configures `statementTimeoutMs` without also naming a
// `poolMax` — RT-11's timeout requires a real Postgres session to set it on
// (there is no per-query timeout option in postgres.js 3.4.9; verified
// against the installed source), so *some* pool must exist for the timeout
// to attach to, and this is the one number already in the codebase for it.
const DEFAULT_DERIVED_POOL_MAX = 10;

// `connection.statement_timeout` (set at pool-creation time, above) already
// bounds every query at the Postgres session level for every connection in
// a pool built with a `statementTimeoutMs`; this Proxy only translates the
// resulting 57014 into `ReadTimeoutError` (RT-11.3). Only the
// tagged-template call itself is intercepted — every other method/property
// (`.begin`, `.end`, …) passes through unchanged, since none of the stores
// this task wires to this pool use them (verified: each is a single
// `select … from app_private.…` read, no transaction). Exported separately
// from `createDerivedReadSql` so the translation itself is directly
// testable against a fake `Sql`-shaped callable, with no real Postgres
// connection required.
export function wrapWithReadTimeout(pooled: Sql, timeoutMs: number, onTimeout?: () => void): Sql {
  return new Proxy(pooled, {
    apply(target, thisArg, args: unknown[]) {
      const templateArgs = args as Parameters<Sql>;
      return runDerivedRead(
        timeoutMs,
        () => Reflect.apply(target, thisArg, templateArgs) as Promise<unknown>,
        onTimeout,
      );
    },
  }) as Sql;
}

export function createDerivedReadSql(
  mainSql: Sql,
  databaseUrl: string | undefined,
  config: DerivedReadPoolConfig,
  onTimeout?: () => void,
): Sql {
  const configured = config.poolMax !== undefined || config.statementTimeoutMs !== undefined;
  if (!configured || !databaseUrl) return mainSql;

  const pooled: Sql = postgres(databaseUrl, {
    max: config.poolMax ?? DEFAULT_DERIVED_POOL_MAX,
    prepare: false,
    onnotice: () => undefined,
    connection: config.statementTimeoutMs !== undefined
      ? { statement_timeout: Math.floor(config.statementTimeoutMs) }
      : undefined,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });

  const timeoutMs = config.statementTimeoutMs;
  if (timeoutMs === undefined) return pooled; // RT-10 isolation only — no translation needed.
  return wrapWithReadTimeout(pooled, timeoutMs, onTimeout);
}
