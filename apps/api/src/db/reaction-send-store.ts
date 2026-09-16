import type { Sql } from 'postgres';
import type {
  ReactionEntrySource,
  ReactionSendOutcome,
  ReactionSendStore,
} from '../domain/reaction-cloud-store.js';

// PRF-02 slice 6 / PRF-06 -- the reaction SEND path.
//
// A WRITE, NOT A DERIVED READ, AND THE FILENAME SAYS SO. This file is
// deliberately NOT named `*-overlay-store.ts`: RT-12's
// scan-required-queries.mjs rule 2 keys on that substring and would then
// demand an EXPLAIN artefact for an insert under a row lock, which is not
// what RT-12's manifest is for. It is also constructed with the MAIN `sql`
// handle in index.ts, never `derivedReadSql` -- RT-10/RT-11's bounded
// derived-read pool exists for widget/dashboard/analytics READS, and
// routing a write through it would misuse the pool and its statement
// timeout. Both facts are deliberate; neither is an oversight.
//
// EVERY DECISION THIS PATH MAKES IS MADE IN SQL, NOT HERE. Entry
// existence, channel ownership, tier eligibility, the creator's live
// enabled/disabled set, staff-review state, and the rate limit are all
// re-checked inside app_private.record_channel_reaction (migration 0139)
// against the SAME rules migrations 0110 and 0119 already apply on the
// public tip-page reads. This file translates an outcome string and
// nothing else -- there is no eligibility logic here to drift out of step
// with the database's.
//
// THE OUTCOME IS A RETURN VALUE, NOT AN EXCEPTION, FOR 'rate_limited'.
// Reaching the creator's per-minute limit is an ordinary, expected answer
// on a high-frequency path, not an error condition -- so it comes back as
// a value and the route maps it to 429. An unrecognised entry SOURCE does
// still raise inside the function, because that is a programming error
// rather than a viewer's action.
const KNOWN_OUTCOMES = new Set<ReactionSendOutcome>(['recorded', 'rate_limited', 'unknown_entry', 'not_available']);

export function createSqlReactionSendStore(sql: Sql): ReactionSendStore {
  return {
    async record(channelId: string, entrySource: ReactionEntrySource, entryId: string): Promise<ReactionSendOutcome> {
      const rows = await sql<{ outcome: string }[]>`
        select app_private.record_channel_reaction(${channelId}::uuid, ${entrySource}, ${entryId}::uuid) as outcome
      `;
      const outcome = rows[0]?.outcome;
      // An unrecognised answer is treated as a refusal, never as a
      // success. Failing closed is the only safe reading of a value this
      // code does not understand.
      return outcome && KNOWN_OUTCOMES.has(outcome as ReactionSendOutcome)
        ? outcome as ReactionSendOutcome
        : 'unknown_entry';
    },
  };
}
