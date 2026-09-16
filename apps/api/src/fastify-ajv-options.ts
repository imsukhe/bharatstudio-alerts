import type { FastifyServerOptions } from 'fastify';

/**
 * The single definition of this API's AJV (request-schema validation)
 * configuration. `app.ts` imports it; `test/create-test-fastify.ts` imports it.
 * There is deliberately no second copy anywhere.
 *
 * Why this module exists at all — see
 * `bharatstudio-requirements/reviews/2026-09-16-api-test-harness-validation-divergence.md`.
 * The value below used to be written inline in `app.ts` only, and twenty-six
 * test files built their app with a bare `Fastify()` instead. Fastify's own
 * AJV default is `removeAdditional: true`, so a body carrying an undeclared
 * field under `additionalProperties: false` was silently STRIPPED in those
 * tests and 400-REJECTED in production. Route tests were therefore passing
 * for a reason that does not exist in the running API.
 *
 * A test helper that merely *copies* these options would be the same defect
 * with a longer fuse: the copy and the original drift the first time one of
 * them changes. Hence one exported definition and two importers, enforced by
 * `.github/scripts/api-test-harness-check.mjs`.
 *
 * WHAT THE OPTION MEANS (unchanged by the extraction — this is the same
 * value `app.ts` has always set): reject, rather than silently strip,
 * unknown creator-controlled fields. Silent removal would make a client
 * believe a configuration was saved when the server actually discarded part
 * of it.
 *
 * Returned fresh per call rather than exported as a shared object literal,
 * so no Fastify instance can mutate the configuration another instance is
 * about to read.
 */
export function fastifyAjvOptions(): NonNullable<FastifyServerOptions['ajv']> {
  return { customOptions: { removeAdditional: false } };
}

/**
 * The single definition of this API's server-wide request body limit.
 *
 * Same story as `fastifyAjvOptions()` above, one option along, and it
 * survived the first fix: `app.ts` set `bodyLimit: 64 * 1024` inline while
 * the test harness took Fastify's own default of 1 MiB. Measured — a 200 KB
 * body is `200 OK` under the default and `413` under this value — so a test
 * could prove a large payload accepted that production rejects outright.
 *
 * Route-level limits are a different thing and stay where they are: a route
 * that legitimately accepts more (the Lottie upload in `routes/branding.ts`)
 * sets its own via a named constant. This is only the server-wide floor that
 * the harness must share.
 */
export const FASTIFY_BODY_LIMIT_BYTES = 64 * 1024;
