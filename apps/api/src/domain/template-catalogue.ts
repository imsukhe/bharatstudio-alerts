// L20: Alert Studio template catalogue. Read-only for creators — there is
// no creator-authored template in this task, only the imported 600-design
// catalogue (contracts/template-catalogue.json) gated live by channel
// tier. See migration 0106 and scripts/template-import/**.

export type TemplateTier = 'free' | 'pro' | 'creator' | 'studio';

export const templateTiers: readonly TemplateTier[] = ['free', 'pro', 'creator', 'studio'];

export type TemplateSummary = {
  id: string;
  externalKey: string;
  displayName: string;
  category: string;
  minTier: TemplateTier;
  byteSize: number;
  updatedAt: string;
};

export interface TemplateCatalogueStore {
  /** Templates available to the given channel at its current tier, for an authorized caller. */
  listForChannel(userId: string, channelId: string): Promise<TemplateSummary[]>;
}
