import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { buildApp } from '../apps/api/src/app.js';
import { createSqlOverlayStore } from '../apps/api/src/db/overlay-store.js';

const databaseUrl = process.env.BSA_OVERLAY_CROSS_REPLICA_SQL_DSN;
if (!databaseUrl) {
  throw new Error('BSA_OVERLAY_CROSS_REPLICA_SQL_DSN is required for the overlay cross-replica integration test');
}

const userId = randomUUID();
const channelId = randomUUID();
const queueId = randomUUID();
const bindingId = randomUUID();
const eventId = randomUUID();
const outboxId = randomUUID();
const deliveryId = randomUUID();
const publisher = postgres(databaseUrl, { max: 1, prepare: false });
const replicaASql = postgres(databaseUrl, { max: 1, prepare: false });
const replicaBSql = postgres(databaseUrl, { max: 1, prepare: false });

const config = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 4100,
  appOrigin: 'http://localhost:3100',
  paymentEnvironment: 'test' as const,
  overlayStreamWindowMs: 30,
  overlayPollMs: 5,
};

async function main(): Promise<void> {
  const overlayStoreA = createSqlOverlayStore(replicaASql, config.appOrigin);
  const overlayStoreB = createSqlOverlayStore(replicaBSql, config.appOrigin);
  await publisher.begin(async (tx) => {
    await tx`
      insert into app_users (id, external_subject, display_name, created_at, updated_at)
      values (${userId}::uuid, ${`overlay-cross-replica:${userId}`}, 'Integration User', current_timestamp, current_timestamp)
    `;
    await tx`
      insert into channels (id, owner_user_id, handle, display_name, created_at, updated_at)
      values (${channelId}::uuid, ${userId}::uuid, ${`overlay_cross_replica_${userId.replaceAll('-', '')}`}, 'Integration Channel', current_timestamp, current_timestamp)
    `;
    await tx`
      insert into channel_memberships (channel_id, user_id, role, created_at)
      values (${channelId}::uuid, ${userId}::uuid, 'owner', current_timestamp)
    `;
    await tx`
      insert into channel_configs (channel_id, version, values, effective_at, created_at)
      values (${channelId}::uuid, 1, '{}'::jsonb, current_timestamp, current_timestamp)
    `;
    await tx`
      insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
      values (${channelId}::uuid, 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
    `;
    await tx`
      insert into alert_queues (id, channel_id, name, created_at, updated_at)
      values (${queueId}::uuid, ${channelId}::uuid, 'Integration queue', current_timestamp, current_timestamp)
    `;
    await tx`
      insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, created_at)
      values (${bindingId}::uuid, ${channelId}::uuid, ${queueId}::uuid, 'manual', 'integration-source', false, 0, current_timestamp)
    `;
  });

  const session = await overlayStoreA.create(userId, channelId);
  const overlayId = session.overlayId;
  const tokenPart = session.streamUrl.split('#token=')[1];
  assert.ok(tokenPart, 'overlay session did not return a token fragment');
  const token = decodeURIComponent(tokenPart);

  await publisher.begin(async (tx) => {
    await tx`
      insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
      values (
        ${eventId}::uuid,
        ${channelId}::uuid,
        null,
        'manual',
        'integration-source',
        'overlay-cross-replica',
        1,
        ${JSON.stringify({ message: 'committed on shared PostgreSQL' })}::jsonb,
        current_timestamp
      )
    `;
    await tx`
      insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
      values (${outboxId}::uuid, ${eventId}::uuid, 'pending', current_timestamp, current_timestamp, current_timestamp)
    `;
    await tx`
      insert into event_outbox_deliveries (
        id, event_id, outbox_id, queue_id, binding_id, source_id,
        config_snapshot_version, delivery_sequence, status, created_at, updated_at
      ) values (
        ${deliveryId}::uuid, ${eventId}::uuid, ${outboxId}::uuid, ${queueId}::uuid, ${bindingId}::uuid,
        'integration-source', 1, 1, 'ready', current_timestamp, current_timestamp
      )
    `;
  });

  const replicaB = await buildApp(config, { overlays: overlayStoreB });
  const replicaA = await buildApp(config, { overlays: overlayStoreA });
  try {
    const received = await replicaB.inject({
      method: 'GET',
      url: `/v1/overlays/${overlayId}/events`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(received.statusCode, 200);
    const dataLine = received.body.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(dataLine, 'replica B did not receive an SSE data event');
    const event = JSON.parse(dataLine.slice('data: '.length)) as { cursor: string; eventId: string };
    assert.equal(event.eventId, eventId);

    const acknowledged = await replicaB.inject({
      method: 'POST',
      url: `/v1/overlays/${overlayId}/cursor`,
      headers: { authorization: `Bearer ${token}` },
      payload: { cursor: event.cursor, eventId: event.eventId },
    });
    assert.equal(acknowledged.statusCode, 204);

    const replayAfterRemoteAcknowledgement = await overlayStoreA.replay(token, overlayId, undefined, 50);
    assert.deepEqual(replayAfterRemoteAcknowledgement, []);

    const replicaAResponse = await replicaA.inject({
      method: 'GET',
      url: `/v1/overlays/${overlayId}/events`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(replicaAResponse.statusCode, 200);
    assert.equal(replicaAResponse.body.includes('committed on shared PostgreSQL'), false);
    console.log('OVERLAY_CROSS_REPLICA_SHARED_POSTGRES_INTEGRATION=PASS');
  } finally {
    await replicaA.close();
    await replicaB.close();
    await publisher`delete from overlay_cursors where overlay_session_id = ${overlayId}::uuid`;
    await publisher`delete from overlay_sessions where id = ${overlayId}::uuid`;
    await publisher`delete from event_outbox_deliveries where id = ${deliveryId}::uuid`;
    await publisher`delete from event_outbox where id = ${outboxId}::uuid`;
    await publisher`delete from alert_events where id = ${eventId}::uuid`;
    await publisher`delete from queue_bindings where queue_id = ${queueId}::uuid`;
    await publisher`delete from alert_queues where id = ${queueId}::uuid`;
    await publisher`delete from channel_entitlement_versions where channel_id = ${channelId}::uuid`;
    await publisher`delete from channel_configs where channel_id = ${channelId}::uuid`;
    await publisher`delete from channel_memberships where channel_id = ${channelId}::uuid`;
    await publisher`delete from channels where id = ${channelId}::uuid`;
    await publisher`delete from app_users where id = ${userId}::uuid`;
    await replicaASql.end({ timeout: 5 });
    await replicaBSql.end({ timeout: 5 });
    await publisher.end({ timeout: 5 });
  }
}

void main();
