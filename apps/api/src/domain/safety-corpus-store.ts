// SAF phase 1 -- corpus management (packages/db/migrations/0151). This
// is the creator-facing surface over `safety_corpus_terms`
// (app_private.get_safety_corpus_terms /
// app_private.create_safety_corpus_term /
// app_private.delete_safety_corpus_term). It is deliberately narrow:
// list, add one term to THIS channel's own corpus, remove one of THIS
// channel's own terms. There is no update -- a term is deleted and
// re-added, never edited in place, which keeps the corpus's own history
// (via safety_corpus_generation's bump-on-any-write trigger) simple.
//
// Global-corpus management (channel_id null) is a data-layer primitive
// only in this phase (app_private.create_safety_corpus_term already
// supports it, staff-gated) -- there is no HTTP route for it, matching
// CTL-04's own admin-UI deferral (migration 0149): a future admin
// surface will call it, this store does not expose it.
//
// This store is NOT the safety pipeline itself. Running text through
// `runSafetyPipeline` (apps/api/src/domain/safety-pipeline.ts) is a
// separate concern from managing which terms are IN the corpus that
// pipeline reads -- this file only ever touches the corpus, never a
// message.

import type { ModeratorReviewDecisionValue, SafetyDecisionValue } from './safety-pipeline.js';

export type SafetyCorpusTermScope = 'global' | 'channel';

export type SafetyCorpusTerm = {
  schemaVersion: 'v1';
  termId: string;
  scope: SafetyCorpusTermScope;
  term: string;
  wholeWord: boolean;
  displayDecision: SafetyDecisionValue;
  ttsDecision: SafetyDecisionValue;
  moderatorReviewDecision: ModeratorReviewDecisionValue;
  createdAt: string;
};

export type CreateSafetyCorpusTermInput = {
  term: string;
  wholeWord?: boolean;
  displayDecision: SafetyDecisionValue;
  ttsDecision: SafetyDecisionValue;
  moderatorReviewDecision: ModeratorReviewDecisionValue;
};

export type CreateSafetyCorpusTermResult =
  | { outcome: 'created'; term: SafetyCorpusTerm }
  | { outcome: 'forbidden' }
  | { outcome: 'duplicate' }
  | { outcome: 'invalid' };

export type DeleteSafetyCorpusTermResult =
  | { outcome: 'ok' }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export interface SafetyCorpusStore {
  /** Global terms plus this channel's own, in one read -- SAF-05's "global plus per-creator" as one call, never two the caller has to remember to make. */
  list(userId: string, channelId: string): Promise<SafetyCorpusTerm[]>;
  create(userId: string, channelId: string, input: CreateSafetyCorpusTermInput): Promise<CreateSafetyCorpusTermResult>;
  /** Channel-owned terms only -- a global term is never removable through this call (app_private.delete_safety_corpus_term's own scoping, migration 0151). */
  remove(userId: string, channelId: string, termId: string): Promise<DeleteSafetyCorpusTermResult>;
}
