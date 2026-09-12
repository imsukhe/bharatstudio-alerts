'use client';

/*
 * Creator-facing approval page for the desktop Companion device-pairing
 * flow (migration 0082 / apps/api/src/routes/companion-pairing.ts). The
 * desktop app starts a pairing, shows an 8-character user_code on its own
 * screen, and points its printed "go to ... and enter this code" link at
 * `${appOrigin}/companion/pair` (see startDevicePairing's verificationUri)
 * — this file is that destination, which did not exist before this file.
 *
 * Flow: creator enters/deep-links a code -> GET .../pairing/:userCode shows
 * what is asking to pair (client type, device label) -> creator picks a
 * channel (skipped if they only have one, but it's still named) -> an
 * explicit Approve or Deny click calls the matching endpoint. No step
 * before the explicit click can bind a device to a live stream.
 */
import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field } from '../../components/ui/Field';
import { useChannelBootstrap } from '../../hooks/useChannelBootstrap';
import { getChannel, type ChannelRole, type CurrentUser } from '../../lib/api';
import {
  approvePairing, denyPairing, fetchPairingRequest, normalizeUserCode, PairingApiError,
  type PairingRequestView,
} from './pairing-client';

type ChannelOption = { channelId: string; role: ChannelRole; handle: string; displayName: string };

// Same set companion-pairing.ts's approve_companion_pairing SQL function
// gates on (has_channel_role(..., ['owner','admin','operator'])) — shown
// here only to sort/label options, the server is the actual gate.
const CAN_APPROVE_ROLES = new Set<ChannelRole>(['owner', 'admin', 'operator']);

type Phase =
  | { kind: 'entry' }
  | { kind: 'looking-up' }
  | { kind: 'confirm'; pairing: PairingRequestView }
  | { kind: 'already-approved'; pairing: PairingRequestView }
  | { kind: 'unavailable' }
  | { kind: 'denied-by-you' }
  | { kind: 'approved-success' }
  | { kind: 'forbidden-channel' }
  | { kind: 'error'; message: string };

const CLIENT_TYPE_LABEL: Record<PairingRequestView['clientType'], string> = { desktop: 'Desktop Companion app' };

function messageForError(error: PairingApiError): string {
  switch (error.code) {
    case 'unauthenticated': return 'Your session has expired. Sign in again to continue.';
    case 'rate_limited': return 'Too many attempts — please wait a moment and try again.';
    case 'unavailable': return 'Companion pairing is temporarily unavailable. Try again shortly.';
    case 'network': return 'Could not reach the server. Check your connection and try again.';
    case 'forbidden': return 'You are not authorised to do that.';
    default: return 'That did not go through. Reload and try again.';
  }
}

function getPrefilledCode(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('code') ?? '';
}

export default function CompanionPairPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [channelOptions, setChannelOptions] = useState<ChannelOption[] | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const [codeInput, setCodeInput] = useState('');
  const [codeFormatError, setCodeFormatError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'entry' });
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);

  useChannelBootstrap(async (nextUser) => {
    setUser(nextUser);
    const details = await Promise.all(nextUser.channels.map((entry) => getChannel(entry.channelId)));
    setChannelOptions(nextUser.channels.map((entry, index) => ({
      channelId: entry.channelId,
      role: entry.role,
      handle: details[index].handle,
      displayName: details[index].displayName,
    })));
  }, setBootstrapError, 'Account data is unavailable');

  // Prefilled ?code=ABCD2345 deep link: fills the field and runs the same
  // read-only lookup a manual submit would, so the desktop app's link
  // lands straight on the confirmation screen instead of an empty form.
  // This never approves anything by itself — see runLookup below.
  useEffect(() => {
    const prefilled = getPrefilledCode();
    if (!prefilled) return;
    setCodeInput(prefilled);
    const normalized = normalizeUserCode(prefilled);
    if (normalized) void runLookup(normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = channelOptions !== null;
  const gate = authGateStates({ title: 'Approve a device', error: bootstrapError, ready });
  if (gate) return gate;

  async function runLookup(normalizedCode: string) {
    setPhase({ kind: 'looking-up' });
    setSelectedChannelId(null);
    try {
      const pairing = await fetchPairingRequest(normalizedCode);
      if (pairing.state === 'approved') {
        setPhase({ kind: 'already-approved', pairing });
        return;
      }
      // get_companion_pairing_request only ever returns pending/approved
      // rows (anything denied/expired/consumed already 404s below), so
      // this is the only other state reachable here.
      setPhase({ kind: 'confirm', pairing });
      const options = channelOptions ?? [];
      if (options.length === 1) setSelectedChannelId(options[0]!.channelId);
    } catch (cause) {
      if (cause instanceof PairingApiError && cause.code === 'not_found') {
        setPhase({ kind: 'unavailable' });
        return;
      }
      setPhase({ kind: 'error', message: cause instanceof PairingApiError ? messageForError(cause) : 'That did not go through. Reload and try again.' });
    }
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeUserCode(codeInput);
    if (!normalized) {
      setCodeFormatError('Check the 8-character code from the desktop app — the letters I and O and the digits 0 and 1 are never used, so double-check for one of those.');
      return;
    }
    setCodeFormatError(null);
    void runLookup(normalized);
  }

  async function approve(pairing: PairingRequestView) {
    if (!selectedChannelId) return;
    setApproving(true);
    try {
      await approvePairing(pairing.userCode, selectedChannelId);
      setPhase({ kind: 'approved-success' });
    } catch (cause) {
      if (cause instanceof PairingApiError && cause.code === 'forbidden') { setPhase({ kind: 'forbidden-channel' }); return; }
      if (cause instanceof PairingApiError && cause.code === 'not_found') { setPhase({ kind: 'unavailable' }); return; }
      setPhase({ kind: 'error', message: cause instanceof PairingApiError ? messageForError(cause) : 'The device could not be approved. Reload and try again.' });
    } finally {
      setApproving(false);
    }
  }

  async function deny(pairing: PairingRequestView) {
    setDenying(true);
    try {
      await denyPairing(pairing.userCode);
      setPhase({ kind: 'denied-by-you' });
    } catch (cause) {
      if (cause instanceof PairingApiError && cause.code === 'not_found') { setPhase({ kind: 'unavailable' }); return; }
      setPhase({ kind: 'error', message: cause instanceof PairingApiError ? messageForError(cause) : 'The device could not be denied. Reload and try again.' });
    } finally {
      setDenying(false);
    }
  }

  function startOver() {
    setPhase({ kind: 'entry' });
    setCodeInput('');
    setCodeFormatError(null);
    setSelectedChannelId(null);
  }

  const options = channelOptions ?? [];
  const approvableOptions = options.filter((option) => CAN_APPROVE_ROLES.has(option.role));

  return (
    <AppShell title="Approve a device">
      <Card
        eyebrow="Companion pairing"
        title="Approve a device"
        helper="Enter the 8-character code shown on your desktop Companion app to see what it is and choose whether to let it control your stream."
      >
        {phase.kind === 'entry' || phase.kind === 'looking-up' ? (
          <form onSubmit={submitCode}>
            <Field label="Device code">
              <input
                required
                autoFocus
                maxLength={16}
                placeholder="ABCD2345"
                value={codeInput}
                disabled={phase.kind === 'looking-up'}
                onChange={(event) => { setCodeInput(event.target.value); setCodeFormatError(null); }}
              />
            </Field>
            {codeFormatError && <p className="error-text" role="alert">{codeFormatError}</p>}
            <div className="control-actions">
              <Button type="submit" variant="primary" disabled={phase.kind === 'looking-up'}>
                {phase.kind === 'looking-up' ? 'Looking up code…' : 'Continue'}
              </Button>
            </div>
          </form>
        ) : null}

        {phase.kind === 'unavailable' && (
          <>
            <p className="error-text" role="alert">
              That code was not found. It may have expired, already been used, or been denied — ask the desktop app to generate a new one.
            </p>
            <div className="control-actions"><Button type="button" onClick={startOver}>Try another code</Button></div>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p className="error-text" role="alert">{phase.message}</p>
            <div className="control-actions"><Button type="button" onClick={startOver}>Try again</Button></div>
          </>
        )}

        {phase.kind === 'already-approved' && (
          <>
            <p className="helper-text" role="status">
              This device ({phase.pairing.clientLabel}) has already been approved. If that was not you, this device already has a live control session — check the desktop app itself to revoke it.
            </p>
            <div className="control-actions"><Button type="button" onClick={startOver}>Enter another code</Button></div>
          </>
        )}

        {phase.kind === 'denied-by-you' && (
          <>
            <p className="helper-text" role="status">Request denied. That device was not approved and cannot control your stream.</p>
            <div className="control-actions"><Button type="button" onClick={startOver}>Enter another code</Button></div>
          </>
        )}

        {phase.kind === 'approved-success' && (
          <>
            <p className="helper-text" role="status">Device approved. It can now control the channel you selected.</p>
            <div className="control-actions"><Button type="button" onClick={startOver}>Enter another code</Button></div>
          </>
        )}

        {phase.kind === 'forbidden-channel' && (
          <>
            <p className="error-text" role="alert">
              You do not have permission to bind a device to that channel. Choose a channel you own, admin, or operate.
            </p>
            <div className="control-actions"><Button type="button" onClick={startOver}>Start over</Button></div>
          </>
        )}

        {phase.kind === 'confirm' && (
          <div>
            <p className="helper-text">A device wants to control your stream:</p>
            <dl>
              <dt className="muted-label">Type</dt>
              <dd>{CLIENT_TYPE_LABEL[phase.pairing.clientType]}</dd>
              <dt className="muted-label">Device</dt>
              <dd>{phase.pairing.clientLabel}</dd>
            </dl>

            {approvableOptions.length === 0 ? (
              <EmptyState helper>You do not have an owner, admin, or operator role on any channel, so you cannot approve this device.</EmptyState>
            ) : approvableOptions.length === 1 ? (
              <p className="helper-text">This device will be bound to <strong>@{approvableOptions[0]!.handle}</strong>.</p>
            ) : (
              <fieldset>
                <legend className="muted-label">Bind this device to</legend>
                {approvableOptions.map((option) => (
                  <label key={option.channelId} className="checkbox-label">
                    <input
                      type="radio"
                      name="pairing-channel"
                      value={option.channelId}
                      checked={selectedChannelId === option.channelId}
                      onChange={() => setSelectedChannelId(option.channelId)}
                    />
                    @{option.handle} ({option.role})
                  </label>
                ))}
              </fieldset>
            )}

            <div className="control-actions">
              <Button
                type="button"
                variant="primary"
                disabled={approving || denying || !selectedChannelId}
                onClick={() => void approve(phase.pairing)}
              >
                {approving ? 'Approving…' : 'Approve'}
              </Button>
              <Button type="button" disabled={approving || denying} onClick={() => void deny(phase.pairing)}>
                {denying ? 'Denying…' : 'Deny'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
