// L23: AI assist, bounded (packages/db/migrations/0121). See that
// migration's header for the load-bearing design: deciding a suggestion
// (accept/reject) writes only to assist_suggestions/assist_confirmations —
// never to payments, refunds, or challenges. Applying an accepted
// suggestion to a live surface is a separate, later, human action through
// the product's existing creator flows; nothing here does that apply step.

export type AssistSurface = 'config' | 'challenge_copy' | 'translation' | 'alert_style' | 'moderation';

export const ASSIST_SURFACES: readonly AssistSurface[] = ['config', 'challenge_copy', 'translation', 'alert_style', 'moderation'];

export type AssistStatus = 'pending' | 'accepted' | 'rejected';
export type AssistDecision = 'accepted' | 'rejected';
export type ChannelRole = 'owner' | 'admin' | 'operator' | 'moderator' | 'viewer';

export type AssistSuggestion = {
  schemaVersion: 'v1';
  suggestionId: string;
  channelId: string;
  surface: AssistSurface;
  status: AssistStatus;
  suggestedPayload: Record<string, unknown>;
  basis: string;
  requestedByUserId: string;
  createdAt: string;
  decidedAt: string | null;
};

export type AssistConfirmation = {
  schemaVersion: 'v1';
  confirmationId: string;
  suggestionId: string;
  decision: AssistDecision;
  decidedByUserId: string;
  decidedByRole: ChannelRole;
  appliedPayload: Record<string, unknown> | null;
  decidedAt: string;
};

export type AssistSuggestionAudit = AssistSuggestion & {
  confirmation: AssistConfirmation | null;
};

export type CreateAssistSuggestionInput = {
  surface: AssistSurface;
  suggestedPayload: Record<string, unknown>;
  basis: string;
};

export type CreateAssistSuggestionResult =
  | { outcome: 'created'; suggestion: AssistSuggestion }
  | { outcome: 'forbidden' }
  | { outcome: 'tier_not_entitled' }
  | { outcome: 'invalid' };

export type DecideAssistSuggestionInput = {
  decision: AssistDecision;
  appliedPayload?: Record<string, unknown>;
};

export type DecideAssistSuggestionResult =
  | { outcome: 'decided'; confirmation: AssistConfirmation }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'already_decided' }
  | { outcome: 'invalid' };

export interface AssistStore {
  create(userId: string, channelId: string, input: CreateAssistSuggestionInput): Promise<CreateAssistSuggestionResult>;
  list(userId: string, channelId: string): Promise<AssistSuggestion[]>;
  decide(userId: string, suggestionId: string, input: DecideAssistSuggestionInput): Promise<DecideAssistSuggestionResult>;
  getAudit(userId: string, suggestionId: string): Promise<AssistSuggestionAudit | null>;
}
