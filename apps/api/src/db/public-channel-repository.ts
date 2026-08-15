import postgres, { type Sql } from 'postgres';
import type { PublicChannel, PublicChannelRepository } from '../domain/public-channel.js';

type PublicChannelRow = {
  channel_id: string;
  handle: string;
  display_name: string;
  accepting_tips: boolean;
  minimum_tip_paise: number;
  public_config_version: number;
};

export function createSqlClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    prepare: false,
    onnotice: () => undefined,
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
  };
}
