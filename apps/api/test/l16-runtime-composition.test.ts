import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { PaymentOrderService } from '../src/domain/payment-order.js';
import type { PaidSupportVoteStore, PaidVoteOverlayStore, VotePaymentTagStore } from '../src/domain/vote-payment-types.js';

// This test deliberately builds the complete Fastify app.  The L16 route tests
// exercise the handlers directly, but that cannot prove the application
// composition root supplies the stores used by production.

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4100,
  appOrigin: 'https://app.example.test',
  paymentEnvironment: 'test',
};

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const definitionId = '00000000-0000-4000-8000-000000000091';
const overlayId = '00000000-0000-4000-8000-000000000095';
const sessionToken = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    return token === sessionToken
      ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-09T00:00:00.000Z' }
      : null;
  },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = { async hasAcceptedActiveDocuments() { return true; } } as unknown as AccountStore;

const publicChannels: PublicChannelRepository = {
  async findByHandle(handle) {
    return handle === 'demo_creator'
      ? { channelId, handle, displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 }
      : null;
  },
  async listFeatured() { return []; },
};

const paymentOrders: PaymentOrderService = {
  async createTipOrder(input) {
    return {
      schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000092',
      provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: input.amountPaise,
      currency: 'INR', status: 'created',
    };
  },
};

function widgetSql(): Sql {
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.raw.join(' ');
    if (query.includes('list_overlay_recent_tips')) {
      return Promise.resolve([{ display_name: 'Viewer', amount_paise: 2500, message: 'Great stream', created_at: new Date('2026-09-08T00:00:00.000Z') }]);
    }
    if (query.includes('list_overlay_top_supporters')) {
      return Promise.resolve([{ rank: 1, viewer_ref: 'supporter-1', tier_label: 'supporter' }]);
    }
    if (query.includes('list_overlay_supporter_ticker')) {
      return Promise.resolve([{ viewer_ref: 'supporter-1', tier_label: 'supporter', supported_at: new Date('2026-09-08T00:00:00.000Z') }]);
    }
    if (query.includes('list_overlay_mega_tip_banner')) {
      return Promise.resolve([{ display_name: 'Viewer', amount_paise: 10000, created_at: new Date('2026-09-08T00:00:00.000Z') }]);
    }
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as Sql;
  return sql;
}

test('buildApp composes L16 paid-vote payment tagging, tally, and protected widget reads', async () => {
  const tagged: Array<{ channelId: string; interactionDefinitionId: string; optionKey: string }> = [];
  const votePaymentTags: VotePaymentTagStore = {
    async tag(input) {
      tagged.push({ channelId: input.channelId, interactionDefinitionId: input.interactionDefinitionId, optionKey: input.optionKey });
      return { outcome: 'tagged' };
    },
  };
  const paidVotes: PaidSupportVoteStore = {
    async tally(user, channel, definition) {
      assert.equal(user, userId);
      assert.equal(channel, channelId);
      assert.equal(definition, definitionId);
      return { schemaVersion: 'v1', votingMode: 'paid', options: [{ optionKey: 'option-a', label: 'Option A', amountPaise: 2500 }], resolved: false, resolvedOptionKey: null };
    },
  };
  const paidVoteOverlay: PaidVoteOverlayStore = {
    async getPaidVoteTally(token, overlay, definition) {
      assert.equal(token, sessionToken);
      assert.equal(overlay, overlayId);
      assert.equal(definition, definitionId);
      return { schemaVersion: 'v1', votingMode: 'paid', options: [], resolved: false, resolvedOptionKey: null };
    },
  };
  const app = await buildApp(config, {
    sessions, account, publicChannels, paymentOrders, votePaymentTags, paidVotes, paidVoteOverlay, sql: widgetSql(),
  });

  const checkout = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'l16-runtime-composition-001' },
    payload: { amountPaise: 2500, currency: 'INR', interactionDefinitionId: definitionId, voteOptionKey: 'option-a' },
  });
  assert.equal(checkout.statusCode, 201);
  assert.deepEqual(tagged, [{ channelId, interactionDefinitionId: definitionId, optionKey: 'option-a' }]);

  const tally = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/paid-vote-tally`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(tally.statusCode, 200);
  assert.equal(tally.json().tally.votingMode, 'paid');

  const overlayHeaders = { authorization: `Bearer ${sessionToken}` };
  const paidOverlay = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/paid-votes/${definitionId}`, headers: overlayHeaders });
  assert.equal(paidOverlay.statusCode, 200);
  for (const [path, responseKey] of [
    ['recent-tips', 'tips'], ['top-supporters', 'supporters'], ['supporter-ticker', 'entries'], ['mega-tip-banner', 'banner'],
  ] as const) {
    const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/${path}`, headers: overlayHeaders });
    assert.equal(response.statusCode, 200, path);
    assert.notEqual(response.json()[responseKey], undefined, path);
  }
  await app.close();
});
