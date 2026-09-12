import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPublicChannel } from './public-channel-loader';

const currentChannel = {
  channelId: '00000000-0000-4000-8000-000000000011',
  handle: 'current_handle',
  displayName: 'Demo Creator',
  acceptingTips: true,
  minimumTipPaise: 1000,
  publicConfigVersion: 1,
};

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

test('a resolved rename loads ready with renamedFrom carried through', async () => {
  const result = await loadPublicChannel(
    'https://api.example.test',
    'old_handle',
    async () => response(200, { ...currentChannel, renamedFrom: 'old_handle' }),
  );
  assert.deepEqual(result, { state: 'ready', channel: { ...currentChannel, renamedFrom: 'old_handle' } });
});

test('a handle that never existed still resolves to not_found', async () => {
  const result = await loadPublicChannel('https://api.example.test', 'never_existed', async () => response(404, { error: 'not_found' }));
  assert.deepEqual(result, { state: 'not_found' });
});
