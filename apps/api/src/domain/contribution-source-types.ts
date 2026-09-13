// L16c (packages/db/migrations/0117): per-target external-contribution
// source inclusion. Include/exclude ONLY — there is no percentage field
// anywhere in this type, on purpose (see the migration's header for why a
// platform-cut multiplier is refused). Missing/unset = included: default
// is aggregate everything.

export type ContributionSourceType = 'payment' | 'youtube_superchat';
export type ContributionTargetType = 'goal' | 'challenge' | 'interaction_definition';

export type ContributionSourceInclusion = {
  sourceType: ContributionSourceType;
  included: boolean;
};

export type ListSourceInclusionsResult =
  | { outcome: 'ok'; sources: ContributionSourceInclusion[] }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export type SetSourceInclusionResult =
  | { outcome: 'ok'; sources: ContributionSourceInclusion[] }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export interface ContributionSourceStore {
  list(
    userId: string,
    channelId: string,
    targetType: ContributionTargetType,
    targetId: string,
  ): Promise<ListSourceInclusionsResult>;

  set(
    userId: string,
    channelId: string,
    targetType: ContributionTargetType,
    targetId: string,
    sourceType: ContributionSourceType,
    included: boolean,
  ): Promise<SetSourceInclusionResult>;
}
