import type { JSONValue, Sql, TransactionSql } from 'postgres';
import type { ChannelConfig, ChannelDetails, ChannelStore, Queue, QueueBinding } from '../domain/channel-store.js';
import { hasReachedEntitlementLimit, parsePositiveEntitlementLimit } from '../domain/entitlement-limits.js';
import { validateConfigEntitlement } from '../domain/entitlement-policy.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function channelFromRow(row: { id: string; handle: string; display_name: string; accepting_tips: boolean; public_config_version: number; role?: string }): ChannelDetails {
  return {
    schemaVersion: 'v1',
    channelId: row.id,
    handle: row.handle,
    displayName: row.display_name,
    acceptingTips: row.accepting_tips,
    publicConfigVersion: row.public_config_version,
    ...(row.role ? { role: row.role } : {}),
  };
}

export function createSqlChannelStore(sql: Sql): ChannelStore {
  return {
    async createChannel(userId, input) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ channel_id: string }[]>`
        select channel_id from app_private.create_channel(${input.channelId}::uuid, ${userId}::uuid, ${input.handle}, ${input.displayName})
      `);
      if (!rows[0]) throw new Error('Channel creation returned no row');
      const channel = await this.getChannel(userId, rows[0].channel_id);
      if (!channel) throw new Error('Created channel could not be read');
      return channel;
    },
    async getChannel(userId, channelId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string; handle: string; display_name: string; accepting_tips: boolean; public_config_version: number; role: string }[]>`
          select channel.id, channel.handle, channel.display_name, channel.accepting_tips,
                 channel.public_config_version, membership.role
            from channels channel
            join channel_memberships membership on membership.channel_id = channel.id
           where channel.id = ${channelId}::uuid
             and membership.user_id = ${userId}::uuid
             and membership.revoked_at is null
        `;
        return rows[0] ? channelFromRow(rows[0]) : null;
      });
    },
    async updateChannel(userId, channelId, input) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string; handle: string; display_name: string; accepting_tips: boolean; public_config_version: number; role: string }[]>`
          update channels
             set display_name = coalesce(${input.displayName ?? null}, display_name),
                 accepting_tips = coalesce(${input.acceptingTips ?? null}, accepting_tips),
                 updated_at = current_timestamp
           where id = ${channelId}::uuid
          returning id, handle, display_name, accepting_tips, public_config_version,
            (select role from channel_memberships where channel_id = channels.id and user_id = ${userId}::uuid and revoked_at is null) as role
        `;
        return rows[0] ? channelFromRow(rows[0]) : null;
      });
    },
    async getConfig(userId, channelId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ channel_id: string; version: number; values: Record<string, unknown>; effective_at: Date }[]>`
          select channel_id, version, values, effective_at
            from channel_configs
           where channel_id = ${channelId}::uuid
           order by version desc limit 1
        `;
        const row = rows[0];
        return row ? { schemaVersion: 'v1', channelId: row.channel_id, version: row.version, values: row.values, effectiveAt: row.effective_at.toISOString() } : null;
      });
    },
    async updateConfig(userId, channelId, values, expectedVersion) {
      return inUserTransaction(sql, userId, async (tx) => {
        // Serialize version allocation per channel. Without the row lock,
        // concurrent editors can both observe the same latest version and
        // race into the unique (channel_id, version) key.
        await tx`
          select id
            from channels
           where id = ${channelId}::uuid
           for update
        `;
        const current = await tx<{ version: number }[]>`
          select coalesce(max(version), 0)::int as version from channel_configs where channel_id = ${channelId}::uuid
        `;
        const version = current[0]?.version ?? 0;
        if (version !== expectedVersion) return null;
        const entitlements = await tx<{ values: Record<string, unknown> }[]>`
          select values from channel_entitlement_versions
           where channel_id = ${channelId}::uuid
           order by version desc limit 1
        `;
        const entitlementIssues = validateConfigEntitlement(values, entitlements[0]?.values ?? {});
        if (entitlementIssues.length > 0) throw new Error(`Configuration exceeds entitlement: ${entitlementIssues[0]!.code}`);
        const next = version + 1;
        const rows = await tx<{ channel_id: string; version: number; values: Record<string, unknown>; effective_at: Date }[]>`
          insert into channel_configs (channel_id, version, values, effective_at, created_at)
          values (${channelId}::uuid, ${next}, ${sql.json(values as JSONValue)}, current_timestamp, current_timestamp)
          returning channel_id, version, values, effective_at
        `;
        const row = rows[0];
        return row ? { schemaVersion: 'v1', channelId: row.channel_id, version: row.version, values: row.values, effectiveAt: row.effective_at.toISOString() } : null;
      });
    },
    async listQueues(userId, channelId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string; channel_id: string; name: string; is_paused: boolean; closed_at: Date | null }[]>`
          select id, channel_id, name, is_paused, closed_at from alert_queues
           where channel_id = ${channelId}::uuid order by created_at asc
        `;
        return rows.map((row): Queue => ({ schemaVersion: 'v1', queueId: row.id, channelId: row.channel_id, name: row.name, paused: row.is_paused, active: row.closed_at === null }));
      });
    },
    async createQueue(userId, channelId, input) {
      return inUserTransaction(sql, userId, async (tx) => {
        // Serialize entitlement-count checks per channel. A count-then-insert
        // without a channel-row lock allows concurrent requests to exceed the
        // server-owned queue allocation even though each transaction sees a
        // valid pre-insert count.
        await tx`
          select id
            from channels
           where id = ${channelId}::uuid
           for update
        `;
        // Entitlements are server-owned. A queue limit constrains only the
        // creation of a new destination; it must never affect already
        // accepted payments or durable alert delivery.
        const entitlementRows = await tx<{ queue_count_text: string | null }[]>`
          select values->>'queueCount' as queue_count_text
            from channel_entitlement_versions
           where channel_id = ${channelId}::uuid
           order by version desc
           limit 1
        `;
        const queueCountText = entitlementRows[0]?.queue_count_text;
        const queueLimit = parsePositiveEntitlementLimit(queueCountText, 'queue');
        if (queueLimit !== null) {
          const countRows = await tx<{ queue_count: number }[]>`
            select count(*)::int as queue_count
              from alert_queues
             where channel_id = ${channelId}::uuid
          `;
          if (hasReachedEntitlementLimit(countRows[0]?.queue_count ?? 0, queueLimit)) {
            throw new Error('Queue entitlement limit reached');
          }
        }
        const rows = await tx<{ id: string; channel_id: string; name: string; is_paused: boolean; closed_at: Date | null }[]>`
          insert into alert_queues (id, channel_id, name, created_at, updated_at)
          values (${input.queueId}::uuid, ${channelId}::uuid, ${input.name}, current_timestamp, current_timestamp)
          returning id, channel_id, name, is_paused, closed_at
        `;
        const row = rows[0];
        if (!row) throw new Error('Queue creation returned no row');
        await tx`
          insert into queue_bindings (
            id, channel_id, queue_id, source_type, source_id,
            allow_duplicates, priority, created_at
          )
          values (
            md5(${`default-payment-binding:${input.queueId}`} )::uuid,
            ${channelId}::uuid,
            ${input.queueId}::uuid,
            'payment',
            '__channel_default__',
            false,
            0,
            current_timestamp
          )
          on conflict (queue_id, source_type, source_id) do nothing
        `;
        return { schemaVersion: 'v1', queueId: row.id, channelId: row.channel_id, name: row.name, paused: row.is_paused, active: row.closed_at === null };
      });
    },
    async updateQueue(userId, channelId, queueId, input) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string; channel_id: string; name: string; is_paused: boolean; closed_at: Date | null }[]>`
          update alert_queues
             set name = coalesce(${input.name ?? null}, name),
                 is_paused = coalesce(${input.paused ?? null}, is_paused),
                 closed_at = case when ${input.active === false} then current_timestamp when ${input.active === true} then null else closed_at end,
                 updated_at = current_timestamp
           where id = ${queueId}::uuid and channel_id = ${channelId}::uuid
          returning id, channel_id, name, is_paused, closed_at
        `;
        const row = rows[0];
        return row ? { schemaVersion: 'v1', queueId: row.id, channelId: row.channel_id, name: row.name, paused: row.is_paused, active: row.closed_at === null } : null;
      });
    },
    async listBindings(userId, channelId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string; channel_id: string; queue_id: string; source_type: QueueBinding['sourceType']; source_id: string; allow_duplicates: boolean; priority: number; override_values: Record<string, unknown> | null; closed_at: Date | null }[]>`
          select id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, closed_at
            from queue_bindings where channel_id = ${channelId}::uuid order by (closed_at is null) desc, priority desc, created_at asc
        `;
        return rows.map((row): QueueBinding => ({ schemaVersion: 'v1', bindingId: row.id, channelId: row.channel_id, queueId: row.queue_id, sourceType: row.source_type, sourceId: row.source_id, allowDuplicates: row.allow_duplicates, priority: row.priority, overrideValues: row.override_values, active: row.closed_at === null }));
      });
    },
    async createBinding(userId, channelId, input) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string; channel_id: string; queue_id: string; source_type: QueueBinding['sourceType']; source_id: string; allow_duplicates: boolean; priority: number; override_values: Record<string, unknown> | null; closed_at: Date | null }[]>`
          insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
          values (${input.bindingId}::uuid, ${channelId}::uuid, ${input.queueId}::uuid, ${input.sourceType}, ${input.sourceId}, ${input.allowDuplicates}, ${input.priority}, ${input.overrideValues ? sql.json(input.overrideValues as JSONValue) : null}, current_timestamp)
          returning id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, closed_at
        `;
        const row = rows[0];
        if (!row) throw new Error('Binding creation returned no row');
        return { schemaVersion: 'v1', bindingId: row.id, channelId: row.channel_id, queueId: row.queue_id, sourceType: row.source_type, sourceId: row.source_id, allowDuplicates: row.allow_duplicates, priority: row.priority, overrideValues: row.override_values, active: row.closed_at === null };
      });
    },
    async updateBinding(userId, channelId, bindingId, input) {
      return inUserTransaction(sql, userId, async (tx) => {
        const existing = await tx<{ source_type: QueueBinding['sourceType']; source_id: string }[]>`
          select source_type, source_id
            from queue_bindings
           where id = ${bindingId}::uuid and channel_id = ${channelId}::uuid
           for update
        `;
        const binding = existing[0];
        if (!binding) return null;
        if (input.active === false && binding.source_type === 'payment' && binding.source_id === '__channel_default__') {
          throw new Error('Default payment binding cannot be closed');
        }

        const hasOverrideValues = Object.prototype.hasOwnProperty.call(input, 'overrideValues');
        const overrideValues = input.overrideValues === null || input.overrideValues === undefined
          ? null
          : sql.json(input.overrideValues as JSONValue);
        const rows = hasOverrideValues
          ? await tx<{ id: string; channel_id: string; queue_id: string; source_type: QueueBinding['sourceType']; source_id: string; allow_duplicates: boolean; priority: number; override_values: Record<string, unknown> | null; closed_at: Date | null }[]>`
              update queue_bindings
                 set allow_duplicates = coalesce(${input.allowDuplicates ?? null}, allow_duplicates),
                     priority = coalesce(${input.priority ?? null}, priority),
                     override_values = ${overrideValues},
                     closed_at = case when ${input.active === false} then current_timestamp when ${input.active === true} then null else closed_at end
               where id = ${bindingId}::uuid and channel_id = ${channelId}::uuid
               returning id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, closed_at
            `
          : await tx<{ id: string; channel_id: string; queue_id: string; source_type: QueueBinding['sourceType']; source_id: string; allow_duplicates: boolean; priority: number; override_values: Record<string, unknown> | null; closed_at: Date | null }[]>`
              update queue_bindings
                 set allow_duplicates = coalesce(${input.allowDuplicates ?? null}, allow_duplicates),
                     priority = coalesce(${input.priority ?? null}, priority),
                     closed_at = case when ${input.active === false} then current_timestamp when ${input.active === true} then null else closed_at end
               where id = ${bindingId}::uuid and channel_id = ${channelId}::uuid
               returning id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, closed_at
            `;
        const row = rows[0];
        return row ? { schemaVersion: 'v1', bindingId: row.id, channelId: row.channel_id, queueId: row.queue_id, sourceType: row.source_type, sourceId: row.source_id, allowDuplicates: row.allow_duplicates, priority: row.priority, overrideValues: row.override_values, active: row.closed_at === null } : null;
      });
    },
  };
}
