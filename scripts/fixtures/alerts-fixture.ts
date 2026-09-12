// Deterministic, idempotent seed/teardown fixtures for E2E tests.
// Synthetic data only — no real payment provider, tokens, or personal data.
// Reuses the app's own DB client convention (postgres.js `Sql`, see
// apps/api/src/db/public-channel-repository.ts) rather than inventing a new one.
import { createHash, randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';

export type QueueMode = 'fifo' | 'stacked' | 'pills' | 'aggregated' | 'priority';
export const ALL_QUEUE_MODES: QueueMode[] = ['fifo', 'stacked', 'pills', 'aggregated', 'priority'];
export type EntitlementTier = 'free' | 'pro' | 'creator' | 'studio';

export interface SeedOptions {
  /** Stable key identifying this test world. Re-running with the same key upserts, never duplicates. */
  worldKey: string;
  handle: string;
  tier: EntitlementTier;
}

export interface SeededWorld {
  worldKey: string;
  userId: string;
  channelId: string;
  handle: string;
  tier: EntitlementTier;
  overlayId: string;
  overlayToken: string;
  paymentId: string;
  paymentAlertEventId: string;
  manualAlertEventId: string;
  companionAlertEventId: string;
  companionCommandId: string;
  queues: Array<{ queueId: string; mode: QueueMode; configVersion: number }>;
}

// Deterministic uuid derived from the world key + a role label, so repeated
// seeds of the same worldKey always target the same rows (idempotent upsert).
function deterministicUuid(worldKey: string, role: string): string {
  const hash = createHash('sha256').update(`bsa-fixture:${worldKey}:${role}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${(['8', '9', 'a', 'b'] as const)[parseInt(hash[16], 16) % 4]}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createFixtureSqlClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 5, prepare: false, onnotice: () => undefined });
}

export async function seedWorld(sql: Sql, opts: SeedOptions): Promise<SeededWorld> {
  const { worldKey, handle, tier } = opts;
  const userId = deterministicUuid(worldKey, 'user');
  const channelId = deterministicUuid(worldKey, 'channel');
  const overlayId = deterministicUuid(worldKey, 'overlay');
  const overlayToken = `synthetic-${randomBytes(16).toString('hex')}`;
  const paymentId = deterministicUuid(worldKey, 'payment');
  const paymentAlertEventId = deterministicUuid(worldKey, 'alert:payment');
  const manualAlertEventId = deterministicUuid(worldKey, 'alert:manual');
  const companionAlertEventId = deterministicUuid(worldKey, 'alert:companion');
  const companionCommandId = deterministicUuid(worldKey, 'companion-command');

  await sql`
    insert into app_users (id, external_subject, display_name, created_at, updated_at)
    values (${userId}::uuid, ${'fixture-' + worldKey}, ${'Fixture ' + worldKey}, current_timestamp, current_timestamp)
    on conflict (id) do update set updated_at = current_timestamp`;

  await sql`
    insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
    values (${channelId}::uuid, ${userId}::uuid, ${handle}, ${'Fixture Channel ' + worldKey}, true, 1, current_timestamp, current_timestamp)
    on conflict (id) do update set handle = excluded.handle, updated_at = current_timestamp`;

  await sql`
    insert into channel_memberships (channel_id, user_id, role, created_at)
    values (${channelId}::uuid, ${userId}::uuid, 'owner', current_timestamp)
    on conflict (channel_id, user_id) do nothing`;

  await sql`
    insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
    values (${channelId}::uuid, 1, ${tier}, 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
    on conflict (channel_id, version) do update set tier = excluded.tier`;

  await sql`
    insert into channel_configs (channel_id, version, values, effective_at, created_at)
    values (${channelId}::uuid, 1, '{}'::jsonb, current_timestamp, current_timestamp)
    on conflict (channel_id, version) do nothing`;

  // 2. Overlay session with a known overlayId/token. Only the token's SHA-256
  // fingerprint is persisted, matching apps/api/src/db/overlay-store.ts.
  await sql`
    insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
    values (${overlayId}::uuid, ${channelId}::uuid, ${tokenFingerprint(overlayToken)}, current_timestamp + interval '7 days', current_timestamp)
    on conflict (id) do update set token_fingerprint = excluded.token_fingerprint, expires_at = excluded.expires_at`;

  // 3. Captured payment -> alert_event(source_type='payment')
  await sql`
    insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
    values (${paymentId}::uuid, ${channelId}::uuid, 'razorpay', ${'fixture_pay_' + worldKey}, ${'fixture_order_' + worldKey}, 5000, 'INR', 'captured', current_timestamp, current_timestamp)
    on conflict (id) do update set status = 'captured', updated_at = current_timestamp`;

  await sql`
    insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
    values (${paymentAlertEventId}::uuid, ${channelId}::uuid, ${paymentId}::uuid, 'payment', ${paymentId}, ${'trace-' + worldKey + '-payment'}, 1, ${sql.json({ synthetic: true, amountPaise: 5000 })}, current_timestamp)
    on conflict (id) do nothing`;

  // 4. Manual alert
  await sql`
    insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
    values (${manualAlertEventId}::uuid, ${channelId}::uuid, null, 'manual', ${'manual-' + worldKey}, ${'trace-' + worldKey + '-manual'}, 1, ${sql.json({ synthetic: true, message: 'fixture manual alert' })}, current_timestamp)
    on conflict (id) do nothing`;

  // 5. Companion action-triggered alert
  await sql`
    insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
    values (${companionCommandId}::uuid, ${channelId}::uuid, ${userId}::uuid, ${'fixture-cmd-' + worldKey}, 'send_test_alert', ${companionAlertEventId}, 'accepted', current_timestamp)
    on conflict (channel_id, idempotency_key) do nothing`;

  await sql`
    insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
    values (${companionAlertEventId}::uuid, ${channelId}::uuid, null, 'companion', ${companionCommandId}, ${'trace-' + worldKey + '-companion'}, 1, ${sql.json({ synthetic: true, action: 'send_test_alert' })}, current_timestamp)
    on conflict (id) do nothing`;

  // 6. One alert_queue + channel_configs snapshot per supported queue mode.
  const queues: SeededWorld['queues'] = [];
  for (const [index, mode] of ALL_QUEUE_MODES.entries()) {
    const configVersion = index + 2; // version 1 is reserved for the base config above
    const queueId = deterministicUuid(worldKey, `queue:${mode}`);
    await sql`
      insert into channel_configs (channel_id, version, values, effective_at, created_at)
      values (${channelId}::uuid, ${configVersion}, ${sql.json({ queue: { mode } })}, current_timestamp, current_timestamp)
      on conflict (channel_id, version) do update set values = excluded.values`;
    await sql`
      insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
      values (${queueId}::uuid, ${channelId}::uuid, ${'fixture-queue-' + mode}, false, current_timestamp, current_timestamp)
      on conflict (id) do update set name = excluded.name`;
    queues.push({ queueId, mode, configVersion });
  }

  return {
    worldKey,
    userId,
    channelId,
    handle,
    tier,
    overlayId,
    overlayToken,
    paymentId,
    paymentAlertEventId,
    manualAlertEventId,
    companionAlertEventId,
    companionCommandId,
    queues,
  };
}

// 7. Teardown removes exactly the rows created for this worldKey (scoped by
// channelId/userId), nothing else. FK-safe delete order: children first.
export async function teardownWorld(sql: Sql, world: Pick<SeededWorld, 'channelId' | 'userId'>): Promise<void> {
  const { channelId, userId } = world;
  await sql`delete from alert_events where channel_id = ${channelId}::uuid`;
  await sql`delete from companion_commands where channel_id = ${channelId}::uuid`;
  // A DB trigger (alert_queue_default_payment_binding) auto-creates a
  // queue_bindings row whenever an alert_queue is inserted; remove it first.
  await sql`delete from queue_bindings where channel_id = ${channelId}::uuid`;
  await sql`delete from alert_queues where channel_id = ${channelId}::uuid`;
  await sql`delete from channel_configs where channel_id = ${channelId}::uuid`;
  await sql`delete from overlay_sessions where channel_id = ${channelId}::uuid`;
  await sql`delete from payments where channel_id = ${channelId}::uuid`;
  await sql`delete from channel_entitlement_versions where channel_id = ${channelId}::uuid`;
  await sql`delete from channel_memberships where channel_id = ${channelId}::uuid`;
  await sql`delete from channels where id = ${channelId}::uuid`;
  await sql`delete from app_users where id = ${userId}::uuid`;
}
