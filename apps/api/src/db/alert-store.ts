import { randomUUID } from 'node:crypto';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import type { AlertAccepted, AlertStore, BillingView, CompanionAction, CompanionActionResult, CompanionControlSession, CompanionLayout, CompanionState, EntitlementView, HistoryItem } from '../domain/alert-store.js';
import { formatHistoryCursor, parseHistoryCursor } from './history-cursor.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlAlertStore(sql: Sql): AlertStore {
  return {
    async createTestAlert(userId, channelId, displayName, message, queueIds) {
      return inUserTransaction(sql, userId, async (tx) => {
        const config = await tx<{ version: number }[]>`
          select coalesce(max(version), 1)::int as version from channel_configs where channel_id = ${channelId}::uuid
        `;
        const selectedQueues = queueIds?.length
          ? queueIds
          : (await tx<{ id: string }[]>`
              select id from alert_queues
               where channel_id = ${channelId}::uuid and closed_at is null
               order by created_at asc, id asc
            `).map((row) => row.id);
        if (selectedQueues.length === 0) throw new Error('No active alert queue is configured');
        const traceId = `test_${randomUUID().replaceAll('-', '')}`;
        const rows = await tx<{ event_id: string; trace_id: string }[]>`
          select event_id, trace_id from app_private.create_manual_alert(
            ${randomUUID()}::uuid,
            ${randomUUID()}::uuid,
            ${channelId}::uuid,
            ${userId}::uuid,
            ${traceId},
            ${config[0]?.version ?? 1},
            ${sql.json({ displayName, message, queueIds: selectedQueues } as JSONValue)}
          )
        `;
        const row = rows[0];
        if (!row) throw new Error('Test alert was not accepted');
        const result: AlertAccepted = { schemaVersion: 'v1', eventId: row.event_id, traceId: row.trace_id, status: 'accepted' };
        return result;
      });
    },
    async listHistory(userId, channelId, cursor, pageSize) {
      const parsedCursor = parseHistoryCursor(cursor);
      if (cursor !== undefined && !parsedCursor) throw new Error('invalid history cursor');
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        event_id: string; source_type: HistoryItem['sourceType']; status: string; created_at: Date;
        gross_amount_paise: number | null; currency: 'INR' | null; display_name: string | null; message: string | null;
      }[]>`
        select event_id, source_type, status, created_at, gross_amount_paise, currency, display_name, message
          from app_private.get_alert_history(${channelId}::uuid, ${parsedCursor?.createdAt ?? null}::timestamptz, ${parsedCursor?.eventId ?? null}::uuid, ${pageSize})
      `);
      const items = rows.map((row): HistoryItem => ({ eventId: row.event_id, sourceType: row.source_type, status: row.status, createdAt: row.created_at.toISOString(), grossAmountPaise: row.gross_amount_paise, currency: row.currency, displayName: row.display_name, message: row.message }));
      const last = rows.at(-1);
      return { items, nextCursor: last ? formatHistoryCursor(last.created_at, last.event_id) : null };
    },
    async moderate(userId, channelId, eventId, action, reason) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ event_id: string; action: string; applied_at: Date }[]>`
          select event_id, action, applied_at
            from app_private.apply_moderation_action(
              ${eventId}::uuid, ${channelId}::uuid, ${userId}::uuid, ${action}, ${reason}
            )
        `;
        const row = rows[0];
        return row ? { eventId: row.event_id, action: row.action, appliedAt: row.applied_at.toISOString() } : null;
      });
    },
    async getBilling(userId, channelId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        channel_id: string;
        tier: BillingView['tier'];
        monthly_price_paise: number;
        annual_months_charged: 10;
        annual_service_months: 12;
        renewal_state: BillingView['renewalState'];
        next_renewal_at: Date | null;
        billing_interval: BillingView['billingInterval'];
        auto_renew: boolean;
        current_period_ends_at: Date | null;
        price_protected_until: Date | null;
        price_source: BillingView['priceSource'];
      }[]>`
        select channel_id, tier, monthly_price_paise, annual_months_charged,
               annual_service_months, renewal_state, next_renewal_at,
               billing_interval, auto_renew, current_period_ends_at,
               price_protected_until, price_source
          from app_private.get_billing_view(${channelId}::uuid)
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        schemaVersion: 'v1',
        channelId: row.channel_id,
        tier: row.tier,
        monthlyPricePaise: row.monthly_price_paise,
        annualMonthsCharged: row.annual_months_charged,
        annualServiceMonths: row.annual_service_months,
        renewalState: row.renewal_state,
        nextRenewalAt: row.next_renewal_at?.toISOString() ?? null,
        billingInterval: row.billing_interval,
        autoRenew: row.auto_renew,
        currentPeriodEndsAt: row.current_period_ends_at?.toISOString() ?? null,
        priceProtectedUntil: row.price_protected_until?.toISOString() ?? null,
        priceSource: row.price_source,
      };
    },
    async getEntitlements(userId, channelId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ version: number; tier: EntitlementView['tier']; source: EntitlementView['source']; values: Record<string, unknown> }[]>`
        select version, tier, source, values
          from channel_entitlement_versions
         where channel_id = ${channelId}::uuid
         order by version desc
         limit 1
      `);
      const row = rows[0];
      return row ? { schemaVersion: 'v1', channelId, tier: row.tier, source: row.source, entitlementVersion: row.version, values: row.values } : null;
    },
    async getCompanionState(userId, channelId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ overlay_connected: boolean; pending_alerts: number; last_updated_at: Date }[]>`
        select overlay_connected, pending_alerts, last_updated_at from app_private.get_companion_state(${channelId}::uuid)
      `);
      const row = rows[0];
      return row ? { schemaVersion: 'v1', channelId, overlayConnected: row.overlay_connected, pendingAlerts: row.pending_alerts, lastUpdatedAt: row.last_updated_at.toISOString() } : null;
    },
    async getCompanionLayout(userId, channelId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        channel_id: string; version: number; tier: CompanionLayout['tier']; max_slots: number;
        page_size: 4 | 8 | 16; slots: CompanionLayout['slots']; created_at: Date | null;
      }[]>`
        select channel_id, version, tier, max_slots, page_size, slots, created_at
          from app_private.get_companion_layout(${channelId}::uuid)
      `);
      const row = rows[0];
      return row ? {
        schemaVersion: 'v1', channelId: row.channel_id, version: row.version, tier: row.tier,
        maxSlots: row.max_slots, pageSize: row.page_size, slots: row.slots,
        createdAt: row.created_at?.toISOString() ?? null,
      } : null;
    },
    async updateCompanionLayout(userId, channelId, expectedVersion, pageSize, slots) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        channel_id: string; version: number; tier: CompanionLayout['tier']; max_slots: number;
        page_size: 4 | 8 | 16; slots: CompanionLayout['slots']; created_at: Date | null;
      }[]>`
        select channel_id, version, tier, max_slots, page_size, slots, created_at
          from app_private.update_companion_layout(
            ${channelId}::uuid,
            ${userId}::uuid,
            ${expectedVersion},
            ${pageSize},
            ${sql.json(slots as unknown as JSONValue)}
          )
      `);
      const row = rows[0];
      return row ? {
        schemaVersion: 'v1', channelId: row.channel_id, version: row.version, tier: row.tier,
        maxSlots: row.max_slots, pageSize: row.page_size, slots: row.slots,
        createdAt: row.created_at?.toISOString() ?? null,
      } : null;
    },
    async acquireCompanionControlSession(userId, channelId, clientType, clientInstanceId) {
      const leaseUntil = new Date(Date.now() + 5 * 60 * 1000);
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{
          session_id: string; channel_id: string; client_type: CompanionControlSession['clientType'];
          client_instance_id: string; lease_until: Date; created_at: Date; reused: boolean;
        }[]>`
          select session_id, channel_id, client_type, client_instance_id,
                 lease_until, created_at, reused
            from app_private.acquire_companion_control_session(
              ${randomUUID()}::uuid,
              ${channelId}::uuid,
              ${userId}::uuid,
              ${clientType},
              ${clientInstanceId},
              ${leaseUntil}::timestamptz
            )
        `;
        const row = rows[0];
        if (!row) throw new Error('Companion control session was not accepted');
        return {
          schemaVersion: 'v1', sessionId: row.session_id, channelId: row.channel_id,
          clientType: row.client_type, clientInstanceId: row.client_instance_id,
          leaseUntil: row.lease_until.toISOString(), createdAt: row.created_at.toISOString(),
          reused: row.reused,
        };
      });
    },
    async revokeCompanionControlSession(userId, channelId, sessionId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ revoked: boolean }[]>`
          select app_private.revoke_companion_control_session(
            ${sessionId}::uuid, ${channelId}::uuid, ${userId}::uuid, ${'channel:' + channelId}
          ) as revoked
        `;
        return rows[0]?.revoked ?? false;
      });
    },
    async executeCompanionAction(userId, channelId, action, targetId, idempotencyKey) {
      if (!targetId) throw new Error('Companion action requires a queue target');
      return inUserTransaction(sql, userId, async (tx) => {
        const commandId = randomUUID();
        const resultEventId = action === 'send_test_alert' ? randomUUID() : null;
        const resultOutboxId = action === 'send_test_alert' ? randomUUID() : null;
        const rows = await tx<{ id: string; status: CompanionActionResult['status']; created_at: Date; action: CompanionAction; target_id: string | null; result_event_id: string | null }[]>`
          insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, result_event_id, status, created_at)
          values (${commandId}::uuid, ${channelId}::uuid, ${userId}::uuid, ${idempotencyKey}, ${action}, ${targetId}, ${resultEventId}::uuid, 'accepted', current_timestamp)
          on conflict (channel_id, idempotency_key) do nothing
          returning id, status, created_at, action, target_id, result_event_id
        `;
        const inserted = rows[0];
        const row = inserted ?? (await tx<{ id: string; status: CompanionActionResult['status']; created_at: Date; action: CompanionAction; target_id: string | null; result_event_id: string | null }[]>`
          select id, status, created_at, action, target_id, result_event_id
            from companion_commands
           where channel_id = ${channelId}::uuid and idempotency_key = ${idempotencyKey}
           limit 1
        `)[0];
        if (!row) throw new Error('Companion command was not accepted');
        // An idempotency retry is a read of the original command, not a new
        // authorization to execute the caller's current action/target.
        if (!inserted) {
          return { schemaVersion: 'v1', commandId: row.id, status: row.status, acceptedAt: row.created_at.toISOString(), ...(row.result_event_id ? { eventId: row.result_event_id } : {}) };
        }
        if ((row.action === 'pause_queue' || row.action === 'resume_queue') && row.target_id) {
          const updatedQueues = await tx<{ id: string }[]>`
            update alert_queues
               set is_paused = ${row.action === 'pause_queue'}, updated_at = current_timestamp
             where id = ${row.target_id}::uuid and channel_id = ${channelId}::uuid
             returning id
          `;
          if (updatedQueues.length !== 1) throw new Error('Companion queue target was not found in channel');
        }
        if (row.action === 'send_test_alert') {
          if (!row.target_id || !row.result_event_id || !resultOutboxId) throw new Error('Companion test-alert target was not accepted');
          const config = await tx<{ version: number }[]>`
            select coalesce(max(version), 1)::int as version
              from channel_configs
             where channel_id = ${channelId}::uuid
          `;
          await tx`
            select * from app_private.create_manual_alert(
              ${row.result_event_id}::uuid,
              ${resultOutboxId}::uuid,
              ${channelId}::uuid,
              ${userId}::uuid,
              ${`companion:${row.id}`},
              ${config[0]?.version ?? 1},
              ${sql.json({ displayName: 'BharatStudio Companion', message: 'Companion test alert', queueIds: [row.target_id] } as JSONValue)}
            )
          `;
        }
        return { schemaVersion: 'v1', commandId: row.id, status: row.status, acceptedAt: row.created_at.toISOString(), ...(row.result_event_id ? { eventId: row.result_event_id } : {}) };
      });
    },
  };
}
