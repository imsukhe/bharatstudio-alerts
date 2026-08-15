import type { NotificationDevice, NotificationPreferences } from '../domain/notification-store.js';

/**
 * The companion push channel is deliberately operational-only.  It is not a
 * second alert/payment channel and must never carry donor, tip, message,
 * amount, payout, or stream-content data.
 */
export type OperationalNotificationKind =
  | 'connection_lost'
  | 'connection_recovered'
  | 'session_revoked'
  | 'action_failed';

export type OperationalNotificationEvent = {
  notificationId: string;
  kind: OperationalNotificationKind;
  occurredAt: string;
};

export type OperationalNotificationEnvelope = {
  schemaVersion: 'v1';
  notificationId: string;
  kind: OperationalNotificationKind;
  occurredAt: string;
};

export type NotificationSendResult = 'sent' | 'retryable' | 'disabled';

export type NotificationSender = {
  send(target: NotificationDevice, envelope: OperationalNotificationEnvelope): Promise<NotificationSendResult>;
};

export type NotificationDispatchResult = {
  attempted: number;
  sent: number;
  retryable: number;
  disabled: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Return the user preference that gates a notification kind. */
export function isNotificationEnabled(preferences: NotificationPreferences, kind: OperationalNotificationKind): boolean {
  switch (kind) {
    case 'connection_lost':
    case 'connection_recovered':
      return preferences.connectionAlerts;
    case 'session_revoked':
      return preferences.securityAlerts;
    case 'action_failed':
      return preferences.actionFailures;
  }
}

/**
 * Validate and construct the only payload permitted on the push channel.
 * Unknown fields cannot enter through this boundary because callers provide
 * an explicit event shape and the returned envelope has no extension bag.
 */
export function buildOperationalNotificationEnvelope(event: OperationalNotificationEvent): OperationalNotificationEnvelope {
  if (!uuidPattern.test(event.notificationId)) throw new Error('notificationId must be a UUID');
  if (!isValidDate(event.occurredAt)) throw new Error('occurredAt must be an ISO date');
  return {
    schemaVersion: 'v1',
    notificationId: event.notificationId,
    kind: event.kind,
    occurredAt: new Date(event.occurredAt).toISOString(),
  };
}

/**
 * Filter server-visible device metadata before a provider adapter is called.
 * Tokens are intentionally absent from NotificationDevice and remain inside
 * the provider-facing secret boundary; disabled devices never receive work.
 */
export function selectNotificationDevices(
  preferences: NotificationPreferences,
  devices: readonly NotificationDevice[],
  kind: OperationalNotificationKind,
): NotificationDevice[] {
  if (!isNotificationEnabled(preferences, kind)) return [];
  return devices.filter((device) => device.enabled).map((device) => ({ ...device }));
}

/**
 * Provider-neutral dispatch orchestration. The sender receives safe device
 * metadata only; token lookup/decryption belongs to the provider adapter or a
 * narrower server-side secret boundary. Sequential delivery keeps failures
 * isolated and makes provider rate limits explicit until a bounded batch
 * implementation is approved.
 */
export async function dispatchOperationalNotification(
  preferences: NotificationPreferences,
  devices: readonly NotificationDevice[],
  event: OperationalNotificationEvent,
  sender: NotificationSender,
): Promise<NotificationDispatchResult> {
  const envelope = buildOperationalNotificationEnvelope(event);
  const targets = selectNotificationDevices(preferences, devices, event.kind);
  const result: NotificationDispatchResult = { attempted: targets.length, sent: 0, retryable: 0, disabled: 0 };

  for (const target of targets) {
    try {
      const outcome = await sender.send(target, envelope);
      result[outcome] += 1;
    } catch {
      // Provider/network errors are retryable by default. The caller owns
      // durable retry scheduling; this function never drops an event silently.
      result.retryable += 1;
    }
  }

  return result;
}
