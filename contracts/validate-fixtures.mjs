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

// PRF-02 slice 5, catalogue module #12 (Moderator Status Card, held half
// only). §6 requires "never private content" on this surface and the
// owner's 2026-09-16 decision requires it to be a property of the query
// rather than of the renderer -- migration 0136's function returns a
// single held_count column. These negative cases are the CONTRACT's own
// half of that guarantee: the published response schema must refuse every
// private field outright, so a future server change cannot introduce one
// without a visible, reviewable contract change.
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
// Safe mode is NOT alert_queues.is_paused (owner decision, 2026-09-16).
// It is a separate moderation control that does not exist in the schema
// and needs its own record and decision, so no contract may carry a field
// for it -- including one that merely looks like it.
for (const field of ['safeMode', 'isPaused', 'paused']) {
  const withSafeMode = JSON.parse(await fs.readFile(path.join(fixtureDir, 'overlay-moderator-status-response.json'), 'utf8'));
  withSafeMode.moderatorStatus[field] = true;
  if (overlayModeratorStatusValidator(withSafeMode)) {
    failures.push(`overlay-moderator-status-response.json: ${field} was accepted -- safe mode is not built and must not appear in any contract`);
  }
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
if (!overlayModeratorStatusValidator(moderatorStatusZero)) {
  failures.push('overlay-moderator-status-response.json: heldCount 0 must be a VALID answer -- a recognised overlay token with nothing held returns zero, which is different from an unrecognised token returning null');
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
