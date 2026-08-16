'use client';

/*
 * Onboarding step 1 of 3 — mandatory terms/privacy acceptance gate. The
 * backend fails closed on every terms-gated mutation until a signed-in
 * user has accepted every currently-active document
 * (apps/api/src/auth/pre-handler.ts's requireAuthAndTerms + migration
 * 0066's fail-closed function) — this page is what makes that reachable
 * from the product instead of surfacing only as an opaque 403 on some
 * later action.
 *
 * Kept at its own /accept-terms URL rather than moved under
 * /onboarding/step-*  — every place that already redirects an unaccepted
 * account here (LoginClient, AppShell, the onboarding step pages, the
 * terms-status-unreachable fail-closed path) keeps working unchanged. It
 * shares the same OnboardingShell progress chrome as step 2/3, presented
 * as step 1 — see OnboardingShell.tsx's header comment for the full
 * 3-step design.
 *
 * Presentation: compact checkbox rows with a "Read" link that opens the
 * full document in a modal, not both documents' full legal text rendered
 * inline on the page by default — a long wall of text upfront is worse UX
 * than "here's what you're agreeing to, read it if you want to" (the same
 * pattern most consent flows use). The full text is one click away, not
 * hidden, and every section is still there — nothing was cut for length.
 *
 * Routing:
 *  - No stored session token  -> /login
 *  - Already accepted          -> /onboarding (resolves onward: create
 *                                  channel if none yet, else /dashboard)
 *  - Not yet accepted          -> render this page
 */
import { useEffect, useState } from 'react';
import { OnboardingShell } from '../onboarding/OnboardingShell';
import { getAccessToken, getTermsStatus, acceptTermsDocument, clearAccessToken } from '../lib/api';
import { ACTIVE_DOCUMENTS, type TermsDocument } from './terms-content';

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export default function AcceptTermsPage() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [accepting, setAccepting] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<TermsDocument | null>(null);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { window.location.assign('/login'); return; }
    getTermsStatus()
      .then((status) => {
        if (status.accepted) { window.location.assign('/onboarding'); return; }
        setLoad({ status: 'ready' });
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && /authentication required/i.test(cause.message)) {
          clearAccessToken();
          window.location.assign('/login');
          return;
        }
        setLoad({ status: 'error', message: cause instanceof Error ? cause.message : 'Account data is temporarily unavailable' });
      });
  }, []);

  useEffect(() => {
    if (!openDoc) return;
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') setOpenDoc(null); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openDoc]);

  const allChecked = ACTIVE_DOCUMENTS.every((doc) => checked[doc.documentKey]);

  async function accept() {
    if (!allChecked || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      for (const doc of ACTIVE_DOCUMENTS) {
        await acceptTermsDocument(doc.documentKey, doc.version, doc.sha256Hex);
      }
      window.location.assign('/onboarding');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Terms could not be accepted. Reload and try again.');
      setAccepting(false);
    }
  }

  return (
    <OnboardingShell>
      <div className="onboarding-step">
        <p className="eyebrow">Before you continue</p>
        <h1>Read and accept to create your account.</h1>
        <p className="lede">
          BharatStudio needs your explicit acceptance of the Terms of Service and Privacy
          Notice before your channel can accept payments or alerts.
        </p>

        {load.status === 'loading' && <p className="helper-text" role="status">Loading your account status…</p>}
        {load.status === 'error' && <p className="inline-message error-text" role="alert">{load.message}</p>}

        {load.status === 'ready' && (
          <aside className="panel security-panel" aria-label="Accept terms">
            <div className="status"><span className="dot" aria-hidden="true" /> Required before continuing</div>
            <h2>Accept to create your account.</h2>
            <div className="dashboard-form">
              {ACTIVE_DOCUMENTS.map((doc) => (
                <label key={doc.documentKey} className="checkbox-label terms-checkbox-row">
                  <input
                    type="checkbox"
                    checked={checked[doc.documentKey] ?? false}
                    onChange={(event) => setChecked((prev) => ({ ...prev, [doc.documentKey]: event.target.checked }))}
                  />
                  <span>
                    I have read and agree to the{' '}
                    <button type="button" className="text-link terms-read-link" onClick={() => setOpenDoc(doc)}>
                      {doc.heading} ({doc.version})
                    </button>
                  </span>
                </label>
              ))}
            </div>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button type="button" className="primary-button full-width" disabled={!allChecked || accepting} onClick={() => void accept()}>
              {accepting ? 'Accepting…' : 'Accept and continue'}
            </button>
          </aside>
        )}
      </div>

      {openDoc && <TermsModal doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </OnboardingShell>
  );
}

// terms-content.ts documents that some effectiveDate values are still real
// placeholders (e.g. the Privacy Notice's 'Launch preparation') pending
// dated legal review — not a real date, but the UI used to render it as
// though it were one ("Effective Launch preparation"). This doesn't invent
// a real date (that decision belongs to the legal review, not this fix);
// it only stops presenting a placeholder as if it were dated content. A
// real date always contains a digit, so that's what distinguishes the two.
function formatEffectiveDate(value: string): string {
  return /\d/.test(value) ? `Effective ${value}` : `Not yet in effect — ${value}`;
}

function TermsModal({ doc, onClose }: { doc: TermsDocument; onClose: () => void }) {
  return (
    <div className="terms-modal-scrim" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="terms-modal panel" role="dialog" aria-modal="true" aria-label={doc.heading}>
        <div className="panel-heading">
          <div>
            <p className="muted-label">{doc.version}</p>
            <h2>{doc.heading}</h2>
          </div>
          <div className="terms-modal-actions">
            <span className="helper-text">{formatEffectiveDate(doc.effectiveDate)}</span>
            <button type="button" className="secondary-button terms-modal-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <div className="terms-modal-body">
          {doc.sections.map((section) => (
            <div key={section.title}>
              <h3>{section.title}</h3>
              <p>{section.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
