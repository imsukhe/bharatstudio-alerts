import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeYoutubeLiveChatMessage,
  UnsupportedYoutubeLiveEventError,
  type RawYoutubeLiveChatMessage,
} from '../src/domain/youtube-live-event.js';

const author = { channelId: 'UC_synthetic_viewer', displayName: 'Synthetic Viewer' };

test('normalises a Super Chat into the canonical LiveEvent shape', () => {
  const raw: RawYoutubeLiveChatMessage = {
    id: 'chat-superchat-1',
    authorDetails: author,
    snippet: {
      type: 'superChatEvent',
      superChatDetails: { amountMicros: '5000000', currency: 'USD', userComment: 'Great stream!' },
    },
  };
  const event = normalizeYoutubeLiveChatMessage(raw);
  assert.equal(event.sourceType, 'youtube');
  assert.equal(event.sourceId, 'chat-superchat-1');
  assert.equal(event.sourceEventType, 'youtube.super_chat');
  assert.equal(event.sourceUserId, 'UC_synthetic_viewer');
  assert.equal(event.payload.displayName, 'Synthetic Viewer');
  assert.equal(event.payload.message, 'Great stream!');
  assert.equal(event.payload.amountMinorUnits, 500);
  assert.equal(event.payload.currency, 'USD');
});

test('normalises a Super Sticker into the canonical LiveEvent shape, carrying no chat text', () => {
  const raw: RawYoutubeLiveChatMessage = {
    id: 'chat-supersticker-1',
    authorDetails: author,
    snippet: {
      type: 'superStickerEvent',
      superStickerDetails: {
        amountMicros: 2000000,
        currency: 'INR',
        superStickerMetadata: { stickerId: 'sticker-42', altText: ':heart:' },
      },
    },
  };
  const event = normalizeYoutubeLiveChatMessage(raw);
  assert.equal(event.sourceEventType, 'youtube.super_sticker');
  assert.equal(event.payload.message, null);
  assert.equal(event.payload.amountMinorUnits, 200);
  assert.equal(event.payload.currency, 'INR');
  assert.equal(event.payload.stickerId, 'sticker-42');
});

test('normalises a new-membership event, carrying no monetary amount (membership billing is platform-internal, never a payment-provider capture)', () => {
  const raw: RawYoutubeLiveChatMessage = {
    id: 'chat-newsponsor-1',
    authorDetails: author,
    snippet: {
      type: 'newSponsorEvent',
      newSponsorDetails: { memberLevelName: 'Super Fan', isUpgrade: false },
    },
  };
  const event = normalizeYoutubeLiveChatMessage(raw);
  assert.equal(event.sourceEventType, 'youtube.membership_new');
  assert.equal(event.payload.amountMinorUnits, null);
  assert.equal(event.payload.currency, null);
  assert.equal(event.payload.membershipLevelName, 'Super Fan');
});

test('normalises a membership-milestone chat, carrying the milestone month and comment', () => {
  const raw: RawYoutubeLiveChatMessage = {
    id: 'chat-milestone-1',
    authorDetails: author,
    snippet: {
      type: 'memberMilestoneChatEvent',
      memberMilestoneChatDetails: { memberLevelName: 'Super Fan', memberMonth: 6, userComment: 'Six months in!' },
    },
  };
  const event = normalizeYoutubeLiveChatMessage(raw);
  assert.equal(event.sourceEventType, 'youtube.membership_milestone');
  assert.equal(event.payload.membershipMonths, 6);
  assert.equal(event.payload.message, 'Six months in!');
});

test('normalises a gifted-membership event', () => {
  const raw: RawYoutubeLiveChatMessage = {
    id: 'chat-gift-1',
    authorDetails: author,
    snippet: {
      type: 'membershipGiftingEvent',
      membershipGiftingDetails: { memberLevelName: 'Super Fan', giftMembershipsCount: 5 },
    },
  };
  const event = normalizeYoutubeLiveChatMessage(raw);
  assert.equal(event.sourceEventType, 'youtube.membership_gift');
  assert.equal(event.payload.membershipMonths, 5);
});

test('rejects an unsupported event type and a message with no author channel id', () => {
  assert.throws(
    () => normalizeYoutubeLiveChatMessage({ id: 'x', authorDetails: author, snippet: { type: 'textMessageEvent' } }),
    UnsupportedYoutubeLiveEventError,
  );
  assert.throws(() => normalizeYoutubeLiveChatMessage({ id: 'x', snippet: { type: 'superChatEvent' } }), /author channel id/);
});
