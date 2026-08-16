export type ActiveDocument = { documentKey: 'terms_of_service' | 'privacy_notice'; version: string; contentHash: string; publishedAt: string | null };
export type PrivacyRequest = { requestId: string; requestType: 'access' | 'correction' | 'erasure_review' | 'privacy_concern'; details?: string; status: 'open' | 'in_review' | 'completed' | 'rejected'; createdAt: string; updatedAt?: string; resolvedAt?: string | null; resolutionNote?: string | null };

export interface AccountStore {
  listActiveDocuments(): Promise<ActiveDocument[]>;
  acceptDocument(userId: string, documentKey: ActiveDocument['documentKey'], version: string, contentHash: string): Promise<boolean>;
  hasAcceptedActiveDocuments(userId: string): Promise<boolean>;
  createPrivacyRequest(userId: string, requestType: PrivacyRequest['requestType'], details: string): Promise<PrivacyRequest>;
  listPrivacyRequests(userId: string): Promise<PrivacyRequest[]>;
  exportAccount(userId: string): Promise<Record<string, unknown>>;
  closeAccount(userId: string, reason: string): Promise<string>;
}
