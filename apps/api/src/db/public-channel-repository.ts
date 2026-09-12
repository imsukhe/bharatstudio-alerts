import postgres, { type Sql } from 'postgres';
import type { FeaturedChannel, PublicChannel, PublicChannelRepository } from '../domain/public-channel.js';

type PublicChannelRow = {
  channel_id: string;
  handle: string;
  display_name: string;
  accepting_tips: boolean;
  minimum_tip_paise: number;
  public_config_version: number;
};

type FeaturedChannelRow = {
  channel_id: string;
  handle: string;
  display_name: string;
  accepting_tips: boolean;
  locale: string;
};

export function createSqlClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    prepare: false,
    onnotice: () => undefined,
    // postgres.js returns bigint/int8 columns as JS strings by default —
    // safe in general (int8 can exceed Number.MAX_SAFE_INTEGER), but every
    // bigint column this schema actually uses (version counters, queue
    // counts, paise amounts) is always well within that range, and every
    // domain type in this codebase declares these fields as `number`. Left
    // unconfigured, JSON responses silently carry `"1"` instead of `1` for
    // every such field — every apps/api unit test uses a mocked store and
    // never touches a real Postgres connection, so this only ever
    // surfaces against a live database, not the fake-store test suite.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
}

export function createPublicChannelRepository(sql: Sql): PublicChannelRepository {
  return {
    async findByHandle(handle) {
      const rows = await sql<PublicChannelRow[]>`
        select channel_id, handle, display_name, accepting_tips, minimum_tip_paise, public_config_version
          from app_private.get_public_channel(${handle})
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        channelId: row.channel_id,
        handle: row.handle,
        displayName: row.display_name,
        acceptingTips: row.accepting_tips,
        minimumTipPaise: row.minimum_tip_paise,
        publicConfigVersion: row.public_config_version,
      };
    },
    async resolveReleasedHandle(handle) {
      // app_private.get_public_channel_for_released_handle does not exist
      // yet — it requires a new security-definer function (over
      // channel_handle_history, which 0087 revokes all app-role access
      // to) added by a companion migration owned by the migration lane,
      // not this one. Until that ships, the call below throws
      // "function ... does not exist" and is caught here, so this fails
      // closed to "no historical match" — today's 404-on-stale-link
      // behavior is unchanged, it does not silently misbehave.
      try {
        const rows = await sql<PublicChannelRow[]>`
          select channel_id, handle, display_name, accepting_tips, minimum_tip_paise, public_config_version
            from app_private.get_public_channel_for_released_handle(${handle})
        `;
        const row = rows[0];
        if (!row) return null;
        return {
          channelId: row.channel_id,
          handle: row.handle,
          displayName: row.display_name,
          acceptingTips: row.accepting_tips,
          minimumTipPaise: row.minimum_tip_paise,
          publicConfigVersion: row.public_config_version,
        };
      } catch {
        return null;
      }
    },
    async listFeatured(limit): Promise<FeaturedChannel[]> {
      const rows = await sql<FeaturedChannelRow[]>`
        select channel_id, handle, display_name, accepting_tips, locale
          from app_private.list_featured_channels(${limit})
      `;
      return rows.map((row) => ({
        handle: row.handle,
        displayName: row.display_name,
        acceptingTips: row.accepting_tips,
        locale: row.locale,
      }));
    },
  };
}
