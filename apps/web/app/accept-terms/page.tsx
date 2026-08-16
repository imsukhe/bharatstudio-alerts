'use client';

/*
 * Mandatory terms/privacy acceptance gate. The backend fails closed on
 * every terms-gated mutation until a signed-in user has accepted every
 * currently-active document (apps/api/src/auth/pre-handler.ts's
 * requireAuthAndTerms + migration 0066's fail-closed function) — this page
 * is what makes that reachable from the product instead of surfacing only
 * as an opaque 403 on some later action.
 *
 * Routing:
 *  - No stored session token  -> /login
 *  - Already accepted          -> /dashboard
 *  - Not yet accepted          -> render this page
 */
import { useEffect, useState } from 'react';
import { TopNav } from '../components/TopNav';
import { getAccessToken, getTermsStatus, acceptTermsDocument, clearAccessToken } from '../lib/api';
import { ACTIVE_DOCUMENTS, type TermsDocument } from './terms-content';

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export default function AcceptTermsPage() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [accepting, setAccepting] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { window.location.assign('/login'); return; }
    getTermsStatus()
      .then((status) => {
        if (status.accepted) { window.location.assign('/dashboard'); return; }
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

  const allChecked = ACTIVE_DOCUMENTS.every((doc) => checked[doc.documentKey]);

  async function accept() {
    if (!allChecked || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      for (const doc of ACTIVE_DOCUMENTS) {
        await acceptTermsDocument(doc.documentKey, doc.version, doc.sha256Hex);
      }
      window.location.assign('/dashboard');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Terms could not be accepted. Reload and try again.');
      setAccepting(false);
    }
  }

  return (
    <main className="page-shell">
      <TopNav />
      <section className="dashboard-heading compact-heading">
        <div>
          <p className="eyebrow">Before you continue</p>
          <h1>Read and accept to create your account.</h1>
          <p className="lede">
            BharatStudio Alerts needs your explicit acceptance of the Terms of Service and Privacy
            Notice before your channel can accept payments or alerts.
          </p>
        </div>
      </section>

      {load.status === 'loading' && <p className="helper-text" role="status">Loading your account status…</p>}
      {load.status === 'error' && <p className="inline-message error-text" role="alert">{load.message}</p>}

      {load.status === 'ready' && (
        <div className="setup-layout">
          <div>
            {ACTIVE_DOCUMENTS.map((doc) => (
              <TermsPanel key={doc.documentKey} doc={doc} />
            ))}
          </div>
          <aside className="panel security-panel" aria-label="Accept terms">
            <div className="status"><span className="dot" aria-hidden="true" /> Required before continuing</div>
            <h2>Accept to create your account.</h2>
            <div className="dashboard-form">
              {ACTIVE_DOCUMENTS.map((doc) => (
                <label key={doc.documentKey} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={checked[doc.documentKey] ?? false}
                    onChange={(event) => setChecked((prev) => ({ ...prev, [doc.documentKey]: event.target.checked }))}
                  />
                  I have read and agree to the {doc.heading} ({doc.version})
                </label>
              ))}
            </div>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button type="button" className="primary-button full-width" disabled={!allChecked || accepting} onClick={() => void accept()}>
              {accepting ? 'Accepting…' : 'Accept and continue'}
            </button>
          </aside>
        </div>
      )}
    </main>
  );
}

function TermsPanel({ doc }: { doc: TermsDocument }) {
  return (
    <article className="panel" aria-label={doc.heading}>
      <div className="panel-heading">
        <div>
          <p className="muted-label">{doc.version}</p>
          <h2>{doc.heading}</h2>
        </div>
        <span className="helper-text">Effective {doc.effectiveDate}</span>
      </div>
      {doc.sections.map((section) => (
        <div key={section.title}>
          <h3>{section.title}</h3>
          <p>{section.body}</p>
        </div>
      ))}
    </article>
  );
}
