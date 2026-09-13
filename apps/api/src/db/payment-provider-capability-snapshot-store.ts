import type { Sql, TransactionSql } from 'postgres';
import type { ConnectionCapabilities, ProviderCapabilitySnapshot, ProviderCapabilitySnapshotStore } from '../domain/payment-provider-creator.js';

// Same session-scoped RLS pattern as payment-account-store.ts:
// set_config('app.user_id', ...) inside the transaction so
// app_private.has_channel_role can resolve the caller.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  }) as T;
}

type SnapshotRow = {
  channel_id: string;
  provider: string;
  environment: 'test' | 'live';
  schema_version: 'v1';
  supports_upi_intent: boolean;
  supports_dynamic_qr: boolean;
  supports_refunds: boolean;
  supports_recurring_payments: boolean;
  supports_cards: boolean;
  supports_international_payments: boolean;
  captured_at: Date;
  updated_at: Date;
};

function fromRow(row: SnapshotRow): ProviderCapabilitySnapshot {
  return {
    schemaVersion: row.schema_version,
    provider: row.provider,
    channelId: row.channel_id,
    environment: row.environment,
    supportsUpiIntent: row.supports_upi_intent,
    supportsDynamicQr: row.supports_dynamic_qr,
    supportsRefunds: row.supports_refunds,
    supportsRecurringPayments: row.supports_recurring_payments,
    supportsCards: row.supports_cards,
    supportsInternationalPayments: row.supports_international_payments,
    capturedAt: row.captured_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createSqlProviderCapabilitySnapshotStore(sql: Sql): ProviderCapabilitySnapshotStore {
  return {
    async upsert(userId, channelId, environment, capabilities: ConnectionCapabilities) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select app_private.upsert_provider_capability_snapshot(
            ${channelId}::uuid, ${capabilities.provider}, ${environment},
            ${capabilities.supportsUpiIntent}, ${capabilities.supportsDynamicQr},
            ${capabilities.supportsRefunds}, ${capabilities.supportsRecurringPayments},
            ${capabilities.supportsCards}, ${capabilities.supportsInternationalPayments}
          ) as id
        `;
        if (!rows[0]) throw new Error('provider capability snapshot upsert returned no row');
        const stored = await tx<SnapshotRow[]>`
          select channel_id, provider, environment, schema_version, supports_upi_intent,
                 supports_dynamic_qr, supports_refunds, supports_recurring_payments,
                 supports_cards, supports_international_payments, captured_at, updated_at
            from app_private.get_provider_capability_snapshot(${channelId}::uuid, ${capabilities.provider}, ${environment})
        `;
        if (!stored[0]) throw new Error('provider capability snapshot upsert did not persist a readable row');
        return fromRow(stored[0]);
      });
    },
    async get(userId, channelId, provider, environment) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<SnapshotRow[]>`
          select channel_id, provider, environment, schema_version, supports_upi_intent,
                 supports_dynamic_qr, supports_refunds, supports_recurring_payments,
                 supports_cards, supports_international_payments, captured_at, updated_at
            from app_private.get_provider_capability_snapshot(${channelId}::uuid, ${provider}, ${environment})
        `;
        return rows[0] ? fromRow(rows[0]) : null;
      });
    },
  };
}
