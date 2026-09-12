import type { CompanionControlSession } from './alert-store.js';

// Desktop-only today — the L07 boundary keeps the local helper's remote
// surface to this one pairing flow, so no other clientType is admitted here
// even though CompanionControlSession itself models web/mobile/desktop.
export type CompanionPairingClientType = 'desktop';

export type DevicePairingStart = {
  schemaVersion: 'v1';
  userCode: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
  verificationUri: string;
};

export type DevicePairingPendingStatus = 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';

export type DevicePairingTokenResult =
  | { schemaVersion: 'v1'; status: DevicePairingPendingStatus }
  | { schemaVersion: 'v1'; status: 'approved'; session: CompanionControlSession };

export type CompanionPairingRequestView = {
  schemaVersion: 'v1';
  userCode: string;
  clientType: CompanionPairingClientType;
  clientLabel: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  createdAt: string;
  expiresAt: string;
};

export interface CompanionPairingStore {
  startDevicePairing(
    clientType: CompanionPairingClientType,
    clientInstanceId: string,
    clientLabel: string,
  ): Promise<DevicePairingStart>;
  pollDeviceToken(deviceCode: string): Promise<DevicePairingTokenResult>;
  getPairingRequest(userId: string, userCode: string): Promise<CompanionPairingRequestView | null>;
  approvePairing(userId: string, userCode: string, channelId: string): Promise<boolean>;
  denyPairing(userId: string, userCode: string): Promise<boolean>;
}
