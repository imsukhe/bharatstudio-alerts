export type ChannelDetails = {
  schemaVersion: 'v1';
  channelId: string;
  handle: string;
  displayName: string;
  acceptingTips: boolean;
  publicConfigVersion: number;
  featuredConsent: boolean;
  role?: string;
};

export type ChannelConfig = {
  schemaVersion: 'v1';
  channelId: string;
  version: number;
  values: Record<string, unknown>;
  effectiveAt: string;
};

export type Queue = {
  schemaVersion: 'v1';
  queueId: string;
  channelId: string;
  name: string;
  paused: boolean;
  active: boolean;
};

export type QueueBinding = {
  schemaVersion: 'v1';
  bindingId: string;
  channelId: string;
  queueId: string;
  sourceType: 'payment' | 'manual' | 'companion';
  sourceId: string;
  allowDuplicates: boolean;
  priority: number;
  overrideValues: Record<string, unknown> | null;
  active: boolean;
};

export type QueueBindingUpdate = {
  allowDuplicates?: boolean;
  priority?: number;
  overrideValues?: Record<string, unknown> | null;
  active?: boolean;
};

export type QueueBindingCreate = Omit<QueueBinding, 'schemaVersion' | 'bindingId' | 'channelId' | 'active'> & { bindingId: string };

export interface ChannelStore {
  createChannel(userId: string, input: { channelId: string; handle: string; displayName: string }): Promise<ChannelDetails>;
  getChannel(userId: string, channelId: string): Promise<ChannelDetails | null>;
  updateChannel(userId: string, channelId: string, input: { displayName?: string; acceptingTips?: boolean; featuredConsent?: boolean }): Promise<ChannelDetails | null>;
  getConfig(userId: string, channelId: string): Promise<ChannelConfig | null>;
  updateConfig(userId: string, channelId: string, values: Record<string, unknown>, expectedVersion: number): Promise<ChannelConfig | null>;
  listQueues(userId: string, channelId: string): Promise<Queue[]>;
  createQueue(userId: string, channelId: string, input: { queueId: string; name: string }): Promise<Queue>;
  updateQueue(userId: string, channelId: string, queueId: string, input: { name?: string; paused?: boolean; active?: boolean }): Promise<Queue | null>;
  listBindings(userId: string, channelId: string): Promise<QueueBinding[]>;
  createBinding(userId: string, channelId: string, input: QueueBindingCreate): Promise<QueueBinding>;
  updateBinding(userId: string, channelId: string, bindingId: string, input: QueueBindingUpdate): Promise<QueueBinding | null>;
}
