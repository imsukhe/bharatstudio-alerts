export type PublicChannel = {
  channelId: string;
  handle: string;
  displayName: string;
  acceptingTips: boolean;
  minimumTipPaise: number;
  publicConfigVersion: number;
};

export interface PublicChannelRepository {
  findByHandle(handle: string): Promise<PublicChannel | null>;
}
