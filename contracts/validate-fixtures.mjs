import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(root, 'json-schema');
const fixtureDir = path.join(root, 'fixtures');
const enumDir = path.join(root, 'enums');
const openApiFile = path.join(root, 'openapi', 'v1.yaml');
const catalogueFile = path.join(root, 'template-catalogue.json');

const fixtureToSchema = {
  'alert-event.json': 'alert-event.schema.json',
  'api/channel-config.json': 'channel-config-response.schema.json',
  'cloud-task-command.json': 'cloud-task-command.schema.json',
  'entitlement-result.json': 'entitlement-result.schema.json',
  'error-envelope.json': 'error-envelope.schema.json',
  'health-response.json': 'health-response.schema.json',
  'multi-queue-delivery.json': 'multi-queue-delivery.schema.json',
  'overlay-reconnect.json': 'overlay-reconnect-case.schema.json',
  'overlay-goal-response.json': 'overlay-goal-response.schema.json',
  'overlay-challenge-response.json': 'overlay-challenge-response.schema.json',
  'overlay-lottie-list-response.json': 'overlay-lottie-list-response.schema.json',
  'overlay-stream-mission-response.json': 'overlay-stream-mission-response.schema.json',
  'overlay-vote-tally-response.json': 'overlay-vote-tally-response.schema.json',
  'overlay-hype-response.json': 'overlay-hype-response.schema.json',
  'overlay-leaderboard-response.json': 'overlay-leaderboard-response.schema.json',
  'overlay-paid-vote-tally-response.json': 'overlay-paid-vote-tally-response.schema.json',
  'overlay-moderator-status-response.json': 'overlay-moderator-status-response.schema.json',
  'overlay-reaction-cloud-response.json': 'overlay-reaction-cloud-response.schema.json',
  'overlay-lobby-status-response.json': 'overlay-lobby-status-response.schema.json',
  'channel-lobby-session-response.json': 'channel-lobby-session-response.schema.json',
  'overlay-giveaway-tournament-response.json': 'overlay-giveaway-tournament-response.schema.json',
  'channel-giveaway-response.json': 'channel-giveaway-response.schema.json',
  'channel-tournament-response.json': 'channel-tournament-response.schema.json',
  'overlay-media-queue-response.json': 'overlay-media-queue-response.schema.json',
  'channel-media-queue-item-response.json': 'channel-media-queue-item-response.schema.json',
  'channel-media-queue-list-response.json': 'channel-media-queue-list-response.schema.json',
  'overlay-safe-soundboard-response.json': 'overlay-safe-soundboard-response.schema.json',
  'channel-soundboard-catalogue-list-response.json': 'channel-soundboard-catalogue-list-response.schema.json',
  'channel-soundboard-upload-response.json': 'channel-soundboard-upload-response.schema.json',
  'trigger-soundboard-play-response.json': 'trigger-soundboard-play-response.schema.json',
  'overlay-sponsor-card-response.json': 'overlay-sponsor-card-response.schema.json',
  'channel-sponsor-card-response.json': 'channel-sponsor-card-response.schema.json',
  'public-reaction-send-response.json': 'public-reaction-send-response.schema.json',
  'channel-safe-mode-response.json': 'channel-safe-mode-response.schema.json',
  'channel-qr-smart-card-response.json': 'channel-qr-smart-card-response.schema.json',
  'overlay-qr-smart-card-response.json': 'overlay-qr-smart-card-response.schema.json',
  'channel-canvas-layout-response.json': 'channel-canvas-layout-response.schema.json',
  'overlay-canvas-layout-response.json': 'overlay-canvas-layout-response.schema.json',
  'channel-capabilities-response.json': 'channel-capabilities-response.schema.json',
  'overlay-sse-event.json': 'overlay-sse-event.schema.json',
  'payment-webhook-delivery.json': 'payment-webhook-delivery.schema.json',
  'payment-webhook-duplicate.json': 'payment-webhook-duplicate.schema.json',
  'public-receipt-response.json': 'public-receipt-response.schema.json',
  'public-featured-creators.json': 'public-featured-creators.schema.json',
  'public-profile-response.json': 'public-profile-response.schema.json',
  'public-vote-response.json': 'public-vote-response.schema.json',
  'public-paid-vote-list.json': 'public-paid-vote-list.schema.json',
  'readiness-ready-response.json': 'readiness-response.schema.json',
  'readiness-unavailable-response.json': 'readiness-response.schema.json',
  'public-sticker-list.json': 'public-sticker-list.schema.json',
  'public-sticker-selection.json': 'public-sticker-selection.schema.json',
  'viewer-auth-session.json': 'viewer-auth-session.schema.json',
  'viewer-password-reset-requested.json': 'viewer-password-reset-requested.schema.json',
  'viewer-password-reset-response.json': 'viewer-password-reset-response.schema.json',
  'viewer-session-list.json': 'viewer-session-list.schema.json',
  'viewer-deletion-response.json': 'viewer-deletion-response.schema.json',
  'viewer-dashboard-response.json': 'viewer-dashboard-response.schema.json',
  'viewer-channel-badges-response.json': 'viewer-channel-badges-response.schema.json',
  'viewer-profile-visibility-response.json': 'viewer-profile-visibility-response.schema.json',
  'queue-delivery.json': 'queue-delivery.schema.json',
  'tipintent-closed.json': 'tipintent-resolution.schema.json',
  'tipintent-confirmation-request.json': 'tipintent-confirmation-request.schema.json',
  'tipintent-ready.json': 'tipintent-resolution.schema.json',
  'tipintent-unknown.json': 'tipintent-resolution.schema.json',
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemaCache = new Map();
async function loadSchema(fileName) {
  if (!schemaCache.has(fileName)) {
    const schema = JSON.parse(await fs.readFile(path.join(schemaDir, fileName), 'utf8'));
    schemaCache.set(fileName, schema);
    ajv.addSchema(schema);
  }
  return schemaCache.get(fileName);
}

await loadSchema('channel-config.schema.json');

const failures = [];

const catalogue = JSON.parse(await fs.readFile(catalogueFile, 'utf8'));
if (catalogue.schemaVersion !== 'v1' || catalogue.catalogueId !== 'visuals-v6') failures.push('template-catalogue.json: invalid catalogue identity');
if (catalogue.authoritativeDesignCount !== 600 || catalogue.familyCount !== 30 || catalogue.variantsPerFamily !== 20) failures.push('template-catalogue.json: expected 600 designs, 30 families and 20 variants per family');
if (!Array.isArray(catalogue.supportedEvents) || catalogue.supportedEvents.length !== 12) failures.push('template-catalogue.json: expected 12 supported event types');
if (!Array.isArray(catalogue.families) || catalogue.families.length !== 30) failures.push('template-catalogue.json: expected 30 family records');
if (catalogue.knownIntegrityFindings?.metadataExceptions?.length !== 0) failures.push('template-catalogue.json: unresolved metadata exceptions remain');
const expectedTiers = { free: 'v01', creator: 'v07', studio: 'v15' };
for (const [tier, variant] of Object.entries(expectedTiers)) {
  if (catalogue.tierMinimumVariant?.[tier] !== variant) failures.push(`template-catalogue.json: ${tier} minimum variant must be ${variant}`);
}
for (let index = 0; index < (catalogue.families ?? []).length; index += 1) {
  const family = catalogue.families[index];
  const start = index * 20 + 1;
  const end = start + 19;
  const expectedRange = `BSA-${String(start).padStart(3, '0')}..BSA-${String(end).padStart(3, '0')}`;
  if (family.familyId !== `F${String(index + 1).padStart(2, '0')}` || family.designRange !== expectedRange) {
    failures.push(`template-catalogue.json: family ${index + 1} range is not contiguous (${expectedRange})`);
  }
}

// v1 deliberately excludes YouTube and Enterprise. Keep this guard scoped to
// executable contract artifacts only: planning documents may mention the
// excluded products, but a route/schema/fixture must not quietly introduce
// them into the client contract.
const forbiddenContractTerms = [
  /youtube/i,
  /enterprise/i,
  /youtube\.readonly/i,
  /youtube\.channel-memberships\.creator/i,
];
const contractFiles = [
  openApiFile,
  ...((await fs.readdir(schemaDir)).filter((name) => name.endsWith('.json')).map((name) => path.join(schemaDir, name))),
  ...((await fs.readdir(enumDir)).filter((name) => name.endsWith('.json')).map((name) => path.join(enumDir, name))),
  ...((await fs.readdir(fixtureDir, { recursive: true })).filter((name) => typeof name === 'string' && (name.endsWith('.json') || name.endsWith('.yaml'))).map((name) => path.join(fixtureDir, name))),
];
for (const file of contractFiles) {
  const text = await fs.readFile(file, 'utf8');
  const matched = forbiddenContractTerms.find((term) => term.test(text));
  if (matched) failures.push(`${path.relative(root, file)}: forbidden v1 capability term ${matched}`);
}

for (const [fixtureName, schemaName] of Object.entries(fixtureToSchema)) {
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureDir, fixtureName), 'utf8'));
  const schema = await loadSchema(schemaName);
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  if (fixture.$schema !== schema.$id) {
    failures.push(`${fixtureName}: $schema must equal ${schema.$id}`);
    continue;
  }
  if (!validate(fixture)) {
    failures.push(`${fixtureName}: ${ajv.errorsText(validate.errors)}`);
  }
}

// Prove the format plugin is active rather than merely configured: an invalid
// UUID must be rejected by the same compiled contract used for fixtures.
const alertSchema = await loadSchema('alert-event.schema.json');
const alertValidator = ajv.getSchema(alertSchema.$id);
const invalidFormatFixture = JSON.parse(await fs.readFile(path.join(fixtureDir, 'alert-event.json'), 'utf8'));
invalidFormatFixture.eventId = 'not-a-uuid';
if (alertValidator(invalidFormatFixture)) {
  failures.push('alert-event.json: invalid UUID negative case was accepted');
}

const healthSchema = await loadSchema('health-response.schema.json');
const healthValidator = ajv.getSchema(healthSchema.$id);
const healthWithRuntimeDetail = JSON.parse(await fs.readFile(path.join(fixtureDir, 'health-response.json'), 'utf8'));
healthWithRuntimeDetail.database = 'postgres://secret-host';
if (healthValidator(healthWithRuntimeDetail)) {
  failures.push('health-response.json: runtime/database detail was accepted');
}
const readinessSchema = await loadSchema('readiness-response.schema.json');
const readinessValidator = ajv.getSchema(readinessSchema.$id);
const readinessWithCredential = JSON.parse(await fs.readFile(path.join(fixtureDir, 'readiness-unavailable-response.json'), 'utf8'));
readinessWithCredential.accessToken = 'synthetic-secret';
if (readinessValidator(readinessWithCredential)) {
  failures.push('readiness-unavailable-response.json: credential field was accepted');
}
const readinessWithAccount = JSON.parse(await fs.readFile(path.join(fixtureDir, 'readiness-unavailable-response.json'), 'utf8'));
readinessWithAccount.userId = '00000000-0000-4000-8000-000000000001';
if (readinessValidator(readinessWithAccount)) {
  failures.push('readiness-unavailable-response.json: account field was accepted');
}

const overlayGoalSchema = await loadSchema('overlay-goal-response.schema.json');
const overlayGoalValidator = ajv.getSchema(overlayGoalSchema.$id);
const goalWithPaymentData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-goal-response.json'), 'utf8'));
goalWithPaymentData.goal.paymentId = '00000000-0000-4000-8000-000000000d01';
if (overlayGoalValidator(goalWithPaymentData)) {
  failures.push('overlay-goal-response.json: payment field was accepted');
}
const goalWithAccountData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-goal-response.json'), 'utf8'));
goalWithAccountData.goal.viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (overlayGoalValidator(goalWithAccountData)) {
  failures.push('overlay-goal-response.json: account field was accepted');
}
const overlayChallengeSchema = await loadSchema('overlay-challenge-response.schema.json');
const overlayChallengeValidator = ajv.getSchema(overlayChallengeSchema.$id);
const challengeWithProviderData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-challenge-response.json'), 'utf8'));
challengeWithProviderData.challenge.providerUserId = 'private-provider';
if (overlayChallengeValidator(challengeWithProviderData)) {
  failures.push('overlay-challenge-response.json: provider field was accepted');
}
const challengeWithRefundData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-challenge-response.json'), 'utf8'));
challengeWithRefundData.challenge.refundId = 'private-refund';
if (overlayChallengeValidator(challengeWithRefundData)) {
  failures.push('overlay-challenge-response.json: refund field was accepted');
}

// PRF-02 slice 5, §6 catalogue module #9 (Stream Mission Card). These
// negative cases are the build's own check on an owner decision
// (FULL-PRODUCT-DEFINITION.md §6, module table row 9, 2026-09-16): the
// mission is SESSION-bounded, not clock-bounded. A future edit that adds
// an end time, a duration or an expiry to the overlay contract fails here
// rather than shipping -- the decision is checked on every
// `pnpm contracts:validate`, not merely written down somewhere.
const overlayStreamMissionSchema = await loadSchema('overlay-stream-mission-response.schema.json');
const overlayStreamMissionValidator = ajv.getSchema(overlayStreamMissionSchema.$id);
for (const clockBoundField of ['endsAt', 'durationSeconds', 'expiresAt']) {
  const missionWithClockBound = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-stream-mission-response.json'), 'utf8'));
  missionWithClockBound.mission[clockBoundField] = clockBoundField === 'durationSeconds' ? 900 : '2026-09-16T12:00:00.000Z';
  if (overlayStreamMissionValidator(missionWithClockBound)) {
    failures.push(`overlay-stream-mission-response.json: clock-bound field ${clockBoundField} was accepted — the stream mission is session-bounded, not clock-bounded`);
  }
}
const missionWithAccountData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-stream-mission-response.json'), 'utf8'));
missionWithAccountData.mission.viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (overlayStreamMissionValidator(missionWithAccountData)) {
  failures.push('overlay-stream-mission-response.json: account identity was accepted in the overlay projection');
}
const missionWithPaymentData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-stream-mission-response.json'), 'utf8'));
missionWithPaymentData.mission.paymentId = '00000000-0000-4000-8000-000000000d01';
if (overlayStreamMissionValidator(missionWithPaymentData)) {
  failures.push('overlay-stream-mission-response.json: payment identifier was accepted in the overlay projection');
}
const missionWithOverlongObjective = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-stream-mission-response.json'), 'utf8'));
missionWithOverlongObjective.mission.objective = 'a'.repeat(121);
if (overlayStreamMissionValidator(missionWithOverlongObjective)) {
  failures.push('overlay-stream-mission-response.json: a 121-character objective was accepted — the bound is 1-120 (migration 0109 line 67, reused)');
}

const overlayLottieSchema = await loadSchema('overlay-lottie-list-response.schema.json');
const overlayLottieValidator = ajv.getSchema(overlayLottieSchema.$id);
const lottieWithAccountData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-lottie-list-response.json'), 'utf8'));
lottieWithAccountData.items[0].channelId = '00000000-0000-4000-8000-0000000000a1';
if (overlayLottieValidator(lottieWithAccountData)) {
  failures.push('overlay-lottie-list-response.json: channel identifier was accepted');
}
const lottieWithUnsupportedStyle = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-lottie-list-response.json'), 'utf8'));
lottieWithUnsupportedStyle.items[0].displayStyle = 'arbitrary';
if (overlayLottieValidator(lottieWithUnsupportedStyle)) {
  failures.push('overlay-lottie-list-response.json: unsupported display style was accepted');
}

const overlayVoteSchema = await loadSchema('overlay-vote-tally-response.schema.json');
const overlayVoteValidator = ajv.getSchema(overlayVoteSchema.$id);
const voteWithPaymentData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-vote-tally-response.json'), 'utf8'));
voteWithPaymentData.tally.options[0].paymentId = 'private-payment';
if (overlayVoteValidator(voteWithPaymentData)) {
  failures.push('overlay-vote-tally-response.json: payment field was accepted');
}
const voteWithNegativeCount = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-vote-tally-response.json'), 'utf8'));
voteWithNegativeCount.tally.options[0].voteCount = -1;
if (overlayVoteValidator(voteWithNegativeCount)) {
  failures.push('overlay-vote-tally-response.json: negative vote count was accepted');
}

// PRF-02, catalogue module #12 (Moderator Status Card). §6 requires
// "never private content" on this surface and the owner's 2026-09-16
// decision requires it to be a property of the query rather than of the
// renderer -- migration 0138's function returns exactly held_count and
// safe_mode. These negative cases are the CONTRACT's own half of that
// guarantee: the published response schema must refuse every private
// field outright, so a future server change cannot introduce one without
// a visible, reviewable contract change.
const overlayModeratorStatusSchema = await loadSchema('overlay-moderator-status-response.schema.json');
const overlayModeratorStatusValidator = ajv.getSchema(overlayModeratorStatusSchema.$id);
for (const [field, value] of [
  ['supporterName', 'Riya'],
  ['message', 'a private supporter message'],
  ['amountPaise', 300000],
  ['deliveryId', '00000000-0000-4000-8000-000000005561'],
  ['eventId', '00000000-0000-4000-8000-000000005541'],
  ['queueId', '00000000-0000-4000-8000-000000005521'],
  ['viewerIdentityId', '00000000-0000-4000-8000-0000000000a1'],
]) {
  const polluted = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
  polluted.moderatorStatus[field] = value;
  if (overlayModeratorStatusValidator(polluted)) {
    failures.push(`overlay-moderator-status-response.json: private field ${field} was accepted`);
  }
}
// Safe mode arriving did NOT make alert_queues.is_paused publishable.
// The owner's 2026-09-16 decision says safe mode is a creator switch and
// is explicitly NOT that flag, which remains a queue lifecycle state no
// overlay contract may carry -- including under a name that merely looks
// like safe mode's.
for (const field of ['isPaused', 'paused', 'queuePaused']) {
  const withQueueFlag = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
  withQueueFlag.moderatorStatus[field] = true;
  if (overlayModeratorStatusValidator(withQueueFlag)) {
    failures.push(`overlay-moderator-status-response.json: ${field} was accepted -- safe mode is NOT the queue-paused flag and that flag must not appear in any overlay contract`);
  }
}
// safeMode is required, and is a real boolean. A response missing it is
// not a valid answer (the card would have nothing to say about the half
// of module #12 this completes), and a truthy non-boolean must never be
// coerced into "safe mode on" -- that would be a claim about moderation
// state nothing verified.
const moderatorStatusWithoutSafeMode = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
delete moderatorStatusWithoutSafeMode.moderatorStatus.safeMode;
if (overlayModeratorStatusValidator(moderatorStatusWithoutSafeMode)) {
  failures.push('overlay-moderator-status-response.json: a moderatorStatus without safeMode was accepted -- the flag is required, not optional');
}
for (const value of ['true', 1, 'on']) {
  const moderatorStatusBadSafeMode = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
  moderatorStatusBadSafeMode.moderatorStatus.safeMode = value;
  if (overlayModeratorStatusValidator(moderatorStatusBadSafeMode)) {
    failures.push(`overlay-moderator-status-response.json: safeMode ${JSON.stringify(value)} was accepted -- it must be a boolean and must never be coerced`);
  }
}
// Safe mode ON with nothing yet held is a real and important answer: the
// creator has just switched it on. It must validate.
const moderatorStatusSafeModeOnlyOn = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
moderatorStatusSafeModeOnlyOn.moderatorStatus.heldCount = 0;
moderatorStatusSafeModeOnlyOn.moderatorStatus.safeMode = true;
if (!overlayModeratorStatusValidator(moderatorStatusSafeModeOnlyOn)) {
  failures.push('overlay-moderator-status-response.json: safe mode on with heldCount 0 must be a VALID answer -- it is the state immediately after a creator turns the switch on');
}
const moderatorStatusNegativeCount = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
moderatorStatusNegativeCount.moderatorStatus.heldCount = -1;
if (overlayModeratorStatusValidator(moderatorStatusNegativeCount)) {
  failures.push('overlay-moderator-status-response.json: negative held count was accepted');
}
const moderatorStatusFractionalCount = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
moderatorStatusFractionalCount.moderatorStatus.heldCount = 1.5;
if (overlayModeratorStatusValidator(moderatorStatusFractionalCount)) {
  failures.push('overlay-moderator-status-response.json: fractional held count was accepted');
}
const moderatorStatusZero = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
moderatorStatusZero.moderatorStatus.heldCount = 0;
moderatorStatusZero.moderatorStatus.safeMode = false;
if (!overlayModeratorStatusValidator(moderatorStatusZero)) {
  failures.push('overlay-moderator-status-response.json: heldCount 0 with safeMode false must be a VALID answer -- a recognised overlay token with nothing held and safe mode off returns exactly that, which is different from an unrecognised token returning null');
}

// PRF-02, catalogue module #12: the CREATOR side of safe mode.
//
// Safe mode is a SWITCH, not a policy object. The owner's 2026-09-16
// decision says it is never automatic and is engaged by no signal, so
// the published contract must refuse every knob outright -- a threshold,
// a window, a rate, a duration, an expiry, a reason or a trigger in this
// response would be a product decision arriving through a schema change
// nobody reviewed as one. These are the contract's half of that.
const channelSafeModeSchema = await loadSchema('channel-safe-mode-response.schema.json');
const channelSafeModeValidator = ajv.getSchema(channelSafeModeSchema.$id);
for (const [field, value] of [
  ['threshold', 10],
  ['windowSeconds', 60],
  ['rateLimitPerMinute', 30],
  ['auto', true],
  ['triggeredBy', 'spike'],
  ['expiresAt', '2026-09-16T00:00:00Z'],
  ['durationSeconds', 900],
  ['reason', 'a spike of alerts'],
]) {
  const withKnob = JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-safe-mode-response.json'), 'utf8'));
  withKnob.safeMode[field] = value;
  if (channelSafeModeValidator(withKnob)) {
    failures.push(`channel-safe-mode-response.json: ${field} was accepted -- safe mode is a creator switch and is NEVER automatic, so it carries no threshold, window, duration or trigger of any kind`);
  }
}
// It is not the queue-paused flag either, on this side of the product.
for (const field of ['isPaused', 'paused']) {
  const withQueueFlag = JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-safe-mode-response.json'), 'utf8'));
  withQueueFlag.safeMode[field] = true;
  if (channelSafeModeValidator(withQueueFlag)) {
    failures.push(`channel-safe-mode-response.json: ${field} was accepted -- safe mode is NOT alert_queues.is_paused`);
  }
}
for (const value of ['true', 1, null]) {
  const badEnabled = JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-safe-mode-response.json'), 'utf8'));
  badEnabled.safeMode.enabled = value;
  if (channelSafeModeValidator(badEnabled)) {
    failures.push(`channel-safe-mode-response.json: enabled ${JSON.stringify(value)} was accepted -- it must be a boolean`);
  }
}
// Off is a valid, ordinary answer -- and the only one a channel that has
// never touched the switch can give.
const safeModeOff = JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-safe-mode-response.json'), 'utf8'));
safeModeOff.safeMode.enabled = false;
if (!channelSafeModeValidator(safeModeOff)) {
  failures.push('channel-safe-mode-response.json: enabled false must be a VALID answer -- it is the default state of every channel');
}

// PRF-02 slice 6 / PRF-06, catalogue module #5 (Reaction Cloud). §6 #5
// requires this surface to be NON-IDENTIFYING and the owner's 2026-09-16
// decision requires that to be a property of the read rather than of the
// renderer -- migration 0139's function returns catalogue entry ids and
// counts only. These negative cases are the CONTRACT's own half of that
// guarantee: the published response schema must refuse every identifying
// field outright, so a future server change cannot introduce one without a
// visible, reviewable contract change.
const overlayReactionCloudSchema = await loadSchema('overlay-reaction-cloud-response.schema.json');
const overlayReactionCloudValidator = ajv.getSchema(overlayReactionCloudSchema.$id);
async function reactionCloudFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-reaction-cloud-response.json'), 'utf8'));
}
for (const [field, value] of [
  ['viewerId', '00000000-0000-4000-8000-0000000000a1'],
  ['viewerIdentityId', '00000000-0000-4000-8000-0000000000a2'],
  ['anonymousIdentityId', '00000000-0000-4000-8000-0000000000a3'],
  ['anonymousIdentityTokenHash', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['sessionId', '00000000-0000-4000-8000-0000000000a4'],
  ['overlaySessionId', '00000000-0000-4000-8000-0000000000a5'],
  ['ipAddress', '203.0.113.7'],
  ['supporterName', 'Riya'],
  ['message', 'a private supporter message'],
  // A timestamp is identifying on this surface even though it names nobody:
  // per-send times are what would let one viewer's reactions be correlated
  // with each other, which is exactly what "non-identifying" forbids.
  ['createdAt', '2026-09-16T10:00:00.000Z'],
  ['sentAt', '2026-09-16T10:00:00.000Z'],
  ['lastReactionAt', '2026-09-16T10:00:00.000Z'],
]) {
  const polluted = await reactionCloudFixture();
  polluted.entries[0][field] = value;
  if (overlayReactionCloudValidator(polluted)) {
    failures.push(`overlay-reaction-cloud-response.json: identifying field ${field} was accepted`);
  }
}
// The asset itself never travels on this path either: a reaction is a send
// of an entry that is ALREADY in the curated catalogue (owner decision,
// 2026-09-16), so there is no bytes/url/mime surface here at all and the
// contract must refuse one.
for (const [field, value] of [
  ['assetBytes', 'e30='],
  ['assetUrl', 'https://cdn.example.invalid/sticker.json'],
  ['renderDocument', { v: '5.7.4' }],
  ['mimeType', 'application/json'],
]) {
  const polluted = await reactionCloudFixture();
  polluted.entries[0][field] = value;
  if (overlayReactionCloudValidator(polluted)) {
    failures.push(`overlay-reaction-cloud-response.json: ${field} was accepted -- a reaction carries a catalogue entry id, never an asset`);
  }
}
// A viewer-supplied source would be a new asset pipeline, which the owner
// decision explicitly does not authorise.
const reactionCloudUnknownSource = await reactionCloudFixture();
reactionCloudUnknownSource.entries[0].entrySource = 'viewer_upload';
if (overlayReactionCloudValidator(reactionCloudUnknownSource)) {
  failures.push('overlay-reaction-cloud-response.json: an entry source outside the existing curated catalogue was accepted');
}
// An entry with no reactions is ABSENT, not present with a zero -- the read
// is an aggregate over a window, so a zero row cannot exist.
for (const count of [0, -1, 1.5]) {
  const polluted = await reactionCloudFixture();
  polluted.entries[0].reactionCount = count;
  if (overlayReactionCloudValidator(polluted)) {
    failures.push(`overlay-reaction-cloud-response.json: reactionCount ${count} was accepted`);
  }
}
// An EMPTY cloud is a VALID answer, and it is the same answer an
// unrecognised overlay token gets: both mean paint nothing.
const reactionCloudEmpty = await reactionCloudFixture();
reactionCloudEmpty.entries = [];
if (!overlayReactionCloudValidator(reactionCloudEmpty)) {
  failures.push('overlay-reaction-cloud-response.json: an empty entries array must be a VALID answer -- it is what both a quiet channel and an unrecognised overlay token return');
}

// The public send response carries an outcome and nothing else: a reaction
// is not a record a viewer owns, reads back, edits or deletes, so there is
// nothing for a viewer to address afterwards and no identifier to hand out.
const publicReactionSendSchema = await loadSchema('public-reaction-send-response.schema.json');
const publicReactionSendValidator = ajv.getSchema(publicReactionSendSchema.$id);
for (const [field, value] of [
  ['reactionId', '00000000-0000-4000-8000-0000000000b1'],
  ['viewerId', '00000000-0000-4000-8000-0000000000b2'],
  ['anonymousIdentityId', '00000000-0000-4000-8000-0000000000b3'],
  ['channelId', '00000000-0000-4000-8000-000000005711'],
  ['createdAt', '2026-09-16T10:00:00.000Z'],
  ['remainingThisMinute', 42],
]) {
  const polluted = JSON.parse(await fs.readFile(path.join(fixtureDir, 'public-reaction-send-response.json'), 'utf8'));
  polluted[field] = value;
  if (publicReactionSendValidator(polluted)) {
    failures.push(`public-reaction-send-response.json: ${field} was accepted -- the send response carries an outcome and nothing else`);
  }
}

// PRF-02 slice 6, catalogue module #16 (Lobby Status). §16 is explicit that
// the public overlay shows "aggregate status only ... Never player
// identifiers, never Discord names, never codes or passwords", and the
// owner's 2026-09-16 decision 4 requires that to be a property of the read
// rather than of the renderer -- migration 0140's function returns three
// integer columns. These negative cases are the CONTRACT's own half of that
// guarantee: the published response schema must refuse every one of those
// fields outright, so a future server change cannot introduce one without a
// visible, reviewable contract change.
const overlayLobbyStatusSchema = await loadSchema('overlay-lobby-status-response.schema.json');
const overlayLobbyStatusValidator = ajv.getSchema(overlayLobbyStatusSchema.$id);
async function lobbyStatusFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-lobby-status-response.json'), 'utf8'));
}
for (const [field, value] of [
  // The four things §16 names outright: codes, passwords, player
  // identifiers, Discord names.
  ['roomCode', 'BGMI-4417'],
  ['roomPassword', 'hunter2'],
  ['password', 'hunter2'],
  ['seatToken', 'st_9f2c'],
  ['playerId', '00000000-0000-4000-8000-0000000000a1'],
  ['playerName', 'Riya'],
  ['inGameName', 'RIYA_OP'],
  ['discordName', 'riya#1234'],
  // Viewer identity in every shape this codebase has one.
  ['viewerId', '00000000-0000-4000-8000-0000000000a2'],
  ['viewerIdentityId', '00000000-0000-4000-8000-0000000000a3'],
  ['anonymousIdentityId', '00000000-0000-4000-8000-0000000000a4'],
  ['anonymousIdentityTokenHash', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['sessionId', '00000000-0000-4000-8000-0000000000a5'],
  ['overlaySessionId', '00000000-0000-4000-8000-0000000000a6'],
  ['lobbyId', '00000000-0000-4000-8000-000000005851'],
  ['ipAddress', '203.0.113.7'],
  // Opted-in initials and avatars are permitted by §16 but are OUT OF
  // SCOPE by owner decision 5: they need an opt-in mechanism that does not
  // exist in this schema. The contract refuses them so nothing can ship an
  // approximation of one.
  ['initials', 'RS'],
  ['avatarUrl', 'https://cdn.example.invalid/a.png'],
  ['participants', [{ name: 'Riya' }]],
  // A per-viewer list in any shape is the thing decision 4 forbids.
  ['waitlist', ['Riya', 'Arjun']],
  ['seats', [{ playerName: 'Riya' }]],
]) {
  const polluted = await lobbyStatusFixture();
  polluted.lobbyStatus[field] = value;
  if (overlayLobbyStatusValidator(polluted)) {
    failures.push(`overlay-lobby-status-response.json: ${field} was accepted -- §16 permits aggregate status only on the public overlay`);
  }
}
// A null status is a VALID answer, and it is the same answer an
// unrecognised token, a channel with no open lobby and an UNENTITLED
// channel all get: every one of them means paint nothing.
const lobbyStatusAbsent = await lobbyStatusFixture();
lobbyStatusAbsent.lobbyStatus = null;
if (!overlayLobbyStatusValidator(lobbyStatusAbsent)) {
  failures.push('overlay-lobby-status-response.json: a null lobbyStatus must be a VALID answer -- it is what an unrecognised token, a quiet channel and an unentitled channel all return');
}
// A lobby with every seat confirmed and an empty queue is ordinary and
// valid -- 16/16 with nobody waiting.
const lobbyStatusFull = await lobbyStatusFixture();
lobbyStatusFull.lobbyStatus.confirmedSeatCount = lobbyStatusFull.lobbyStatus.seatCount;
lobbyStatusFull.lobbyStatus.queueCount = 0;
if (!overlayLobbyStatusValidator(lobbyStatusFull)) {
  failures.push('overlay-lobby-status-response.json: a full lobby with an empty queue must be a valid answer');
}
for (const [field, bad] of [
  ['seatCount', 0], ['seatCount', -1], ['seatCount', 1.5],
  ['confirmedSeatCount', -1], ['confirmedSeatCount', 1.5],
  ['queueCount', -1], ['queueCount', 1.5],
]) {
  const polluted = await lobbyStatusFixture();
  polluted.lobbyStatus[field] = bad;
  if (overlayLobbyStatusValidator(polluted)) {
    failures.push(`overlay-lobby-status-response.json: ${field} ${bad} was accepted`);
  }
}

// The CREATOR-facing lobby record. It carries a lobby id (its write path is
// addressed, not ambient) but still no code, password, seat token,
// participant list or player identifier -- none of those exists in the
// schema behind it, because they are the Lobby Engine and are Phase 3.
const channelLobbySessionSchema = await loadSchema('channel-lobby-session-response.schema.json');
const channelLobbySessionValidator = ajv.getSchema(channelLobbySessionSchema.$id);
async function lobbySessionFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-lobby-session-response.json'), 'utf8'));
}
for (const [field, value] of [
  ['roomCode', 'BGMI-4417'],
  ['password', 'hunter2'],
  ['seatToken', 'st_9f2c'],
  ['playerName', 'Riya'],
  ['discordName', 'riya#1234'],
  ['participants', [{ name: 'Riya' }]],
  ['waitlist', ['Riya']],
  ['readyCheckStartedAt', '2026-09-16T10:02:00.000Z'],
  ['selectionPolicy', 'fifo'],
  ['queuePolicy', 'creator_pick'],
  ['reserveSeats', 4],
  // Session-bounded, not clock-bounded: there is no duration, timer,
  // expiry or deadline column in the schema and none in the contract.
  ['durationSeconds', 900],
  ['expiresAt', '2026-09-16T11:00:00.000Z'],
  ['endsAt', '2026-09-16T11:00:00.000Z'],
  // No price, no billing, no purchase path anywhere in this slice.
  ['pricePaise', 12900],
  ['entryFeePaise', 5000],
]) {
  const polluted = await lobbySessionFixture();
  polluted.lobby[field] = value;
  if (channelLobbySessionValidator(polluted)) {
    failures.push(`channel-lobby-session-response.json: ${field} was accepted -- that is the Lobby Engine, or a price, and this slice builds neither`);
  }
}
const lobbySessionAbsent = await lobbySessionFixture();
lobbySessionAbsent.lobby = null;
if (!channelLobbySessionValidator(lobbySessionAbsent)) {
  failures.push('channel-lobby-session-response.json: a null lobby must be a VALID answer -- it is what a channel with no open lobby returns, at every tier');
}
const lobbySessionClosed = await lobbySessionFixture();
lobbySessionClosed.lobby.closedAt = '2026-09-16T11:30:00.000Z';
if (!channelLobbySessionValidator(lobbySessionClosed)) {
  failures.push('channel-lobby-session-response.json: a closed lobby must remain a valid, readable durable record (12.6)');
}

// PRF-02 slice 6, catalogue module #17 (Giveaway / Tournament Card). §17
// carries three prohibitions that are PRE-EXISTING PRODUCT AND LEGAL
// DECISIONS rather than preferences, and this is the CONTRACT's own half
// of enforcing each: the published response schemas must refuse every one
// of these fields outright, so a future server change cannot introduce one
// without a visible, reviewable contract change.
//
//   1. NO CHANCE MECHANIC OF ANY KIND. §17.1 decided on 2026-09-13 --
//      before and independently of GIV-07 -- that only free-entry and
//      skill-based formats ship and that supporter-weighted odds are not
//      built. GIV-07 separately gates chance-based formats on a legal
//      review that has not happened, and stays Blocked.
//   2. NO WINNER, AND NO CREATOR-RECORDS-THE-WINNER SURFACE. §17.1
//      permits an announcement only WITH CONSENT, and no consent
//      mechanism exists in this schema.
//   3. BHARATSTUDIO NEVER HOLDS, ESCROWS, SHIPS OR GUARANTEES A PRIZE.
//      The creator is the promoter and is responsible for eligibility,
//      taxes and delivery.
//
// Plus §17.1's "never a paid-only entry", which holds by construction here
// because there is no entry path at all -- and the aggregate-only rule
// every overlay read in this codebase is held to.
const overlayGiveawayTournamentSchema = await loadSchema('overlay-giveaway-tournament-response.schema.json');
const overlayGiveawayTournamentValidator = ajv.getSchema(overlayGiveawayTournamentSchema.$id);
async function giveawayTournamentFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-giveaway-tournament-response.json'), 'utf8'));
}
for (const [field, value] of [
  // 1. No chance mechanic.
  ['drawMethod', 'seeded'],
  ['drawnAt', '2026-09-17T10:31:00.000Z'],
  ['seed', 'abc123'],
  ['entrantCountAtDraw', 143],
  ['odds', 2],
  ['weighting', 'supporter'],
  ['weightedEntries', 12],
  ['shuffled', true],
  // 2. No winner, and no override log for one either.
  ['winner', 'Riya'],
  ['winnerName', 'Riya'],
  ['winnerUserId', '00000000-0000-4000-8000-0000000000a1'],
  ['winnerInitials', 'RS'],
  ['winnerAnnouncedAt', '2026-09-17T10:31:00.000Z'],
  ['champion', 'Riya'],
  ['overrideReason', 'no-show'],
  // 3. No prize custody, escrow, fulfilment, delivery, address or claim.
  ['prize', 'A gaming mouse'],
  ['prizeValuePaise', 450000],
  ['escrowHeld', true],
  ['custodyState', 'held'],
  ['fulfilmentState', 'shipped'],
  ['shippedAt', '2026-09-18T00:00:00.000Z'],
  ['shippingAddress', '12 MG Road'],
  ['courier', 'BlueDart'],
  ['trackingNumber', 'BD123'],
  ['claimUrl', 'https://example.invalid/claim'],
  ['claimCode', 'CLAIM-1'],
  // Never a paid entry, and no price anywhere in this slice.
  ['entryFeePaise', 5000],
  ['pricePaise', 12900],
  ['amountPaise', 1],
  // Participant identity in every shape this codebase has one.
  ['participants', [{ name: 'Riya' }]],
  ['entrants', ['Riya']],
  ['playerName', 'Riya'],
  ['inGameName', 'RIYA_OP'],
  ['discordName', 'riya#1234'],
  ['viewerId', '00000000-0000-4000-8000-0000000000a2'],
  ['anonymousId', 'anon_1'],
  ['initials', 'RS'],
  ['avatarUrl', 'https://example.invalid/a.png'],
  ['emailAddress', 'riya@example.invalid'],
  ['phone', '+911234567890'],
  // Not even a session identifier the card does not paint.
  ['giveawayId', '00000000-0000-4000-8000-000000005a51'],
  ['tournamentId', '00000000-0000-4000-8000-000000005a61'],
  ['lobbySessionId', '00000000-0000-4000-8000-000000005851'],
  ['overlayId', '00000000-0000-4000-8000-000000005a41'],
  // A bracket TREE needs participant labels, which §16 ruled need an
  // opt-in mechanism that does not exist.
  ['bracket', [{ a: 'Riya', b: 'Arjun' }]],
  ['matches', [{ home: 'Riya', away: 'Arjun' }]],
  ['standings', [{ name: 'Riya', points: 3 }]],
  ['seeding', 'random'],
  // Sponsor exposure is TRN-06 and is legal-adjacent and undecided.
  ['sponsor', 'Acme'],
  ['sponsorImpressions', 100],
]) {
  const polluted = await giveawayTournamentFixture();
  polluted.giveawayTournament[field] = value;
  if (overlayGiveawayTournamentValidator(polluted)) {
    failures.push(`overlay-giveaway-tournament-response.json: ${field} was accepted -- §17 forbids a chance mechanic, a winner, prize custody, a paid entry and any participant identity on the overlay`);
  }
}

// Either half alone is a valid answer, and so is a null state -- a closed
// giveaway, a concluded tournament, an unentitled channel and an
// unrecognised token all mean "paint nothing".
const giveawayOnly = await giveawayTournamentFixture();
giveawayOnly.giveawayTournament.tournamentCurrentRound = null;
giveawayOnly.giveawayTournament.tournamentTotalRounds = null;
giveawayOnly.giveawayTournament.tournamentCompletedMatchesInRound = null;
giveawayOnly.giveawayTournament.tournamentMatchesInRound = null;
if (!overlayGiveawayTournamentValidator(giveawayOnly)) {
  failures.push('overlay-giveaway-tournament-response.json: a giveaway with no tournament must be a valid answer');
}
const tournamentOnly = await giveawayTournamentFixture();
tournamentOnly.giveawayTournament.entryCount = null;
tournamentOnly.giveawayTournament.entryClosesAt = null;
if (!overlayGiveawayTournamentValidator(tournamentOnly)) {
  failures.push('overlay-giveaway-tournament-response.json: a tournament with no giveaway must be a valid answer');
}
const nothingRunning = await giveawayTournamentFixture();
nothingRunning.giveawayTournament = null;
if (!overlayGiveawayTournamentValidator(nothingRunning)) {
  failures.push('overlay-giveaway-tournament-response.json: a null state must be a VALID answer -- it is what a closed giveaway, a concluded tournament, an unentitled channel and an unrecognised token all return');
}
// Zero entries with the window still open IS a state worth painting.
const zeroEntries = await giveawayTournamentFixture();
zeroEntries.giveawayTournament.entryCount = 0;
if (!overlayGiveawayTournamentValidator(zeroEntries)) {
  failures.push('overlay-giveaway-tournament-response.json: a giveaway with zero entries must be a valid answer -- that is the invitation, not an empty state');
}
for (const [field, bad] of [
  ['entryCount', -1], ['entryCount', 1.5],
  // §30.3 caps a single-elimination field at 8, so there is no round 4 and
  // no round holding more than four matches.
  ['tournamentCurrentRound', 0], ['tournamentCurrentRound', 4],
  ['tournamentTotalRounds', 4],
  ['tournamentCompletedMatchesInRound', -1], ['tournamentCompletedMatchesInRound', 5],
  ['tournamentMatchesInRound', 0], ['tournamentMatchesInRound', 5],
]) {
  const polluted = await giveawayTournamentFixture();
  polluted.giveawayTournament[field] = bad;
  if (overlayGiveawayTournamentValidator(polluted)) {
    failures.push(`overlay-giveaway-tournament-response.json: ${field} ${bad} was accepted`);
  }
}

// The CREATOR-facing records. Each carries its own id (its write path is
// addressed, not ambient) but still no mechanic, no winner, no prize
// custody, no price and no participant -- none of those exists in the
// schema behind them.
const channelGiveawaySchema = await loadSchema('channel-giveaway-response.schema.json');
const channelGiveawayValidator = ajv.getSchema(channelGiveawaySchema.$id);
async function channelGiveawayFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-giveaway-response.json'), 'utf8'));
}
for (const [field, value] of [
  ['drawMethod', 'seeded'], ['seed', 'abc123'], ['odds', 2], ['weighting', 'supporter'],
  ['winner', 'Riya'], ['winnerUserId', '00000000-0000-4000-8000-0000000000a1'], ['overrideReason', 'no-show'],
  ['prize', 'A gaming mouse'], ['prizeValuePaise', 450000], ['escrowHeld', true],
  ['shippingAddress', '12 MG Road'], ['claimUrl', 'https://example.invalid/claim'],
  ['entryFeePaise', 5000], ['pricePaise', 12900],
  ['entryMethod', 'follow'], ['requiresFollow', true], ['supporterOnly', true],
  ['participants', [{ name: 'Riya' }]], ['entrants', ['Riya']],
  // Session-bounded, not clock-bounded beyond the published window: there
  // is no duration, countdown or timer column and none in the contract.
  ['durationSeconds', 900], ['countdownSeconds', 900], ['timerMs', 1000],
]) {
  const polluted = await channelGiveawayFixture();
  polluted.giveaway[field] = value;
  if (channelGiveawayValidator(polluted)) {
    failures.push(`channel-giveaway-response.json: ${field} was accepted -- that is a chance mechanic, a winner, prize custody, a price or an entry path, and this slice builds none of them`);
  }
}
const giveawayAbsent = await channelGiveawayFixture();
giveawayAbsent.giveaway = null;
if (!channelGiveawayValidator(giveawayAbsent)) {
  failures.push('channel-giveaway-response.json: a null giveaway must be a VALID answer -- it is what a channel with none open returns, at every tier');
}
const giveawayClosed = await channelGiveawayFixture();
giveawayClosed.giveaway.closedAt = '2026-09-17T10:30:00.000Z';
if (!channelGiveawayValidator(giveawayClosed)) {
  failures.push('channel-giveaway-response.json: a closed giveaway must remain a valid, readable durable record (12.6)');
}

const channelTournamentSchema = await loadSchema('channel-tournament-response.schema.json');
const channelTournamentValidator = ajv.getSchema(channelTournamentSchema.$id);
async function channelTournamentFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-tournament-response.json'), 'utf8'));
}
for (const [field, value] of [
  ['winner', 'Riya'], ['champion', 'Riya'], ['seed', 'abc123'], ['seeding', 'random'],
  ['prize', 'A gaming mouse'], ['escrowHeld', true], ['shippingAddress', '12 MG Road'],
  ['entryFeePaise', 5000],
  ['participants', [{ name: 'Riya' }]], ['teams', [{ name: 'Alpha' }]],
  ['matches', [{ home: 'Riya', away: 'Arjun' }]], ['bracket', [{ a: 'Riya' }]],
  ['scores', [1, 0]], ['disputeNote', 'contested'],
  ['sponsor', 'Acme'], ['sponsorImpressions', 100],
  // §30.3 places all three at Studio; this slice has one entitlement gate.
  ['bracketType', 'double_elimination'], ['format', 'round_robin'], ['pointsTable', []],
  ['checkInWindowSeconds', 300],
]) {
  const polluted = await channelTournamentFixture();
  polluted.tournament[field] = value;
  if (channelTournamentValidator(polluted)) {
    failures.push(`channel-tournament-response.json: ${field} was accepted -- that is a result, a prize, a participant, a Studio-only bracket type or a feature this slice does not build`);
  }
}
// §30.3 caps a single-elimination field at 8, and a bracket without byes
// needs a power of two -- byes belong to seeding, which is not built.
for (const bad of [1, 3, 6, 16]) {
  const polluted = await channelTournamentFixture();
  polluted.tournament.fieldSize = bad;
  if (channelTournamentValidator(polluted)) {
    failures.push(`channel-tournament-response.json: a field of ${bad} was accepted -- single elimination without byes needs 2, 4 or 8`);
  }
}
const tournamentAbsent = await channelTournamentFixture();
tournamentAbsent.tournament = null;
if (!channelTournamentValidator(tournamentAbsent)) {
  failures.push('channel-tournament-response.json: a null tournament must be a VALID answer -- it is what a channel with none running returns, at every tier');
}
const tournamentConcluded = await channelTournamentFixture();
tournamentConcluded.tournament.concludedAt = '2026-09-17T11:30:00.000Z';
if (!channelTournamentValidator(tournamentConcluded)) {
  failures.push('channel-tournament-response.json: a concluded tournament must remain a valid, readable durable record (12.6)');
}

// PRF-02 slice 7, §6 catalogue module #11 (Sponsor Card). THE CARD
// RENDERS THE SPONSOR AND COUNTS NOTHING (owner decision, 2026-09-17) --
// the exposure event log named in the original catalogue row is DROPPED,
// not narrowed. No impression, exposure, view, duration, "shown at" or
// "displayed at" field may appear on either projection, and no
// url/href/src-shaped field may appear either -- the logo is an asset
// reference (channelId + sha256, §19.1), never a fetchable third-party
// URL (§9.1.1).
const overlaySponsorCardSchema = await loadSchema('overlay-sponsor-card-response.schema.json');
const overlaySponsorCardValidator = ajv.getSchema(overlaySponsorCardSchema.$id);
async function overlaySponsorCardFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-sponsor-card-response.json'), 'utf8'));
}
for (const [field, value] of [
  // The whole point of the 2026-09-17 decision: nothing is counted.
  ['impressionCount', 4021], ['exposureCount', 4021], ['viewCount', 4021],
  ['shownAt', '2026-09-17T10:00:00.000Z'], ['displayedAt', '2026-09-17T10:00:00.000Z'],
  ['lastShownAt', '2026-09-17T10:00:00.000Z'], ['durationMs', 5000], ['totalDisplaySeconds', 300],
  // Fields that exist on the CREATOR projection but must never reach the
  // overlay: an id, the schedule, the enabled flag, timestamps.
  ['sponsorCardId', '00000000-0000-4000-8000-000000005b51'],
  ['enabled', true],
  ['scheduleStartsAt', '2026-09-17T09:00:00.000Z'], ['scheduleEndsAt', '2026-09-17T11:00:00.000Z'],
  ['createdAt', '2026-09-17T10:00:00.000Z'], ['updatedAt', '2026-09-17T10:05:00.000Z'],
  // §9.1.1: no field capable of carrying a third-party URL, script,
  // iframe or stylesheet onto the Master Canvas.
  ['logoUrl', 'https://example.invalid/logo.png'], ['sponsorUrl', 'https://example.invalid'],
  ['clickThroughUrl', 'https://example.invalid/click'], ['iframeSrc', 'https://example.invalid/embed'],
]) {
  const polluted = await overlaySponsorCardFixture();
  polluted.sponsorCard[field] = value;
  if (overlaySponsorCardValidator(polluted)) {
    failures.push(`overlay-sponsor-card-response.json: ${field} was accepted -- the Sponsor Card renders the sponsor and counts nothing (2026-09-17 decision), and no field may carry a third-party URL onto the Master Canvas (9.1.1)`);
  }
}
// A null sponsorCard is what a disabled card, a card outside its
// schedule, an unrecognised token and a channel with no card at all all
// return -- every one of them means paint nothing.
const sponsorCardAbsent = await overlaySponsorCardFixture();
sponsorCardAbsent.sponsorCard = null;
if (!overlaySponsorCardValidator(sponsorCardAbsent)) {
  failures.push('overlay-sponsor-card-response.json: a null sponsorCard must be a VALID answer -- it is what a disabled card, a card outside its schedule and an unrecognised token all return');
}
// A card with no logo is a perfectly good answer -- the logo is optional.
const sponsorCardNoLogo = await overlaySponsorCardFixture();
sponsorCardNoLogo.sponsorCard.logoMimeType = null;
sponsorCardNoLogo.sponsorCard.logoStorageKey = null;
if (!overlaySponsorCardValidator(sponsorCardNoLogo)) {
  failures.push('overlay-sponsor-card-response.json: a sponsor card with no logo must be a valid answer');
}
// Logo fields are all-or-nothing: one present without the other is a
// partial row, not a state.
for (const [field] of [['logoMimeType'], ['logoStorageKey']]) {
  const polluted = await overlaySponsorCardFixture();
  polluted.sponsorCard[field] = null;
  if (overlaySponsorCardValidator(polluted)) {
    failures.push(`overlay-sponsor-card-response.json: ${field} alone set to null (its partner still present) was accepted -- the logo pair must be all-or-nothing`);
  }
}

const channelSponsorCardSchema = await loadSchema('channel-sponsor-card-response.schema.json');
const channelSponsorCardValidator = ajv.getSchema(channelSponsorCardSchema.$id);
async function channelSponsorCardFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, 'channel-sponsor-card-response.json'), 'utf8'));
}
for (const [field, value] of [
  ['impressionCount', 4021], ['exposureCount', 4021], ['viewCount', 4021],
  ['shownAt', '2026-09-17T10:00:00.000Z'], ['displayedAt', '2026-09-17T10:00:00.000Z'],
  ['lastShownAt', '2026-09-17T10:00:00.000Z'], ['durationMs', 5000],
  ['logoUrl', 'https://example.invalid/logo.png'], ['sponsorUrl', 'https://example.invalid'],
]) {
  const polluted = await channelSponsorCardFixture();
  polluted.sponsorCard[field] = value;
  if (channelSponsorCardValidator(polluted)) {
    failures.push(`channel-sponsor-card-response.json: ${field} was accepted -- the Sponsor Card renders the sponsor and counts nothing, and no field may carry a third-party URL`);
  }
}
// Logo and schedule pairs are each all-or-nothing on the creator
// projection too.
for (const field of ['logoContentSha256', 'logoMimeType', 'logoByteSize', 'logoStorageKey']) {
  const polluted = await channelSponsorCardFixture();
  polluted.sponsorCard.logoContentSha256 = 'ab'.repeat(32);
  polluted.sponsorCard.logoMimeType = 'image/png';
  polluted.sponsorCard.logoByteSize = 4096;
  polluted.sponsorCard.logoStorageKey = `x/${'ab'.repeat(32)}`;
  polluted.sponsorCard[field] = null;
  if (channelSponsorCardValidator(polluted)) {
    failures.push(`channel-sponsor-card-response.json: ${field} alone set to null (its logo partners still present) was accepted -- the logo quadruple must be all-or-nothing`);
  }
}
for (const field of ['scheduleStartsAt', 'scheduleEndsAt']) {
  const polluted = await channelSponsorCardFixture();
  polluted.sponsorCard.scheduleStartsAt = '2026-09-17T19:00:00.000Z';
  polluted.sponsorCard.scheduleEndsAt = '2026-09-17T21:00:00.000Z';
  polluted.sponsorCard[field] = null;
  if (channelSponsorCardValidator(polluted)) {
    failures.push(`channel-sponsor-card-response.json: ${field} alone set to null (its schedule partner still present) was accepted -- the schedule pair must be all-or-nothing`);
  }
}
const channelSponsorCardAbsent = await channelSponsorCardFixture();
channelSponsorCardAbsent.sponsorCard = null;
if (!channelSponsorCardValidator(channelSponsorCardAbsent)) {
  failures.push('channel-sponsor-card-response.json: a null sponsorCard must be a VALID answer -- it is what a channel with none configured returns, at every tier');
}
// A scheduled window is a valid state -- an instruction about the future.
const channelSponsorCardScheduled = await channelSponsorCardFixture();
channelSponsorCardScheduled.sponsorCard.scheduleStartsAt = '2026-09-17T19:00:00.000Z';
channelSponsorCardScheduled.sponsorCard.scheduleEndsAt = '2026-09-17T21:00:00.000Z';
if (!channelSponsorCardValidator(channelSponsorCardScheduled)) {
  failures.push('channel-sponsor-card-response.json: a scheduled placement window must be a valid answer');
}
// A card disabled and with no logo at all is a valid answer too.
const channelSponsorCardMinimal = await channelSponsorCardFixture();
channelSponsorCardMinimal.sponsorCard.enabled = false;
channelSponsorCardMinimal.sponsorCard.logoContentSha256 = null;
channelSponsorCardMinimal.sponsorCard.logoMimeType = null;
channelSponsorCardMinimal.sponsorCard.logoByteSize = null;
channelSponsorCardMinimal.sponsorCard.logoStorageKey = null;
if (!channelSponsorCardValidator(channelSponsorCardMinimal)) {
  failures.push('channel-sponsor-card-response.json: a disabled card with no logo must be a valid answer -- the logo and the schedule are both optional');
}

const overlayHypeSchema = await loadSchema('overlay-hype-response.schema.json');
const overlayHypeValidator = ajv.getSchema(overlayHypeSchema.$id);
const hypeWithProviderData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-hype-response.json'), 'utf8'));
hypeWithProviderData.hype.providerToken = 'private-provider-token';
if (overlayHypeValidator(hypeWithProviderData)) {
  failures.push('overlay-hype-response.json: provider field was accepted');
}
const hypeWithInvalidTime = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-hype-response.json'), 'utf8'));
hypeWithInvalidTime.hype.endsAt = 'not-a-time';
if (overlayHypeValidator(hypeWithInvalidTime)) {
  failures.push('overlay-hype-response.json: invalid timestamp was accepted');
}

const overlayLeaderboardSchema = await loadSchema('overlay-leaderboard-response.schema.json');
const overlayLeaderboardValidator = ajv.getSchema(overlayLeaderboardSchema.$id);
const leaderboardWithAmount = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-leaderboard-response.json'), 'utf8'));
leaderboardWithAmount.leaderboard.rows[0].amountPaise = 99999;
if (overlayLeaderboardValidator(leaderboardWithAmount)) {
  failures.push('overlay-leaderboard-response.json: amount field was accepted');
}
const leaderboardWithZeroRank = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-leaderboard-response.json'), 'utf8'));
leaderboardWithZeroRank.leaderboard.rows[0].rank = 0;
if (overlayLeaderboardValidator(leaderboardWithZeroRank)) {
  failures.push('overlay-leaderboard-response.json: zero rank was accepted');
}

const overlayPaidVoteSchema = await loadSchema('overlay-paid-vote-tally-response.schema.json');
const overlayPaidVoteValidator = ajv.getSchema(overlayPaidVoteSchema.$id);
const paidVoteWithRefund = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-paid-vote-tally-response.json'), 'utf8'));
paidVoteWithRefund.tally.refundId = 'private-refund';
if (overlayPaidVoteValidator(paidVoteWithRefund)) {
  failures.push('overlay-paid-vote-tally-response.json: refund field was accepted');
}
const paidVoteWithNegativeAmount = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-paid-vote-tally-response.json'), 'utf8'));
paidVoteWithNegativeAmount.tally.options[0].amountPaise = -1;
if (overlayPaidVoteValidator(paidVoteWithNegativeAmount)) {
  failures.push('overlay-paid-vote-tally-response.json: negative amount was accepted');
}

const tipIntentSchema = await loadSchema('tipintent-resolution.schema.json');
const tipIntentValidator = ajv.getSchema(tipIntentSchema.$id);
const sensitiveClosedIntent = JSON.parse(await fs.readFile(path.join(fixtureDir, 'tipintent-closed.json'), 'utf8'));
sensitiveClosedIntent.amountPaise = 5000;
if (tipIntentValidator(sensitiveClosedIntent)) {
  failures.push('tipintent-closed.json: used/expired response exposed an amount');
}

const confirmationSchema = await loadSchema('tipintent-confirmation-request.schema.json');
const confirmationValidator = ajv.getSchema(confirmationSchema.$id);
const tamperedConfirmation = JSON.parse(await fs.readFile(path.join(fixtureDir, 'tipintent-confirmation-request.json'), 'utf8'));
tamperedConfirmation.amountPaise = 1;
if (confirmationValidator(tamperedConfirmation)) {
  failures.push('tipintent-confirmation-request.json: client-supplied amount was accepted');
}

const publicProfileSchema = await loadSchema('public-profile-response.schema.json');
const publicProfileValidator = ajv.getSchema(publicProfileSchema.$id);
const profileWithFinancialField = JSON.parse(await fs.readFile(path.join(fixtureDir, 'public-profile-response.json'), 'utf8'));
profileWithFinancialField.profile.netLifetimeAmountPaise = '5000';
if (publicProfileValidator(profileWithFinancialField)) {
  failures.push('public-profile-response.json: financial history was accepted in public profile projection');
}
const profileWithInternalIdentifier = JSON.parse(await fs.readFile(path.join(fixtureDir, 'public-profile-response.json'), 'utf8'));
profileWithInternalIdentifier.profile.viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (publicProfileValidator(profileWithInternalIdentifier)) {
  failures.push('public-profile-response.json: immutable viewer account identifier was accepted in public profile projection');
}

const featuredCreatorsSchema = await loadSchema('public-featured-creators.schema.json');
const featuredCreatorsValidator = ajv.getSchema(featuredCreatorsSchema.$id);
const featuredWithInternalIdentifier = JSON.parse(await fs.readFile(path.join(fixtureDir, 'public-featured-creators.json'), 'utf8'));
featuredWithInternalIdentifier.creators[0].channelId = '00000000-0000-4000-8000-000000000011';
if (featuredCreatorsValidator(featuredWithInternalIdentifier)) {
  failures.push('public-featured-creators.json: internal channel identifier was accepted');
}

const publicVoteSchema = await loadSchema('public-vote-response.schema.json');
const publicVoteValidator = ajv.getSchema(publicVoteSchema.$id);
const voteWithIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'public-vote-response.json'), 'utf8'));
voteWithIdentity.viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (publicVoteValidator(voteWithIdentity)) {
  failures.push('public-vote-response.json: voter identity was accepted in public response');
}

const publicStickerSchema = await loadSchema('public-sticker-list.schema.json');
const publicStickerValidator = ajv.getSchema(publicStickerSchema.$id);
const stickerWithInternalMetadata = JSON.parse(await fs.readFile(path.join(fixtureDir, 'public-sticker-list.json'), 'utf8'));
stickerWithInternalMetadata.items[0].byteSize = 4096;
if (publicStickerValidator(stickerWithInternalMetadata)) {
  failures.push('public-sticker-list.json: internal sticker metadata was accepted');
}

const selectionSchema = await loadSchema('public-sticker-selection.schema.json');
const selectionValidator = ajv.getSchema(selectionSchema.$id);
const selectionWithPaymentData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'public-sticker-selection.json'), 'utf8'));
selectionWithPaymentData.orderId = '00000000-0000-4000-8000-000000000223';
if (selectionValidator(selectionWithPaymentData)) {
  failures.push('public-sticker-selection.json: payment order detail was accepted');
}

const viewerSessionSchema = await loadSchema('viewer-auth-session.schema.json');
const viewerSessionValidator = ajv.getSchema(viewerSessionSchema.$id);
const viewerSessionWithIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-auth-session.json'), 'utf8'));
viewerSessionWithIdentity.viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (viewerSessionValidator(viewerSessionWithIdentity)) {
  failures.push('viewer-auth-session.json: account identity was accepted in session response');
}

const resetRequestedSchema = await loadSchema('viewer-password-reset-requested.schema.json');
const resetRequestedValidator = ajv.getSchema(resetRequestedSchema.$id);
const resetRequestedWithEmail = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-password-reset-requested.json'), 'utf8'));
resetRequestedWithEmail.email = 'viewer@example.invalid';
if (resetRequestedValidator(resetRequestedWithEmail)) {
  failures.push('viewer-password-reset-requested.json: email was accepted in enumeration-safe response');
}

const resetResponseSchema = await loadSchema('viewer-password-reset-response.schema.json');
const resetResponseValidator = ajv.getSchema(resetResponseSchema.$id);
const resetResponseWithToken = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-password-reset-response.json'), 'utf8'));
resetResponseWithToken.accessToken = 'synthetic-viewer-session-token-with-at-least-32-characters';
if (resetResponseValidator(resetResponseWithToken)) {
  failures.push('viewer-password-reset-response.json: access token was accepted after password reset');
}

const viewerSessionListSchema = await loadSchema('viewer-session-list.schema.json');
const viewerSessionListValidator = ajv.getSchema(viewerSessionListSchema.$id);
const viewerSessionListWithIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-session-list.json'), 'utf8'));
viewerSessionListWithIdentity.sessions[0].viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (viewerSessionListValidator(viewerSessionListWithIdentity)) {
  failures.push('viewer-session-list.json: account identity was accepted in session list');
}

const viewerDashboardSchema = await loadSchema('viewer-dashboard-response.schema.json');
const viewerDashboardValidator = ajv.getSchema(viewerDashboardSchema.$id);
const dashboardWithAccountIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-dashboard-response.json'), 'utf8'));
dashboardWithAccountIdentity.supportedChannels[0].viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (viewerDashboardValidator(dashboardWithAccountIdentity)) {
  failures.push('viewer-dashboard-response.json: account identity was accepted in dashboard response');
}
const dashboardWithPaymentIdentifier = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-dashboard-response.json'), 'utf8'));
dashboardWithPaymentIdentifier.supportedChannels[0].paymentId = '00000000-0000-4000-8000-0000000000d1';
if (viewerDashboardValidator(dashboardWithPaymentIdentifier)) {
  failures.push('viewer-dashboard-response.json: payment identifier was accepted in dashboard response');
}
const dashboardWithProviderIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-dashboard-response.json'), 'utf8'));
dashboardWithProviderIdentity.supportedChannels[0].providerUserId = 'synthetic-provider-identity';
if (viewerDashboardValidator(dashboardWithProviderIdentity)) {
  failures.push('viewer-dashboard-response.json: provider identity was accepted in dashboard response');
}

const viewerBadgesSchema = await loadSchema('viewer-channel-badges-response.schema.json');
const viewerBadgesValidator = ajv.getSchema(viewerBadgesSchema.$id);
const badgesWithAccountIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-channel-badges-response.json'), 'utf8'));
badgesWithAccountIdentity.badges.viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (viewerBadgesValidator(badgesWithAccountIdentity)) {
  failures.push('viewer-channel-badges-response.json: account identity was accepted in badges response');
}
const badgesWithPaymentIdentifier = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-channel-badges-response.json'), 'utf8'));
badgesWithPaymentIdentifier.badges.paymentId = '00000000-0000-4000-8000-000000000d01';
if (viewerBadgesValidator(badgesWithPaymentIdentifier)) {
  failures.push('viewer-channel-badges-response.json: payment identifier was accepted in badges response');
}
const badgesWithProviderIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-channel-badges-response.json'), 'utf8'));
badgesWithProviderIdentity.badges.providerUserId = 'private-provider-id';
if (viewerBadgesValidator(badgesWithProviderIdentity)) {
  failures.push('viewer-channel-badges-response.json: provider identity was accepted in badges response');
}

const visibilitySchema = await loadSchema('viewer-profile-visibility-response.schema.json');
const visibilityValidator = ajv.getSchema(visibilitySchema.$id);
const visibilityWithAccountIdentity = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-profile-visibility-response.json'), 'utf8'));
visibilityWithAccountIdentity.viewerAccountId = '00000000-0000-4000-8000-0000000000a1';
if (visibilityValidator(visibilityWithAccountIdentity)) {
  failures.push('viewer-profile-visibility-response.json: account identity was accepted');
}
const contradictoryPrivateVisibility = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-profile-visibility-response.json'), 'utf8'));
contradictoryPrivateVisibility.visibility = 'private';
if (visibilityValidator(contradictoryPrivateVisibility)) {
  failures.push('viewer-profile-visibility-response.json: private visibility accepted a public slug');
}

const viewerDeletionSchema = await loadSchema('viewer-deletion-response.schema.json');
const viewerDeletionValidator = ajv.getSchema(viewerDeletionSchema.$id);
const viewerDeletionWithToken = JSON.parse(await fs.readFile(path.join(fixtureDir, 'viewer-deletion-response.json'), 'utf8'));
viewerDeletionWithToken.accessToken = 'synthetic-redacted-viewer-session-token-0001';
if (viewerDeletionValidator(viewerDeletionWithToken)) {
  failures.push('viewer-deletion-response.json: access token was accepted in deletion disclosure');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${Object.keys(fixtureToSchema).length} fixtures plus the v1 template catalogue contract with Draft 2020-12, format enforcement and v1 capability exclusion (including invalid-UUID rejection).`);
}
