export type NotificationPreferences = {
  schemaVersion: 'v1';
  connectionAlerts: boolean;
  securityAlerts: boolean;
  actionFailures: boolean;
};

export type NotificationDevice = {
  schemaVersion: 'v1';
  deviceId: string;
  platform: 'ios' | 'android';
  enabled: boolean;
  createdAt: string;
  lastSeenAt: string;
};

export interface NotificationStore {
  getPreferences(userId: string): Promise<NotificationPreferences>;
  updatePreferences(userId: string, preferences: Omit<NotificationPreferences, 'schemaVersion'>): Promise<NotificationPreferences>;
  registerDevice(userId: string, platform: NotificationDevice['platform'], tokenCiphertext: string, tokenFingerprint: string): Promise<NotificationDevice>;
  listDevices(userId: string): Promise<NotificationDevice[]>;
  revokeDevice(userId: string, deviceId: string): Promise<boolean>;
}
