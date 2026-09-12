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
import { useState } from 'react';
import {
  clearAccessToken, closeAccount, createPrivacyRequestEntry, emailAccountExport, exportAccount, getChannel,
  getPaymentAccounts, getPrivacyRequests, registerPaymentAccount, revokePaymentAccount, updateChannel,
  type ChannelDetails, type CurrentUser, type PaymentAccount, type PaymentAccountEnvironment, type PrivacyRequest, type PrivacyRequestType,
} from '../lib/api';
import { TopNav } from '../components/TopNav';
import { AppShell } from '../components/AppShell';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Field } from '../components/ui/Field';
import { useChannelBootstrap } from '../hooks/useChannelBootstrap';

// Same format enforced server-side (routes/channels.ts POST/PATCH /v1/channels)
// and used at creation time in onboarding/step-1/page.tsx — not a new rule.
const HANDLE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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

  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  const [handleInput, setHandleInput] = useState('');
  const [handleConfirmed, setHandleConfirmed] = useState(false);
  const [savingHandle, setSavingHandle] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);

  // A single click used to immediately disconnect the account tips settle
  // to, with no confirmation at all — inconsistent with "Close account"
  // below, which requires typing CLOSE. This tracks which account (if any)
  // is mid-confirmation, mirroring BillingActionsPanel's downgrade/cancel
  // confirm pattern.
  const [confirmRevokeAccountId, setConfirmRevokeAccountId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  useChannelBootstrap(async (nextUser) => {
    setUser(nextUser);
    const first = nextUser.channels[0];
    if (!first) return;
    setChannelId(first.channelId);
    const [nextChannel, accountList, requestList] = await Promise.all([getChannel(first.channelId), getPaymentAccounts(first.channelId), getPrivacyRequests()]);
    setFeaturedConsent(nextChannel.featuredConsent);
    setChannel(nextChannel);
    setDisplayNameInput(nextChannel.displayName);
    setHandleInput(nextChannel.handle);
    setAccounts(accountList.accounts);
    setRequests(requestList.requests);
  }, setError);

  const canManageChannel = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  async function saveDisplayName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channelId || savingDisplayName) return;
    const nextDisplayName = displayNameInput.trim();
    if (!nextDisplayName) return;
    setSavingDisplayName(true);
    setMessage(null);
    try {
      const updated = await updateChannel(channelId, { displayName: nextDisplayName });
      setChannel(updated);
      setDisplayNameInput(updated.displayName);
      setMessage('Display name updated.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Display name could not be saved');
    } finally {
      setSavingDisplayName(false);
    }
  }

  async function saveHandle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channelId || savingHandle || !channel) return;
    const nextHandle = handleInput.trim();
    if (nextHandle === channel.handle) return;
    setSavingHandle(true);
    setHandleError(null);
    setMessage(null);
    try {
      const updated = await updateChannel(channelId, { handle: nextHandle });
      setChannel(updated);
      setHandleInput(updated.handle);
      setHandleConfirmed(false);
      setMessage(`Handle changed to "${updated.handle}". Your old handle is retired — nobody else can ever claim it, but any link, QR code or overlay still pointing at "bharatstudio.in/tips/${channel.handle}" no longer resolves. Update anywhere you shared it.`);
    } catch (cause) {
      setHandleError(cause instanceof Error ? cause.message : 'Handle could not be changed');
    } finally {
      setSavingHandle(false);
    }
  }

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
    if (!channelId || revoking) return;
    setRevoking(true);
    try {
      await revokePaymentAccount(channelId, account.environment);
      setAccounts((prev) => prev.map((a) => (a.accountId === account.accountId ? { ...a, status: 'revoked' as const } : a)));
      setMessage('Payout account revoked.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Payout account could not be revoked');
    } finally {
      setRevoking(false);
      setConfirmRevokeAccountId(null);
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
        <TopNav variant="minimal" />
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
    <AppShell title="Settings">
      <p className="lede" style={{ margin: '0 0 24px' }}>Register the Razorpay account your tips settle to, and manage your privacy rights.</p>

      {message && <p className="inline-message" role="status">{message}</p>}
      {error && (
        <>
          <p className="inline-message error-text" role="alert">{error}</p>
          <Link className="text-link" href="/login">Return to sign in →</Link>
        </>
      )}
      {!user && !error && <p className="helper-text" role="status">Loading…</p>}

      {user && (
        <div className="content-grid">
          <div>
            {channel && (
              <Card as="article" titleId="channel-title" eyebrow="Channel" title="Name and handle.">
                <form className="dashboard-form" onSubmit={saveDisplayName}>
                  <Field label="Display name">
                    <input
                      required
                      maxLength={120}
                      value={displayNameInput}
                      onChange={(event) => setDisplayNameInput(event.target.value)}
                      disabled={!canManageChannel}
                    />
                  </Field>
                  {canManageChannel && (
                    <Button variant="primary" type="submit" disabled={savingDisplayName || !displayNameInput.trim() || displayNameInput.trim() === channel.displayName}>
                      {savingDisplayName ? 'Saving…' : 'Save display name'}
                    </Button>
                  )}
                </form>

                <form className="dashboard-form" onSubmit={saveHandle} style={{ marginTop: 24 }}>
                  <Field label="Handle">
                    <input
                      required
                      minLength={1}
                      maxLength={64}
                      pattern="[A-Za-z0-9._-]+"
                      value={handleInput}
                      onChange={(event) => { setHandleInput(event.target.value); setHandleConfirmed(false); setHandleError(null); }}
                      disabled={!canManageChannel}
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </Field>
                  <p className="helper-text">
                    Your public tip page: bharatstudio.in/tips/{handleInput.trim() || channel.handle}
                  </p>
                  {canManageChannel && handleInput.trim() !== channel.handle && HANDLE_PATTERN.test(handleInput.trim()) && (
                    <label className="checkbox-label terms-checkbox-row">
                      <input type="checkbox" checked={handleConfirmed} onChange={(event) => setHandleConfirmed(event.target.checked)} />
                      {' '}I understand every link, QR code or overlay already pointing at{' '}
                      bharatstudio.in/tips/{channel.handle} will stop working the moment I save. My old
                      handle is retired permanently — nobody else can ever claim it — but it does not
                      forward visitors to my new one.
                    </label>
                  )}
                  {handleError && <p className="inline-message error-text" role="alert">{handleError}</p>}
                  {canManageChannel && (
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={
                        savingHandle
                        || handleInput.trim() === channel.handle
                        || !HANDLE_PATTERN.test(handleInput.trim())
                        || !handleConfirmed
                      }
                    >
                      {savingHandle ? 'Saving…' : 'Save handle'}
                    </Button>
                  )}
                  {!canManageChannel && <p className="helper-text">Only the channel owner or an admin can change the handle.</p>}
                </form>
              </Card>
            )}

            <Card as="article" titleId="payout-title" eyebrow="Payout account" title="Where your tips settle." helper={<>
                Register the Razorpay connected-account reference issued by Razorpay&apos;s own partner
                onboarding. BharatStudio never holds your funds — orders route directly to this account.
                It stays pending until Razorpay verifies it.
              </>}>
              {accounts.length > 0 && (
                <div className="channel-list">
                  {accounts.map((account) => (
                    <div key={account.accountId}>
                      <div className="channel-row">
                        <div>
                          <strong>{account.connectedAccountRef}</strong>
                          <span>{account.environment} · {account.status}</span>
                        </div>
                        {account.status !== 'revoked' && (
                          <Button
                            type="button"
                            onClick={() => setConfirmRevokeAccountId(account.accountId)}
                            disabled={confirmRevokeAccountId !== null}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                      {confirmRevokeAccountId === account.accountId && (
                        <div className="billing-confirm">
                          <p className="helper-text">
                            Revoke this payout account? Tips will not be able to settle to it until you register a new one.
                          </p>
                          <div className="control-actions">
                            <Button variant="primary" type="button" onClick={() => void revoke(account)} disabled={revoking}>
                              {revoking ? 'Revoking…' : 'Yes, revoke'}
                            </Button>
                            <Button type="button" onClick={() => setConfirmRevokeAccountId(null)} disabled={revoking}>Keep it</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <form className="dashboard-form" onSubmit={submitPayoutAccount}>
                <Field label="Environment">
                  <select value={environment} onChange={(event) => setEnvironment(event.target.value as PaymentAccountEnvironment)}>
                    <option value="test">Test</option>
                    <option value="live">Live</option>
                  </select>
                </Field>
                <Field label="Connected account reference">
                  <input
                    required minLength={1} maxLength={128} pattern="[A-Za-z0-9._:-]+"
                    value={connectedAccountRef}
                    onChange={(event) => setConnectedAccountRef(event.target.value)}
                    placeholder="acc_XXXXXXXXXXXXXX"
                  />
                </Field>
                <Button variant="primary" type="submit" disabled={registering || !channelId}>
                  {registering ? 'Registering…' : 'Register payout account'}
                </Button>
              </form>
            </Card>

            <Card as="article" titleId="featured-title" eyebrow="Public listing" title="Featured creators." actions={
              <Button type="button" onClick={() => void toggleFeatured()} disabled={savingFeatured || !channelId}>
                {savingFeatured ? 'Saving…' : featuredConsent ? 'Remove from listing' : 'Add to listing'}
              </Button>
            }>
              <p className="helper-text">
                Opt in to appear in BharatStudio&apos;s public featured-creators directory. Listing is
                automatic once you&apos;re accepting tips — there is no review step. Currently:{' '}
                <strong>{featuredConsent ? 'listed' : 'not listed'}</strong>.
              </p>
            </Card>

            <Card as="article" titleId="export-title" eyebrow="Your data" title="Download an export." helper="Everything associated with your account, as a JSON file.">
              <div className="control-actions">
                <Button type="button" onClick={() => void downloadExport()} disabled={exporting}>
                  {exporting ? 'Preparing…' : 'Download export'}
                </Button>
                <Button type="button" onClick={() => void requestExportEmail()} disabled={emailingExport}>
                  {emailingExport ? 'Requesting…' : 'Email me a copy'}
                </Button>
              </div>
            </Card>

            <Card as="article" titleId="privacy-title" eyebrow="Privacy requests" title="Access, correction or erasure.">
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
                <Field label="Request type">
                  <select value={requestType} onChange={(event) => setRequestType(event.target.value as PrivacyRequestType)}>
                    {Object.entries(requestTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <Field label="Details">
                  <textarea required maxLength={2000} rows={3} value={requestDetails} onChange={(event) => setRequestDetails(event.target.value)} placeholder="What would you like us to do?" />
                </Field>
                <Button type="submit" disabled={submittingRequest}>
                  {submittingRequest ? 'Submitting…' : 'Submit request'}
                </Button>
              </form>
            </Card>
          </div>

          <aside className="panel security-panel" aria-label="Close account">
            <div className="status"><span className="dot" aria-hidden="true" /> Irreversible from here</div>
            <h2>Pause or close your account.</h2>
            <p className="helper-text">
              Access is revoked immediately. Limited data may remain restricted for payments, taxes,
              fraud prevention, disputes, security or legal obligations — never used commercially.
            </p>
            <form className="dashboard-form" onSubmit={submitClose}>
              <Field label="Reason (optional)">
                <input maxLength={500} value={closeReason} onChange={(event) => setCloseReason(event.target.value)} />
              </Field>
              <Field label="Type CLOSE to confirm">
                <input required value={closeConfirmText} onChange={(event) => setCloseConfirmText(event.target.value)} placeholder="CLOSE" />
              </Field>
              <Button type="submit" disabled={closing || closeConfirmText !== 'CLOSE'}>
                {closing ? 'Closing…' : 'Close account'}
              </Button>
            </form>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
