'use client';

/*
 * Account deletion request (POST /v1/viewer/deletion-requests ->
 * app_private.request_viewer_account_deletion, migration 0085). This page
 * only surfaces the erased-vs-retained record the backend already returns
 * — it does not assert, and must not be read as asserting, that this
 * mechanism is sufficient under DPDP; that determination stays open (see
 * governance/AGENTS.md and the backend's own legalDispositionOpen flag,
 * which this page shows verbatim rather than resolving).
 */
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { clearViewerAccessToken, requestViewerAccountDeletion, type ViewerDeletionResult } from '../lib/viewer-api';
import { ViewerShell } from '../ViewerShell';

export default function ViewerDeleteAccountPage() {
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ViewerDeletionResult | null>(null);
  const { message, messageKind, notify } = useStatusMessage();

  async function submit() {
    setSubmitting(true);
    try {
      const erasure = await requestViewerAccountDeletion();
      setResult(erasure);
      clearViewerAccessToken();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not process your deletion request', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ViewerShell title="Delete your account.">
      <Card eyebrow="Irreversible" title="Request account deletion" helper="This erases your profile and login — your history stays visible only as an anonymised financial/audit record creators already had. Financial records (payments, refunds) are retained; see the exact list below once submitted.">
        {!result && (
          <>
            <p className="helper-text">Type DELETE to confirm.</p>
            <input type="text" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} aria-label="Type DELETE to confirm" />
            <Button type="button" disabled={submitting || confirmText !== 'DELETE'} onClick={() => void submit()}>
              {submitting ? 'Processing…' : 'Delete my account'}
            </Button>
            <StatusMessage message={message} kind={messageKind} />
          </>
        )}
        {result && (
          <div className="status-list">
            <p className="helper-text">Your account has been closed and you have been signed out everywhere.</p>
            <div>
              <div>
                <strong>Erased</strong>
                <small>{result.erased.join(', ')}</small>
              </div>
            </div>
            <div>
              <div>
                <strong>Retained</strong>
                <small>{result.retained.join(', ')}</small>
              </div>
            </div>
            <p className="helper-text">Whether this fully satisfies applicable data-protection law is still an open question for legal review — not asserted by this page.</p>
          </div>
        )}
      </Card>
    </ViewerShell>
  );
}
