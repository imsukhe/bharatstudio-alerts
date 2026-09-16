import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { fastifyAjvOptions } from '../src/fastify-ajv-options.js';

/**
 * The ONLY sanctioned way to construct a Fastify instance under
 * `apps/api/test/`. Enforced by `.github/scripts/api-test-harness-check.mjs`
 * (`pnpm harness:check`).
 *
 * It takes its AJV configuration from the same `fastifyAjvOptions()` that
 * `src/app.ts` calls — imported, never copied — so a route test validates
 * request bodies under exactly the rules the running API uses. A bare
 * `Fastify()` does not: Fastify's own AJV default is `removeAdditional: true`,
 * which silently STRIPS an undeclared field that production REJECTS with a
 * 400. See
 * `bharatstudio-requirements/reviews/2026-09-16-api-test-harness-validation-divergence.md`.
 *
 * `ajv` is deliberately not overridable — that is the whole point of the
 * helper. Every other Fastify server option is passed straight through for
 * tests that need one (e.g. a custom `bodyLimit`).
 *
 * Named `createTestFastify` rather than `buildTestApp` on purpose: nineteen
 * test files already define their own local `buildTestApp(...)` wrapper that
 * calls this, and a shared import of the same name would shadow into
 * infinite recursion.
 */
export function createTestFastify(options: Omit<FastifyServerOptions, 'ajv'> = {}): FastifyInstance {
  return Fastify({ ...options, ajv: fastifyAjvOptions() });
}
