'use client';

/*
 * Account settings: creator payout account registration (task #7) and
 * DPDP/privacy self-service (task #6) — export, privacy requests, account
 * pause/close. Both call real, already-shipped backend routes that
 * previously had zero UI:
 *   - PUT/GET/DELETE /v1/channels/:id/payment-accounts/razorpay
 *   - GET /v1/me/export, GET/POST /v1/me/privacy/requests, POST /v1/me/close
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  clearAccessToken, closeAccount, createPrivacyRequestEntry, emailAccountExport, exportAccount, getChannel, getCurrentUser,
  getPaymentAccounts, getPrivacyRequests, registerPaymentAccount, revokePaymentAccount, updateChannel,
  type CurrentUser, type PaymentAccount, type PaymentAccountEnvironment, type PrivacyRequest, type PrivacyRequestType,
} from '../lib/api';
import { TopNav } from '../components/TopNav';

const requestTypeLabels: Record<PrivacyRequestType, string> = {
  access: 'Access my data',
  correction: 'Correct my data',
  erasure_review: 'Review erasure',
  privacy_concern: 'General privacy concern',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SettingsPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [environment, setEnvironment] = useState<PaymentAccountEnvironment>('test');
  const [connectedAccountRef, setConnectedAccountRef] = useState('');
  const [registering, setRegistering] = useState(false);

  const [requestType, setRequestType] = useState<PrivacyRequestType>('access');
  const [requestDetails, setRequestDetails] = useState('');
  const [submittingRequest, setSubmittingRequest] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [emailingExport, setEmailingExport] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [closeConfirmText, setCloseConfirmText] = useState('');
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<{ retainedData: string } | null>(null);

  const [featuredConsent, setFeaturedConsent] = useState(false);
  const [savingFeatured, setSavingFeatured] = useState(false);

  useEffect(() => {
    getCurrentUser().then(async (nextUser) => {
      setUser(nextUser);
      const first = nextUser.channels[0];
      if (!first) return;
      setChannelId(first.channelId);
      const [channel, accountList, requestList] = await Promise.all([getChannel(first.channelId), getPaymentAccounts(first.channelId), getPrivacyRequests()]);
      setFeaturedConsent(channel.featuredConsent);
      setAccounts(accountList.accounts);
      setRequests(requestList.requests);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
  }, []);

  // Self-serve opt-in — no admin curation. Eligibility (accepting tips, not
  // closed) is applied automatically server-side when building the public
  // listing; this toggle only records consent.
  async function toggleFeatured() {
    if (!channelId || savingFeatured) return;
    setSavingFeatured(true);
    setMessage(null);
    const next = !featuredConsent;
    try {
      const channel = await updateChannel(channelId, { featuredConsent: next });
      setFeaturedConsent(channel.featuredConsent);
      setMessage(channel.featuredConsent ? 'Your channel may now appear in the public featured-creators listing.' : 'Your channel no longer appears in the public featured-creators listing.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Featured-listing preference could not be saved');
    } finally {
      setSavingFeatured(false);
    }
  }

  async function submitPayoutAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channelId || registering) return;
    setRegistering(true);
    setMessage(null);
    try {
      const account = await registerPaymentAccount(channelId, environment, connectedAccountRef.trim());
      setAccounts((prev) => [...prev.filter((a) => a.environment !== account.environment), account]);
      setConnectedAccountRef('');
      setMessage('Payout account registered as pending. It activates after provider verification.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Payout account could not be registered');
    } finally {
      setRegistering(false);
    }
  }

  async function revoke(account: PaymentAccount) {
    if (!channelId) return;
    try {
      await revokePaymentAccount(channelId, account.environment);
      setAccounts((prev) => prev.map((a) => (a.accountId === account.accountId ? { ...a, status: 'revoked' as const } : a)));
      setMessage('Payout account revoked.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Payout account could not be revoked');
    }
  }

  async function submitPrivacyRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRequest) return;
    setSubmittingRequest(true);
    setMessage(null);
    try {
      const { request } = await createPrivacyRequestEntry(requestType, requestDetails.trim());
      setRequests((prev) => [request, ...prev]);
      setRequestDetails('');
      setMessage('Privacy request submitted.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Privacy request could not be submitted');
    } finally {
      setSubmittingRequest(false);
    }
  }

  async function downloadExport() {
    if (exporting) return;
    setExporting(true);
    setMessage(null);
    try {
      const data = await exportAccount();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bharatstudio-account-export.json';
      link.click();
      URL.revokeObjectURL(url);
      setMessage('Export downloaded.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Account export could not be downloaded');
    } finally {
      setExporting(false);
    }
  }

  async function requestExportEmail() {
    if (emailingExport) return;
    setEmailingExport(true);
    setMessage(null);
    try {
      const result = await emailAccountExport();
      setMessage(result.message);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Emailed export could not be requested');
    } finally {
      setEmailingExport(false);
    }
  }

  async function submitClose(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (closing || closeConfirmText !== 'CLOSE') return;
    setClosing(true);
    setError(null);
    try {
      const result = await closeAccount(closeReason.trim() || 'Requested by account owner');
      setClosed({ retainedData: result.retainedData });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Account could not be closed');
    } finally {
      setClosing(false);
    }
  }

  if (closed) {
    return (
      <main className="page-shell">
        <TopNav />
        <section className="panel">
          <h1>Account deactivated.</h1>
          <p className="lede">Access has been revoked immediately.</p>
          <p className="helper-text">{closed.retainedData}</p>
          <button type="button" className="secondary-button" onClick={() => { clearAccessToken(); window.location.assign('/login'); }}>
            Return to sign in
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <TopNav />
      <section className="dashboard-heading compact-heading">
        <div>
          <p className="eyebrow">Account settings</p>
          <h1>Payout account and your data.</h1>
          <p className="lede">Register the Razorpay account your tips settle to, and manage your privacy rights.</p>
        </div>
        <Link className="secondary-button" href="/dashboard">Back to dashboard</Link>
      </section>

      {message && <p className="inline-message" role="status">{message}</p>}
      {error && <p className="inline-message error-text" role="alert">{error}</p>}
      {!user && !error && <p className="helper-text" role="status">Loading…</p>}

      {user && (
        <div className="content-grid">
          <div>
            <article className="panel" aria-labelledby="payout-title">
              <div className="panel-heading">
                <div><p className="muted-label">Payout account</p><h2 id="payout-title">Where your tips settle.</h2></div>
              </div>
              <p className="helper-text">
                Register the Razorpay connected-account reference issued by Razorpay&apos;s own partner
                onboarding. BharatStudio never holds your funds — orders route directly to this account.
                It stays pending until Razorpay verifies it.
              </p>
              {accounts.length > 0 && (
                <div className="channel-list">
                  {accounts.map((account) => (
                    <div className="channel-row" key={account.accountId}>
                      <div>
                        <strong>{account.connectedAccountRef}</strong>
                        <span>{account.environment} · {account.status}</span>
                      </div>
                      {account.status !== 'revoked' && (
                        <button type="button" className="secondary-button" onClick={() => void revoke(account)}>Revoke</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <form className="dashboard-form" onSubmit={submitPayoutAccount}>
                <label>
                  Environment
                  <select value={environment} onChange={(event) => setEnvironment(event.target.value as PaymentAccountEnvironment)}>
                    <option value="test">Test</option>
                    <option value="live">Live</option>
                  </select>
                </label>
                <label>
                  Connected account reference
                  <input
                    required minLength={1} maxLength={128} pattern="[A-Za-z0-9._:-]+"
                    value={connectedAccountRef}
                    onChange={(event) => setConnectedAccountRef(event.target.value)}
                    placeholder="acc_XXXXXXXXXXXXXX"
                  />
                </label>
                <button type="submit" className="primary-button" disabled={registering || !channelId}>
                  {registering ? 'Registering…' : 'Register payout account'}
                </button>
              </form>
            </article>

            <article className="panel" aria-labelledby="featured-title">
              <div className="panel-heading">
                <div><p className="muted-label">Public listing</p><h2 id="featured-title">Featured creators.</h2></div>
                <button type="button" className="secondary-button" onClick={() => void toggleFeatured()} disabled={savingFeatured || !channelId}>
                  {savingFeatured ? 'Saving…' : featuredConsent ? 'Remove from listing' : 'Add to listing'}
                </button>
              </div>
              <p className="helper-text">
                Opt in to appear in BharatStudio&apos;s public featured-creators directory. Listing is
                automatic once you&apos;re accepting tips — there is no review step. Currently:{' '}
                <strong>{featuredConsent ? 'listed' : 'not listed'}</strong>.
              </p>
            </article>

            <article className="panel" aria-labelledby="export-title">
              <div className="panel-heading">
                <div><p className="muted-label">Your data</p><h2 id="export-title">Download an export.</h2></div>
              </div>
              <p className="helper-text">Everything associated with your account, as a JSON file.</p>
              <div className="control-actions">
                <button type="button" className="secondary-button" onClick={() => void downloadExport()} disabled={exporting}>
                  {exporting ? 'Preparing…' : 'Download export'}
                </button>
                <button type="button" className="secondary-button" onClick={() => void requestExportEmail()} disabled={emailingExport}>
                  {emailingExport ? 'Requesting…' : 'Email me a copy'}
                </button>
              </div>
            </article>

            <article className="panel" aria-labelledby="privacy-title">
              <div className="panel-heading">
                <div><p className="muted-label">Privacy requests</p><h2 id="privacy-title">Access, correction or erasure.</h2></div>
              </div>
              {requests.length > 0 && (
                <div className="status-list">
                  {requests.map((request) => (
                    <div key={request.requestId}>
                      <strong>{requestTypeLabels[request.requestType]}</strong>
                      <span>{request.status}</span>
                    </div>
                  ))}
                </div>
              )}
              <form className="dashboard-form" onSubmit={submitPrivacyRequest}>
                <label>
                  Request type
                  <select value={requestType} onChange={(event) => setRequestType(event.target.value as PrivacyRequestType)}>
                    {Object.entries(requestTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  Details
                  <textarea required maxLength={2000} rows={3} value={requestDetails} onChange={(event) => setRequestDetails(event.target.value)} placeholder="What would you like us to do?" />
                </label>
                <button type="submit" className="secondary-button" disabled={submittingRequest}>
                  {submittingRequest ? 'Submitting…' : 'Submit request'}
                </button>
              </form>
            </article>
          </div>

          <aside className="panel security-panel" aria-label="Close account">
            <div className="status"><span className="dot" aria-hidden="true" /> Irreversible from here</div>
            <h2>Pause or close your account.</h2>
            <p className="helper-text">
              Access is revoked immediately. Limited data may remain restricted for payments, taxes,
              fraud prevention, disputes, security or legal obligations — never used commercially.
            </p>
            <form className="dashboard-form" onSubmit={submitClose}>
              <label>
                Reason (optional)
                <input maxLength={500} value={closeReason} onChange={(event) => setCloseReason(event.target.value)} />
              </label>
              <label>
                Type CLOSE to confirm
                <input required value={closeConfirmText} onChange={(event) => setCloseConfirmText(event.target.value)} placeholder="CLOSE" />
              </label>
              <button type="submit" className="secondary-button" disabled={closing || closeConfirmText !== 'CLOSE'}>
                {closing ? 'Closing…' : 'Close account'}
              </button>
            </form>
          </aside>
        </div>
      )}
    </main>
  );
}
