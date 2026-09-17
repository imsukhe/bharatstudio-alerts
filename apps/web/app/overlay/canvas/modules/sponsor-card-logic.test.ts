import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLogo, isSponsorCardSnapshot, type SponsorCardSnapshot } from './sponsor-card-logic';

/*
 * §6 catalogue module #11 (Sponsor Card) -- pure logic cases.
 *
 * The case that carries a recorded product decision, not a mechanical
 * requirement: nothing this guard accepts can carry a count, an
 * impression, an exposure, a duration, a "shown at"/"displayed at"
 * timestamp, or a URL/href/src of any kind (owner decision, 2026-09-17,
 * and §9.1.1).
 */

const withLogo: SponsorCardSnapshot = {
  schemaVersion: 'v1',
  sponsorName: 'Acme Energy Drinks',
  logoMimeType: 'image/png',
  logoStorageKey: '00000000-0000-4000-8000-000000005b11/' + 'ab'.repeat(32),
};

const nameOnly: SponsorCardSnapshot = {
  schemaVersion: 'v1',
  sponsorName: 'Text-Only Sponsor',
  logoMimeType: null,
  logoStorageKey: null,
};

test('a valid snapshot with a logo is accepted', () => {
  assert.equal(isSponsorCardSnapshot(withLogo), true);
  assert.equal(hasLogo(withLogo), true);
});

test('a valid snapshot with no logo is accepted', () => {
  assert.equal(isSponsorCardSnapshot(nameOnly), true);
  assert.equal(hasLogo(nameOnly), false);
});

test('null and non-object values are rejected', () => {
  assert.equal(isSponsorCardSnapshot(null), false);
  assert.equal(isSponsorCardSnapshot(undefined), false);
  assert.equal(isSponsorCardSnapshot('nope'), false);
  assert.equal(isSponsorCardSnapshot(42), false);
  assert.equal(isSponsorCardSnapshot([]), false);
});

test('a wrong schemaVersion is rejected', () => {
  assert.equal(isSponsorCardSnapshot({ ...nameOnly, schemaVersion: 'v2' }), false);
});

test('a sponsor name outside 1-120 characters is rejected', () => {
  assert.equal(isSponsorCardSnapshot({ ...nameOnly, sponsorName: '' }), false);
  assert.equal(isSponsorCardSnapshot({ ...nameOnly, sponsorName: 'x'.repeat(121) }), false);
});

test('a partial logo pair (one field present, the other absent) is rejected', () => {
  assert.equal(isSponsorCardSnapshot({ ...nameOnly, logoMimeType: 'image/png' }), false);
  assert.equal(isSponsorCardSnapshot({ ...nameOnly, logoStorageKey: 'x/' + 'ab'.repeat(32) }), false);
});

test('an extra key of any kind is rejected outright, not silently ignored', () => {
  for (const pollutedField of [
    'impressionCount', 'exposureCount', 'viewCount', 'shownAt', 'displayedAt', 'durationMs',
    'lastShownAt', 'totalDisplaySeconds', 'sponsorCardId', 'enabled', 'scheduleStartsAt',
    'scheduleEndsAt', 'createdAt', 'updatedAt', 'logoUrl', 'sponsorUrl', 'clickThroughUrl', 'iframeSrc',
  ]) {
    assert.equal(
      isSponsorCardSnapshot({ ...nameOnly, [pollutedField]: 'x' }),
      false,
      `expected "${pollutedField}" to be rejected outright`,
    );
  }
});

test('an out-of-bound logo mime type or storage key is rejected', () => {
  assert.equal(isSponsorCardSnapshot({ ...withLogo, logoMimeType: '' }), false);
  assert.equal(isSponsorCardSnapshot({ ...withLogo, logoMimeType: 'x'.repeat(121) }), false);
  assert.equal(isSponsorCardSnapshot({ ...withLogo, logoStorageKey: '' }), false);
  assert.equal(isSponsorCardSnapshot({ ...withLogo, logoStorageKey: 'x'.repeat(201) }), false);
});

// Compile-time proof, not merely a runtime one: SponsorCardSnapshot has no
// field for a count, an impression, a duration, a "shown at"/"displayed
// at" timestamp, an id, a schedule, an enabled flag, or a URL/href/src of
// any kind. If any of these lines is ever uncommented and the file still
// type-checks, this module's type gained a field it must not have.
//
// const _impressionField: SponsorCardSnapshot['impressionCount'] = 1;
// const _exposureField: SponsorCardSnapshot['exposureCount'] = 1;
// const _shownAtField: SponsorCardSnapshot['shownAt'] = '2026-09-17T00:00:00.000Z';
// const _displayedAtField: SponsorCardSnapshot['displayedAt'] = '2026-09-17T00:00:00.000Z';
// const _durationField: SponsorCardSnapshot['durationMs'] = 1;
// const _idField: SponsorCardSnapshot['sponsorCardId'] = 'x';
// const _enabledField: SponsorCardSnapshot['enabled'] = true;
// const _scheduleField: SponsorCardSnapshot['scheduleStartsAt'] = null;
// const _urlField: SponsorCardSnapshot['logoUrl'] = 'https://example.invalid';
