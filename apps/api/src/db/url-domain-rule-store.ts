import type { Sql, TransactionSql } from 'postgres';
import type {
  CreateUrlDomainRuleInput,
  CreateUrlDomainRuleResult,
  DeleteUrlDomainRuleResult,
  StoredUrlDomainRule,
  UrlDomainRuleStore,
  UrlDomainRuleValue,
} from '../domain/url-domain-rule-store.js';

// SAF-10 (migration 0154). TWO POOLS, deliberately, in one file --
// identical shape and identical justification to apps/api/src/db/
// safety-corpus-store.ts (SAF phase 1, migration 0151): `list` is a
// bounded, statement-timeout-bearing RT-10/RT-11 dashboard read, wired
// to `derivedReadSql`; `create`/`remove` are creator-facing WRITES and
// stay on the main `sql` pool.
export function createSqlUrlDomainRuleStore(sql: Sql, derivedReadSql: Sql): UrlDomainRuleStore {
  async function inUserTransaction<T>(pool: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
    const result = await pool.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${userId}, true)`;
      return callback(tx);
    });
    return result as T;
  }

  function isPgErrorWithMessage(error: unknown, substring: string): boolean {
    return error instanceof Error && error.message.includes(substring);
  }

  type DomainRuleRow = {
    id: string;
    domain: string;
    rule: UrlDomainRuleValue;
    created_at: Date;
  };

  function toStoredUrlDomainRule(row: DomainRuleRow): StoredUrlDomainRule {
    return {
      schemaVersion: 'v1',
      ruleId: row.id,
      domain: row.domain,
      rule: row.rule,
      createdAt: row.created_at.toISOString(),
    };
  }

  return {
    // Wired to `derivedReadSql` -- caught by RT-12's rule 3 (apps/api/
    // src/index.ts constructs this factory with derivedReadSql),
    // manifested in packages/db/explain-plans/required-queries.json.
    async list(userId, channelId): Promise<StoredUrlDomainRule[]> {
      const rows = await inUserTransaction(derivedReadSql, userId, (tx) => tx<DomainRuleRow[]>`
        select id, domain, rule, created_at
          from app_private.get_url_domain_rules(${channelId}::uuid)
      `);
      return rows.map(toStoredUrlDomainRule);
    },

    async create(userId, channelId, input: CreateUrlDomainRuleInput): Promise<CreateUrlDomainRuleResult> {
      let newId: string | undefined;
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_url_domain_rule: string }[]>`
          select app_private.create_url_domain_rule(${channelId}::uuid, ${input.domain}, ${input.rule})
        `);
        newId = rows[0]?.create_url_domain_rule;
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'duplicate key value')) return { outcome: 'duplicate' };
        if (isPgErrorWithMessage(error, 'violates check constraint')) return { outcome: 'invalid' };
        throw error;
      }
      if (!newId) return { outcome: 'invalid' };

      const rows = await inUserTransaction(sql, userId, (tx) => tx<DomainRuleRow[]>`
        select id, domain, rule, created_at
          from app_private.get_url_domain_rules(${channelId}::uuid)
         where id = ${newId}::uuid
      `);
      const row = rows[0];
      return row ? { outcome: 'created', rule: toStoredUrlDomainRule(row) } : { outcome: 'invalid' };
    },

    async remove(userId, channelId, ruleId): Promise<DeleteUrlDomainRuleResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.delete_url_domain_rule(${channelId}::uuid, ${ruleId}::uuid)
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'safety domain rule not found')) return { outcome: 'not_found' };
        throw error;
      }
      return { outcome: 'ok' };
    },
  };
}
