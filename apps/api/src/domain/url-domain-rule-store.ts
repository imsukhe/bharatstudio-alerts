// SAF-10 (packages/db/migrations/0154). Creator-facing management of
// this channel's own URL allow/deny domain list -- list, add one
// domain rule, remove one of THIS channel's own rules. No update -- a
// rule is deleted and re-added, never edited in place, the identical
// shape apps/api/src/domain/safety-corpus-store.ts already uses for
// corpus terms and for the identical reason (keeps history simple,
// nothing here needs an in-place edit).
//
// This store is NOT the URL-neutralisation transform itself. Running
// text through `neutralizeUrls` (apps/api/src/domain/url-
// neutralization.ts) is a separate concern from managing which domains
// are ON this channel's list -- this file only ever touches the rule
// list, never a message.

export type UrlDomainRuleValue = 'allow' | 'deny';

export type StoredUrlDomainRule = {
  schemaVersion: 'v1';
  ruleId: string;
  domain: string;
  rule: UrlDomainRuleValue;
  createdAt: string;
};

export type CreateUrlDomainRuleInput = {
  domain: string;
  rule: UrlDomainRuleValue;
};

export type CreateUrlDomainRuleResult =
  | { outcome: 'created'; rule: StoredUrlDomainRule }
  | { outcome: 'forbidden' }
  | { outcome: 'duplicate' }
  | { outcome: 'invalid' };

export type DeleteUrlDomainRuleResult =
  | { outcome: 'ok' }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export interface UrlDomainRuleStore {
  /** This channel's own allow/deny domain rules -- there is no "global" scope for SAF-10 (unlike the SAF-05 corpus): the register names this "per-creator", not "global plus per-creator". */
  list(userId: string, channelId: string): Promise<StoredUrlDomainRule[]>;
  create(userId: string, channelId: string, input: CreateUrlDomainRuleInput): Promise<CreateUrlDomainRuleResult>;
  /** Channel-owned rules only -- app_private.delete_url_domain_rule's own scoping, migration 0154. */
  remove(userId: string, channelId: string, ruleId: string): Promise<DeleteUrlDomainRuleResult>;
}
