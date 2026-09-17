'use client';

/*
 * PRF-02: the Master Canvas host page — the new OBS browser-source URL
 * (`/overlay/canvas/{overlayId}#token=...`) a creator points OBS at
 * instead of the individual widget sources. Slice 1 mounted two modules
 * (Supporter Ticker, Community Goal Ladder); slice 2 adds two more
 * (Tug-of-War Vote, Boss Fight); slice 3 adds Support Theater — all FIVE
 * on the SAME ONE shared connection and ONE shared scheduler — see
 * master-canvas-connection.ts and master-canvas-runtime.ts for where
 * those properties actually live, and master-canvas-integration.test.ts
 * for the five-modules-still-one-connection/one-loop proof. This file
 * only wires DOM containers and
 * REST snapshot endpoints to them: the two slice-1 endpoints
 * (`/v1/overlay-widgets/:overlayId/supporter-ticker`,
 * `/v1/overlay-goals/:overlayId` — untouched), one new endpoint
 * (`/v1/overlay-widgets/:overlayId/tug-of-war-vote`), and Boss Fight
 * reusing the SAME goal endpoint/fetch function the goal ladder uses —
 * no second progress computation (this task's §1(c)).
 *
 * ENTITLEMENT (§30.3, this task's §3): which of the two built modules is
 * actually active for this overlay is read once from the new
 * `/v1/overlay-widgets/:overlayId/master-canvas/modules` endpoint. A
 * module the server does not return is never activated — the runtime
 * never subscribes it to the connection, never fetches its snapshot,
 * never renders it (PRF-02.10). The server, not this page, owns the cap.
 *
 * KILL SWITCH: this page is additive. Every existing standalone widget
 * route (apps/web/app/overlay/widgets/*) is untouched and fully
 * functional — a creator who wants out of the Canvas removes this source
 * from OBS and re-adds the individual widget sources, no data migration
 * needed (see active/tasks/PRF-02.md).
 *
 * WATERMARK (§30.6, out of scope for this task, but left possible per
 * this task's explicit instruction not to make it impossible): the
 * protected top layer belongs OUTSIDE the module registry entirely, as a
 * sibling element rendered after (so visually on top of) the module
 * containers below, with its own fixed z-index and no dependency on any
 * module's error-boundary state — it is not added here because §30.6 is
 * out of scope, but nothing in this page's structure blocks adding it.
 *
 * PRF-02 SLICE 3 — SUPPORT THEATER SHARES THIS CANVAS'S ONE SESSION,
 * CORRECTED 2026-09-16: an earlier version of this slice gave Support
 * Theater a SECOND, dedicated overlay session (`stOverlayId`/`stToken`
 * hash params) on the theory that acknowledgement being session-bound
 * (migration 0022's `ack_overlay_cursor`) meant any shared session would
 * race. That was a literal reading of an instruction whose actual intent
 * was narrower — see `reviews/2026-09-16-prf-02-slice-3-implementation.md`'s
 * "Correction" section for the full account, attributed there to the
 * coordinator, not this implementer's own revision. Inside ONE Canvas
 * there is exactly one acknowledging consumer (Support Theater); the
 * other four modules are stateless snapshot readers that never call
 * `/cursor`, so there is no session-sharing race *inside* a Canvas to
 * defend against. The real race the original scope review found is
 * between this Canvas and the SEPARATE standalone page
 * (`../../[overlayId]/page.tsx`) — which already has its own, different
 * session, because it is a different browser source with its own session
 * token by construction. So Support Theater now registers with the SAME
 * `overlayId`/`token`/`connection` every other module here uses — see
 * `master-canvas-connection.ts`'s own header for how that shared
 * connection was extended (an event-payload subscription and an
 * `acknowledge()` method alongside its existing signal-only design) to
 * make this safe without a second session. `BUILT_MODULE_KEYS` lists
 * `support_theater` FIRST, and it is registered/entitled first below, so
 * its event-payload subscription always attaches before any snapshot
 * module can start the shared stream without one — see the connection
 * file's own header for why that ordering matters for a correct replay
 * cursor and for keeping this the ordinary case, not the forced-resync
 * backstop case.
 *
 * A SAME-SESSION MISMATCH WITH THE STANDALONE PAGE IS NOT DETECTED HERE,
 * AND THAT IS STATED RATHER THAN LEFT IMPLICIT: this page's own
 * JavaScript has no way to observe what session a *different* OBS browser
 * source (the standalone page, in its own separate process) happens to be
 * configured with. Building a server-side signal for that would be an
 * L3 API/data change, outside this task's authority — recorded as a
 * referred item rather than guessed at with a client-side heuristic that
 * cannot actually see the other consumer.
 *
 * PRF-02 SLICE 4 — CHALLENGE BOARD (CURRENT-ONLY) AND MILESTONE
 * CELEBRATION: modules six and seven, neither adding an endpoint, a
 * query, or an event. Challenge Board reads the existing
 * `/v1/overlay-challenges/:overlayId` snapshot (the SAME endpoint the
 * standalone challenge widget already reads) and renders exactly the
 * single current challenge that endpoint returns — no "next"/"completed"
 * exists in this slice, matching the data path
 * (`app_private.list_overlay_challenge`, migration 0109, `limit 1`).
 * Milestone Celebration is handed `fetchGoalSnapshot`/
 * `fetchTugOfWarVoteSnapshot` BY REFERENCE — the SAME functions already
 * passed to the goal/vote modules above — so there is no second source of
 * truth for either field, only a second, independent read of the same
 * one. It is deliberately NOT wired to Support Theater's
 * `subscribeToEvents`/`acknowledge` stream (that would be the transport
 * mistake slice 3's Correction warns against); it uses the same plain
 * `connection.subscribe()` signal every other snapshot module already
 * uses. See `modules/challenge-board-module.ts` and
 * `modules/milestone-celebration-module.ts` for the full reasoning.
 *
 * PRF-02 SLICE 5 — STREAM MISSION CARD (§6 #9): module eight, and the
 * first since slice 1 to add an endpoint of its own
 * (`/v1/overlay-widgets/:overlayId/stream-mission`, migration 0135) —
 * because unlike every module slices 2–4 built, #9's data did not exist
 * anywhere in the schema. It is nevertheless an ordinary snapshot module
 * here: the SAME shared `connection` and the SAME shared runtime, one more
 * `fetch` closure, zero new sessions and zero new transports. The owner's
 * 2026-09-16 decision on §6's module table row 9 makes the mission
 * SESSION-bounded, not clock-bounded — so nothing below passes it a
 * duration, an end time or an expiry, and the card's visibility is decided
 * solely by whether the endpoint still returns a mission. The elapsed
 * reading the card paints is derived by the module from the server-sent
 * `startedAt` on the shared frame loop; see
 * `modules/stream-mission-module.ts` for why that is a reading and not a
 * timer.
 *
 * PRF-02 SLICE 6 — REACTION CLOUD (§6 #5) AND PRF-06: module ten, on the
 * SAME one connection and the SAME one rAF loop as the nine before it.
 * A reaction is a send of an entry that ALREADY EXISTS in the curated
 * sticker catalogue (owner decision, 2026-09-16), so this page gains no
 * asset path, no upload surface and no moderation surface — only one more
 * snapshot `fetch` closure.
 *
 * The property that matters most on this page is a NEGATIVE one: there is
 * no sampling here. §19.5 requires reactions to be "sampled and
 * rate-limited server-side before they reach the canvas", so the endpoint
 * returns rows that are already `count(*)` per catalogue entry and already
 * capped by the configured display ceiling inside
 * `app_private.list_overlay_reaction_cloud` (migration 0139). Neither this
 * file nor `modules/reaction-cloud-module.ts` caps, slices or thins
 * anything — if a cap belongs anywhere it belongs in
 * `REACTION_CLOUD_SAMPLE_MAX`, which ships configured but unset.
 *
 * PRF-02 SLICE 6 - LOBBY STATUS (§6 #16): module eleven, on the SAME one
 * connection and the SAME one rAF loop as the ten before it. It is the
 * second module in this slice to add an endpoint of its own
 * (`/v1/overlay-widgets/:overlayId/lobby-status`, migration 0140), because
 * like #9 and #5 its data did not exist anywhere in the schema.
 *
 * The property that matters most here is also a NEGATIVE one, and it is
 * §16's own sentence: the public overlay shows "aggregate status only:
 * '8/16 seats confirmed', queue count ... Never player identifiers, never
 * Discord names, never codes or passwords." So this page gains one more
 * snapshot `fetch` closure and nothing else - no room code, no password,
 * no seat token, no player list, no initials and no avatars reach it,
 * because the read returns three integers and the schema behind it has no
 * column for any of them. Opted-in initials and avatars are permitted by
 * §16 but are OUT OF SCOPE (owner decision, 2026-09-16): they need an
 * opt-in mechanism that does not exist, and nothing here approximates one.
 *
 * The §30.3 Creator+/Events Pack entitlement for this module is NOT
 * checked on this page either. It lives inside
 * `app_private.list_overlay_lobby_status`, so an unentitled channel's
 * valid token simply returns null and the card paints nothing - the same
 * nothing a channel with no open lobby paints.
 *
 * PRF-02 SLICE 6 - GIVEAWAY / TOURNAMENT (§6 #17): module twelve, on the
 * SAME one connection and the SAME one rAF loop as the eleven before it.
 * It is the third module in this slice to add an endpoint of its own
 * (`/v1/overlay-widgets/:overlayId/giveaway-tournament`, migration 0142),
 * and it is the first to USE the shared rAF loop for something other than
 * a snapshot diff: the entry window's countdown ticks on the runtime's
 * existing per-frame render() call rather than on a timer of its own,
 * which is exactly what one shared loop is for.
 *
 * The properties that matter most here are NEGATIVE ones, and none was
 * decided by this page. NO CHANCE MECHANIC of any kind ships (§17.1,
 * decided 2026-09-13; GIV-07 gates chance-based formats on a legal review
 * that has not happened and stays Blocked). NO WINNER is rendered -
 * announcing one needs the consent §17.1 requires and this schema has no
 * mechanism for, a winner is a participant identifier on an
 * aggregate-only path, and nothing could produce one in the first place.
 * NO PRIZE, ESCROW, DELIVERY STATE, ADDRESS OR CLAIM LINK exists anywhere
 * on this path: BharatStudio never holds, escrows, ships or guarantees a
 * prize, and the creator is the promoter. NO BRACKET TREE either - a tree
 * needs participant labels, which §16 already ruled need an opt-in
 * mechanism that does not exist, so the card paints bracket PROGRESS. So
 * this page gains one more snapshot `fetch` closure and nothing else.
 *
 * The §30.3 Creator+/Events Pack entitlement for this module is NOT
 * checked on this page either. It is 0140's own
 * `app_private.events_pack_entitled`, called from inside
 * `app_private.list_overlay_giveaway_tournament` rather than
 * reimplemented, so an unentitled channel's valid token simply returns
 * null and the card paints nothing.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../lib/api-origin';
import { createMasterCanvasConnection } from '../master-canvas-connection';
import { createDocumentVisibilitySource, createMasterCanvasRuntime } from '../master-canvas-runtime';
import { createSupporterTickerModule, type SupporterTickerEntry } from '../modules/supporter-ticker-module';
import { createGoalLadderModule } from '../modules/goal-ladder-module';
import { createTugOfWarVoteModule } from '../modules/tug-of-war-vote-module';
import { createBossFightModule } from '../modules/boss-fight-module';
import { createSupportTheaterModule } from '../modules/support-theater-module';
import { createChallengeBoardModule } from '../modules/challenge-board-module';
import { createMilestoneCelebrationModule } from '../modules/milestone-celebration-module';
import { createStreamMissionModule, isStreamMission, type StreamMission } from '../modules/stream-mission-module';
import { createModeratorStatusModule } from '../modules/moderator-status-module';
import { isModeratorStatus, type ModeratorStatus } from '../modules/moderator-status-logic';
import { createReactionCloudModule } from '../modules/reaction-cloud-module';
import { isReactionCloud, type ReactionCloudEntry } from '../modules/reaction-cloud-logic';
import { createLobbyStatusModule } from '../modules/lobby-status-module';
import { isLobbyStatus, type LobbyStatus } from '../modules/lobby-status-logic';
import { createGiveawayTournamentModule } from '../modules/giveaway-tournament-module';
import { isGiveawayTournamentState, type GiveawayTournamentState } from '../modules/giveaway-tournament-logic';
import { createQrSmartCardModule } from '../modules/qr-smart-card-module';
import { isOverlayQrSmartCard, type OverlayQrSmartCard } from '../modules/qr-smart-card-logic';
import { isTugOfWarVoteTally, type TugOfWarVoteTally } from '../modules/tug-of-war-vote-logic';
import { isSupporterTicker } from '../../widgets/l16-widget-data';
import { isOverlayGoal, type OverlayGoal } from '../../widgets/goal/goal-widget-logic';
import { isOverlayChallenge, type OverlayChallenge } from '../../widgets/challenge/challenge-widget-logic';

// support_theater is listed FIRST deliberately — see this file's header,
// "BUILT_MODULE_KEYS lists support_theater FIRST" — so its event-payload
// subscription to the shared connection always attaches before any
// snapshot module can start the stream without one. challenge_board and
// milestone_celebration (slice 4) are appended at the end — both are
// plain snapshot modules like the four already there, so their position
// relative to each other and to the four snapshot modules carries no
// ordering requirement, only Support Theater's first position matters.
const BUILT_MODULE_KEYS = [
  'support_theater', 'supporter_ticker', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
  'challenge_board', 'milestone_celebration', 'stream_mission_card',
  // PRF-02 slice 5, §6 #12 (held half only). A plain snapshot module
  // like the rest, so its position here carries no ordering
  // requirement -- only Support Theater's first position matters.
  'moderator_status_card',
  // PRF-02 slice 6 / PRF-06, §6 #5 (Reaction Cloud). Also a plain
  // snapshot module -- no ordering requirement.
  'reaction_cloud',
  // PRF-02 slice 6, §6 #16 (Lobby Status). Also a plain snapshot module --
  // no ordering requirement.
  'lobby_status',
  // PRF-02 slice 6, §6 #17 (Giveaway / Tournament Card). A snapshot
  // module with no ordering requirement either -- its one difference is
  // that its countdown ticks on the SHARED rAF loop rather than on a
  // timer of its own.
  'giveaway_tournament_card',
  // PRF-02 slice 7, §6 #10 (QR Smart Card). A plain snapshot module --
  // no ordering requirement. Its "toggle" is the read itself: the
  // overlay endpoint returns a row only when the creator's card is
  // enabled (migration 0144), so there is no second enabled/disabled
  // branch on this page either.
  'qr_smart_card',
] as const;

function reducedMotionPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export default function MasterCanvasPage() {
  const params = useParams<{ overlayId: string }>();
  const tickerContainerRef = useRef<HTMLDivElement>(null);
  const goalContainerRef = useRef<HTMLDivElement>(null);
  const voteContainerRef = useRef<HTMLDivElement>(null);
  const bossFightContainerRef = useRef<HTMLDivElement>(null);
  const supportTheaterContainerRef = useRef<HTMLDivElement>(null);
  const challengeContainerRef = useRef<HTMLDivElement>(null);
  const milestoneContainerRef = useRef<HTMLDivElement>(null);
  const missionContainerRef = useRef<HTMLDivElement>(null);
  const moderatorStatusContainerRef = useRef<HTMLDivElement>(null);
  const reactionCloudContainerRef = useRef<HTMLDivElement>(null);
  const lobbyStatusContainerRef = useRef<HTMLDivElement>(null);
  const giveawayTournamentContainerRef = useRef<HTMLDivElement>(null);
  const qrSmartCardContainerRef = useRef<HTMLDivElement>(null);
  const [downModules, setDownModules] = useState<string[]>([]);

  useEffect(() => {
    document.documentElement.classList.add('browser-overlay-document');
    document.body.classList.add('browser-overlay-document');
    const removeDocumentClasses = () => {
      document.documentElement.classList.remove('browser-overlay-document');
      document.body.classList.remove('browser-overlay-document');
    };

    const overlayId = params.overlayId;
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!overlayId || !token) return removeDocumentClasses;

    let apiOrigin: string;
    try {
      apiOrigin = getApiOrigin();
    } catch {
      return removeDocumentClasses;
    }

    let cancelled = false;
    const connection = createMasterCanvasConnection({ overlayId, token, apiOrigin });
    const runtime = createMasterCanvasRuntime({
      visibilitySource: createDocumentVisibilitySource(document),
      onModuleDown: (moduleKey) => {
        if (cancelled) return;
        setDownModules((previous) => (previous.includes(moduleKey) ? previous : [...previous, moduleKey]));
      },
    });

    async function fetchTickerSnapshot(): Promise<SupporterTickerEntry[] | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/supporter-ticker`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { entries?: unknown };
      return isSupporterTicker(body.entries) ? body.entries : null;
    }

    async function fetchGoalSnapshot(): Promise<OverlayGoal | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-goals/${encodeURIComponent(overlayId)}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { goal?: unknown };
      return isOverlayGoal(body.goal) ? body.goal : null;
    }

    // Boss Fight (§6 #4) is explicitly "a visual skin over an ordinary
    // support goal — not a new mechanic" (this task's §1(c)): it reads
    // the SAME /v1/overlay-goals endpoint and the SAME OverlayGoal shape
    // as the Community Goal Ladder above — fetchGoalSnapshot is reused
    // verbatim, not duplicated, so there is structurally only one
    // progress computation in this file too.

    async function fetchTugOfWarVoteSnapshot(): Promise<TugOfWarVoteTally | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/tug-of-war-vote`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { tally?: unknown };
      return isTugOfWarVoteTally(body.tally) ? body.tally : null;
    }

    // Challenge Board (§6 #8, current-only this slice): the SAME
    // `/v1/overlay-challenges/:overlayId` endpoint and OverlayChallenge
    // shape the standalone challenge widget
    // (../../widgets/challenge/[overlayId]/page.tsx) already reads — no
    // new endpoint, no new query.
    async function fetchChallengeSnapshot(): Promise<OverlayChallenge | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-challenges/${encodeURIComponent(overlayId)}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { challenge?: unknown };
      return isOverlayChallenge(body.challenge) ? body.challenge : null;
    }

    // Stream Mission Card (§6 #9, PRF-02 slice 5): the one endpoint this
    // slice added. Three fields come back — missionId, objective,
    // startedAt — and deliberately no end time, duration or expiry: the
    // mission is session-bounded, not clock-bounded (owner decision,
    // §6 module table row 9, 2026-09-16).
    async function fetchStreamMissionSnapshot(): Promise<StreamMission | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/stream-mission`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { mission?: unknown };
      return isStreamMission(body.mission) ? body.mission : null;
    }

    // Moderator Status Card (§6 #12). The response carries a COUNT and a
    // BOOLEAN and nothing else -- no supporter name, message, amount,
    // delivery id, queue id or viewer identifier exists on this path at
    // all, because app_private.list_overlay_moderator_status (migration
    // 0138) returns exactly those two columns. `isModeratorStatus` is
    // the client's own last-line check on top of that, not the guarantee
    // itself.
    //
    // `safeMode` is the creator's own per-channel switch (owner
    // decision, 2026-09-16): while it is on, incoming alerts route to
    // `held` instead of `ready`. It is never automatic, and it is NOT
    // alert_queues.is_paused. This page only READS it -- turning it on
    // and off is the creator's session-authenticated surface, never an
    // overlay browser-source token's.
    //
    // `moderatorStatus: null` means the read did not answer (an
    // unrecognised/expired/revoked token); `heldCount: 0, safeMode:
    // false` means it answered, nothing is held and safe mode is off.
    // The module renders the same nothing for both, but the distinction
    // is real and is preserved end to end.
    async function fetchModeratorStatusSnapshot(): Promise<ModeratorStatus | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/moderator-status`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { moderatorStatus?: unknown };
      return isModeratorStatus(body.moderatorStatus) ? body.moderatorStatus : null;
    }

    // Reaction Cloud (§6 #5, PRF-02 slice 6 / PRF-06). The second endpoint
    // this slice adds. What comes back is ALREADY the server-side sample:
    // app_private.list_overlay_reaction_cloud (migration 0139) aggregates
    // every reaction into one row per curated-catalogue entry and applies
    // the configured display ceiling as its own SQL LIMIT. So there is
    // deliberately no cap, slice or thinning here or in the module --
    // §19.5 requires that the client never receive the full stream and
    // then drop some of it, and the absence of client-side sampling is
    // what makes that checkable rather than merely claimed.
    //
    // Each entry carries a catalogue entry id, that entry's already-public
    // display name and a count -- no viewer id, anonymous identity token,
    // session id, IP or timestamp exists on this path at all, because the
    // function returns four columns. `isReactionCloud` is the client's own
    // last-line check on top of that, not the guarantee itself.
    async function fetchReactionCloudSnapshot(): Promise<ReactionCloudEntry[] | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/reaction-cloud`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { entries?: unknown };
      return isReactionCloud(body.entries) ? body.entries : null;
    }

    // Lobby Status Card (§6 #16, PRF-02 slice 6). The response carries
    // THREE INTEGERS and nothing else -- no room code, no password, no
    // seat token, no player identifier, no in-game name, no Discord name,
    // no viewer id, no anonymous identity and no session id exists on this
    // path at all, because app_private.list_overlay_lobby_status
    // (migration 0140) returns exactly seat_count, confirmed_seat_count
    // and queue_count. §16 states that as a rule for the overlay; the
    // owner's 2026-09-16 decision makes it a property of the query rather
    // than of the renderer. `isLobbyStatus` is the client's own last-line
    // check on top of that, not the guarantee itself.
    //
    // `lobbyStatus: null` is every "nothing to paint" case at once: an
    // unrecognised, expired, revoked or foreign token; a channel with no
    // open lobby; and a channel without the §30.3 Creator+/Events Pack
    // entitlement, which is checked inside the SQL function rather than
    // here. The card renders the same nothing for all of them.
    async function fetchLobbyStatusSnapshot(): Promise<LobbyStatus | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/lobby-status`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { lobbyStatus?: unknown };
      return isLobbyStatus(body.lobbyStatus) ? body.lobbyStatus : null;
    }

    // Giveaway / Tournament Card (§6 #17, PRF-02 slice 6). The response
    // carries SIX AGGREGATE VALUES and nothing else -- no participant
    // identifier, no in-game name, no Discord name, no viewer id, no
    // anonymous identity, no session id, no postal field and no contact
    // detail exists on this path at all, because
    // app_private.list_overlay_giveaway_tournament (migration 0142)
    // returns exactly an entry count, an entry-window close instant and
    // four bracket-progress numbers.
    //
    // AND NO WINNER, WHICH IS THE CORRECT CONCLUSION RATHER THAN AN
    // OMISSION. §17.1 permits a winner announcement only WITH CONSENT and
    // no consent mechanism exists in this schema; a winner is a
    // participant identifier; and nothing could produce one, because the
    // mechanic is not built (§17.1, decided 2026-09-13; GIV-07 stays
    // Blocked) and "the creator records who won" is an invented surface
    // the owner's 2026-09-16 decision names outright. No prize, escrow,
    // delivery state, address or claim link reaches this page either --
    // BharatStudio never holds, escrows, ships or guarantees a prize.
    //
    // `giveawayTournament: null` is every "nothing to paint" case at once:
    // an unrecognised, expired, revoked or foreign token; a channel with
    // neither a giveaway open nor a tournament running; a concluded
    // tournament; and a channel without the §30.3 Creator+/Events Pack
    // entitlement, which is checked inside the SQL function rather than
    // here. The card renders the same nothing for all of them.
    async function fetchGiveawayTournamentSnapshot(): Promise<GiveawayTournamentState | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/giveaway-tournament`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { giveawayTournament?: unknown };
      return isGiveawayTournamentState(body.giveawayTournament) ? body.giveawayTournament : null;
    }

    // QR Smart Card (§6 #10, PRF-02 slice 7). The response carries TWO
    // STRINGS and nothing else -- no scan count, view count, impression
    // count, exposure count or card id exists on this path at all,
    // because app_private.list_overlay_qr_smart_card (migration 0144)
    // returns exactly destination and label. `isOverlayQrSmartCard` is
    // the client's own last-line check on top of that, not the
    // guarantee itself.
    //
    // `qrSmartCard: null` is every "nothing to paint" case at once: an
    // unrecognised, expired, revoked or foreign token, a channel that
    // has never configured a card, AND a channel whose card is
    // configured but disabled -- the single toggle the owner decision
    // names is enforced by the read itself (migration 0144's
    // `where is_enabled`), not by a second field this page would have to
    // branch on.
    async function fetchQrSmartCardSnapshot(): Promise<OverlayQrSmartCard | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/qr-smart-card`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { qrSmartCard?: unknown };
      return isOverlayQrSmartCard(body.qrSmartCard) ? body.qrSmartCard : null;
    }

    // Support Theater registers FIRST — see this file's header — using the
    // SAME shared `connection`/`overlayId`/`token` as every other module,
    // never a second session.
    if (supportTheaterContainerRef.current) {
      runtime.registerModule(createSupportTheaterModule({
        container: supportTheaterContainerRef.current,
        connection,
        overlayId,
        token,
        apiOrigin,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (tickerContainerRef.current) {
      runtime.registerModule(createSupporterTickerModule({
        container: tickerContainerRef.current,
        connection,
        fetchSnapshot: fetchTickerSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (goalContainerRef.current) {
      runtime.registerModule(createGoalLadderModule({
        container: goalContainerRef.current,
        connection,
        fetchSnapshot: fetchGoalSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (voteContainerRef.current) {
      runtime.registerModule(createTugOfWarVoteModule({
        container: voteContainerRef.current,
        connection,
        fetchSnapshot: fetchTugOfWarVoteSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (bossFightContainerRef.current) {
      runtime.registerModule(createBossFightModule({
        container: bossFightContainerRef.current,
        connection,
        fetchSnapshot: fetchGoalSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (challengeContainerRef.current) {
      runtime.registerModule(createChallengeBoardModule({
        container: challengeContainerRef.current,
        connection,
        fetchSnapshot: fetchChallengeSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (milestoneContainerRef.current) {
      // Milestone Celebration (§6 #13): the SAME fetchGoalSnapshot/
      // fetchTugOfWarVoteSnapshot functions above, passed by reference —
      // no second source of truth for goal.reached or the vote's
      // resolved, only a second, independent read of the same one. See
      // this file's header and milestone-celebration-module.ts for why
      // it is never wired to Support Theater's event-payload stream.
      runtime.registerModule(createMilestoneCelebrationModule({
        container: milestoneContainerRef.current,
        connection,
        fetchGoalSnapshot,
        fetchVoteSnapshot: fetchTugOfWarVoteSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (missionContainerRef.current) {
      runtime.registerModule(createStreamMissionModule({
        container: missionContainerRef.current,
        connection,
        fetchSnapshot: fetchStreamMissionSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (moderatorStatusContainerRef.current) {
      // Moderator Status Card (§6 #12). One plain snapshot module on the
      // SAME shared `connection` and the SAME shared rAF loop -- no
      // second session, no second transport, no timer of its own. Safe
      // mode added a FIELD to its existing snapshot, never a second
      // endpoint, a second read or a second subscription.
      //
      // The snapshot returns a count and a boolean and nothing else
      // (migration 0138; §6's "never private content" is a property of
      // that query, not of this renderer).
      runtime.registerModule(createModeratorStatusModule({
        container: moderatorStatusContainerRef.current,
        connection,
        fetchSnapshot: fetchModeratorStatusSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (reactionCloudContainerRef.current) {
      // Reaction Cloud (§6 #5). One more plain snapshot module on the
      // SAME shared `connection` and the SAME shared rAF loop -- no
      // second session, no second transport, no timer of its own.
      //
      // Sampling and rate limiting both happen on the server (§19.5,
      // PRF-06): the read is aggregated and capped by the configured
      // display ceiling inside migration 0139's function, and the send
      // path is rate-limited by the creator's own per-channel
      // rateLimitPerMinute against a one-minute window. Nothing on this
      // page samples, caps or limits anything, and nothing here should
      // start to.
      runtime.registerModule(createReactionCloudModule({
        container: reactionCloudContainerRef.current,
        connection,
        fetchSnapshot: fetchReactionCloudSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (lobbyStatusContainerRef.current) {
      // Lobby Status Card (§6 #16). One more plain snapshot module on the
      // SAME shared `connection` and the SAME shared rAF loop -- no second
      // session, no second transport, no timer of its own.
      //
      // Nothing about the Lobby Engine is wired here and nothing may be:
      // no ready check, no seat token, no room-code reveal, no no-show
      // promotion, no selection policy and no audit log (§16.1 steps 4-8,
      // §16.2). Those are Phase 3. This module paints three numbers.
      runtime.registerModule(createLobbyStatusModule({
        container: lobbyStatusContainerRef.current,
        connection,
        fetchSnapshot: fetchLobbyStatusSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (giveawayTournamentContainerRef.current) {
      // Giveaway / Tournament Card (§6 #17). One more snapshot module on
      // the SAME shared `connection` and the SAME shared rAF loop -- no
      // second session, no second transport, and no timer of its own: the
      // entry-window countdown ticks on the runtime's existing per-frame
      // render() call, which is exactly what that one loop is for.
      //
      // Nothing about the rest of §17 is wired here and nothing may be: no
      // mechanic, no seed, no odds, no weighting, no result, no prize, no
      // escrow, no delivery state, no claim flow, no entrant list, no
      // seeding, no check-in, no score reporting, no dispute note and no
      // sponsor slot. This module paints an entry count, a countdown and
      // four bracket-progress numbers.
      runtime.registerModule(createGiveawayTournamentModule({
        container: giveawayTournamentContainerRef.current,
        connection,
        fetchSnapshot: fetchGiveawayTournamentSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (qrSmartCardContainerRef.current) {
      // QR Smart Card (§6 #10). One more plain snapshot module on the
      // SAME shared `connection` and the SAME shared rAF loop -- no
      // second session, no second transport, no timer of its own.
      //
      // The QR code image is generated first-party by
      // modules/qr-smart-card-logic.ts (§9.1.1: no third-party QR
      // library, no remote QR-image service). Nothing about scenes,
      // CMP-17, a destination allow-list, link shortening or scan
      // counting is wired here and nothing may be -- the owner's
      // 2026-09-17 decision is "one destination, one label, one toggle.
      // That is the entire feature," and this module paints exactly
      // that.
      runtime.registerModule(createQrSmartCardModule({
        container: qrSmartCardContainerRef.current,
        connection,
        fetchSnapshot: fetchQrSmartCardSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    (async () => {
      try {
        const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/master-canvas/modules`, {
          headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
        });
        if (!response.ok || cancelled) return;
        const body = await response.json() as { moduleKeys?: unknown };
        const active = new Set(Array.isArray(body.moduleKeys) ? body.moduleKeys : []);
        for (const key of BUILT_MODULE_KEYS) runtime.setModuleEntitled(key, active.has(key));
      } catch {
        // Entitlement read failed — both built modules stay un-entitled
        // (the runtime's own default), never activated. Never guess a
        // module is active when the server hasn't confirmed it.
      }
    })();

    runtime.start();

    return () => {
      cancelled = true;
      runtime.stop();
      removeDocumentClasses();
    };
  }, [params.overlayId]);

  return (
    <div className="master-canvas-root">
      <style>{`
        .master-canvas-root { position: relative; width: 100%; height: 100%; background: transparent; font-family: system-ui, sans-serif; }
        .master-canvas-module { padding: 12px; }
        .master-canvas-ticker { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 16px; background: rgba(12,17,29,.86); color: #fff; }
        .master-canvas-goal { position: absolute; top: 0; left: 0; max-width: 420px; color: #fff; }
        .master-canvas-goal [data-role="goal-ladder-title"] { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
        .master-canvas-goal [data-role="goal-ladder-track"] { border-radius: 999px; background: rgba(255,255,255,.18); }
        .master-canvas-goal [data-role="goal-ladder-fill"] { background: linear-gradient(90deg, #7c5cff, #ff5ca8); }
        .master-canvas-goal [data-role="goal-ladder-amounts"] { margin-top: 6px; font-size: 13px; opacity: .9; }
        .master-canvas-vote { position: absolute; top: 0; right: 0; max-width: 420px; color: #fff; text-align: right; }
        .master-canvas-vote [data-role="tug-of-war-track"] { border-radius: 999px; background: rgba(255,255,255,.18); margin: 6px 0; }
        .master-canvas-vote [data-role="tug-of-war-left-fill"] { background: linear-gradient(90deg, #ff5c5c, #ff9c5c); }
        .master-canvas-vote [data-role="tug-of-war-right-fill"] { background: linear-gradient(270deg, #5c8cff, #5cd6ff); }
        .master-canvas-vote [data-role="tug-of-war-left-label"],
        .master-canvas-vote [data-role="tug-of-war-right-label"] { font-size: 13px; font-weight: 600; }
        .master-canvas-vote [data-role="tug-of-war-status"] { margin-top: 4px; font-size: 12px; opacity: .9; }
        .master-canvas-boss { position: absolute; top: 120px; left: 0; max-width: 420px; color: #fff; }
        .master-canvas-boss [data-role="boss-fight-title"] { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
        .master-canvas-boss [data-role="boss-fight-track"] { border-radius: 999px; background: rgba(255,255,255,.18); }
        .master-canvas-boss [data-role="boss-fight-health"] { background: linear-gradient(90deg, #ff5c5c, #ffb85c); }
        .master-canvas-boss [data-role="boss-fight-amounts"] { margin-top: 6px; font-size: 13px; opacity: .9; }
        .master-canvas-note { position: absolute; top: 0; right: 0; padding: 8px 12px; background: rgba(120,20,20,.7); color: #fff; font-size: 12px; }
        .master-canvas-theater { position: absolute; bottom: 90px; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; color: #fff; text-align: center; }
        .master-canvas-theater [data-role="support-theater-current"] { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .master-canvas-theater [data-role="support-theater-kicker"] { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .8; }
        .master-canvas-theater [data-role="support-theater-name"] { font-size: 20px; font-weight: 700; }
        .master-canvas-theater [data-role="support-theater-message"] { font-size: 14px; opacity: .92; max-width: 480px; }
        .master-canvas-theater [data-role="support-theater-aggregate-line"] { font-size: 13px; opacity: .92; margin: 0; }
        .master-canvas-theater [data-role="support-theater-next"] { margin-top: 8px; font-size: 12px; opacity: .75; }
        .master-canvas-challenge { position: absolute; top: 240px; left: 0; max-width: 420px; color: #fff; }
        .master-canvas-challenge [data-role="challenge-board-title"] { font-size: 16px; font-weight: 700; margin-bottom: 2px; }
        .master-canvas-challenge [data-role="challenge-board-state"] { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; opacity: .8; margin-bottom: 6px; }
        .master-canvas-challenge [data-role="challenge-board-track"] { border-radius: 999px; background: rgba(255,255,255,.18); }
        .master-canvas-challenge [data-role="challenge-board-fill"] { background: linear-gradient(90deg, #22c55e, #7c5cff); }
        .master-canvas-challenge [data-role="challenge-board-amounts"] { margin-top: 6px; font-size: 13px; opacity: .9; }
        .master-canvas-challenge [data-role="challenge-board-failure-copy"] { margin-top: 8px; font-size: 11px; line-height: 1.4; opacity: .85; max-width: 400px; }
        .master-canvas-milestone { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; color: #fff; }
        .master-canvas-milestone [data-role="milestone-celebration-animated"] { position: absolute; display: flex; align-items: center; justify-content: center; padding: 18px 32px; border-radius: 16px; background: linear-gradient(135deg, #ffb703, #fb5607); font-size: 24px; font-weight: 800; text-align: center; }
        .master-canvas-milestone [data-role="milestone-celebration-badge"] { position: absolute; display: flex; align-items: center; justify-content: center; padding: 10px 20px; border-radius: 8px; border: 2px solid #fff; background: #111827; font-size: 16px; font-weight: 700; text-align: center; }
        .master-canvas-mission { position: absolute; top: 120px; right: 0; max-width: 360px; color: #fff; text-align: right; }
        .master-canvas-mission [data-role="stream-mission-card"] { display: inline-flex; flex-direction: column; gap: 2px; padding: 10px 14px; border-radius: 12px; background: rgba(12,17,29,.78); }
        .master-canvas-mission [data-role="stream-mission-kicker"] { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .75; }
        .master-canvas-mission [data-role="stream-mission-objective"] { font-size: 16px; font-weight: 700; line-height: 1.3; }
        .master-canvas-mission [data-role="stream-mission-elapsed"] { font-size: 13px; opacity: .9; font-variant-numeric: tabular-nums; }
        .master-canvas-moderator-status { position: absolute; bottom: 56px; right: 0; color: #fff; text-align: right; }
        .master-canvas-moderator-status [data-role="moderator-status-card"] { padding: 8px 12px; border-radius: 10px; background: rgba(12,17,29,.78); font-size: 13px; font-weight: 600; }
        .master-canvas-moderator-status [data-role="moderator-status-dot"] { width: 8px; height: 8px; border-radius: 999px; background: #f59e0b; flex: none; }
        /* Reaction Cloud (§6 #5). The BASE layout is ordinary centred
           flex-wrap flow, declared here once. The module never writes a
           layout property: the cloud shape is a per-glyph transform
           (translate + scale) plus opacity, and nothing else (PRF-03). */
        .master-canvas-reaction-cloud { position: absolute; left: 0; right: 0; top: 300px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px 18px; pointer-events: none; color: #fff; }
        .master-canvas-reaction-cloud [data-role="reaction-cloud-glyph"] { display: inline-block; padding: 6px 12px; border-radius: 999px; background: rgba(12,17,29,.72); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; will-change: transform, opacity; }
        /* Lobby Status (§6 #16). The fill is a scaleX transform on an
           absolutely positioned child -- never a width -- so render()
           writes only transform and opacity (PRF-03). */
        .master-canvas-lobby { position: absolute; bottom: 120px; left: 0; max-width: 320px; color: #fff; }
        .master-canvas-lobby [data-role="lobby-status-card"] { padding: 10px 14px; border-radius: 12px; background: rgba(12,17,29,.78); }
        .master-canvas-lobby [data-role="lobby-status-kicker"] { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .75; }
        .master-canvas-lobby [data-role="lobby-status-track"] { border-radius: 999px; background: rgba(255,255,255,.18); }
        .master-canvas-lobby [data-role="lobby-status-fill"] { background: linear-gradient(90deg, #22c55e, #38bdf8); border-radius: 999px; }
        .master-canvas-lobby [data-role="lobby-status-label"] { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
        /* Giveaway / Tournament (§6 #17). The fill is a scaleX transform
           on an absolutely positioned child -- never a width -- so
           render() writes only transform, opacity and text (PRF-03). */
        .master-canvas-giveaway { position: absolute; bottom: 220px; left: 0; max-width: 360px; color: #fff; }
        .master-canvas-giveaway [data-role="giveaway-tournament-card"] { padding: 10px 14px; border-radius: 12px; background: rgba(12,17,29,.78); }
        .master-canvas-giveaway [data-role="giveaway-tournament-kicker"] { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .75; }
        .master-canvas-giveaway [data-role="giveaway-line"] { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
        .master-canvas-giveaway [data-role="tournament-line"] { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
        .master-canvas-giveaway [data-role="tournament-track"] { border-radius: 999px; background: rgba(255,255,255,.18); }
        .master-canvas-giveaway [data-role="tournament-fill"] { background: linear-gradient(90deg, #f59e0b, #38bdf8); border-radius: 999px; }
        /* QR Smart Card (§6 #10). The QR code is one <svg><path> pair;
           render() writes only opacity/transform for the card's
           entrance and the path's "d"/label text when the
           destination/label actually change (PRF-03). */
        .master-canvas-qr-card { position: absolute; bottom: 20px; right: 20px; color: #fff; }
        .master-canvas-qr-card [data-role="qr-smart-card"] { padding: 12px; border-radius: 12px; background: rgba(255,255,255,.94); }
        .master-canvas-qr-card [data-role="qr-smart-card-code"] { display: block; }
        .master-canvas-qr-card [data-role="qr-smart-card-label"] { font-size: 13px; font-weight: 600; color: #111827; text-align: center; }
      `}</style>
      <div ref={goalContainerRef} className="master-canvas-module master-canvas-goal" />
      <div ref={bossFightContainerRef} className="master-canvas-module master-canvas-boss" />
      <div ref={voteContainerRef} className="master-canvas-module master-canvas-vote" aria-live="polite" />
      <div ref={tickerContainerRef} className="master-canvas-module master-canvas-ticker" aria-live="polite" />
      <div ref={supportTheaterContainerRef} className="master-canvas-module master-canvas-theater" aria-live="polite" />
      <div ref={challengeContainerRef} className="master-canvas-module master-canvas-challenge" aria-live="polite" />
      <div ref={milestoneContainerRef} className="master-canvas-module master-canvas-milestone" aria-live="polite" />
      <div ref={missionContainerRef} className="master-canvas-module master-canvas-mission" aria-live="polite" />
      <div ref={moderatorStatusContainerRef} className="master-canvas-module master-canvas-moderator-status" aria-live="polite" />
      <div ref={reactionCloudContainerRef} className="master-canvas-module master-canvas-reaction-cloud" aria-hidden="true" />
      <div ref={lobbyStatusContainerRef} className="master-canvas-module master-canvas-lobby" aria-live="polite" />
      <div ref={giveawayTournamentContainerRef} className="master-canvas-module master-canvas-giveaway" aria-live="polite" />
      <div ref={qrSmartCardContainerRef} className="master-canvas-module master-canvas-qr-card" aria-live="polite" />
      {downModules.length > 0 && (
        <div className="master-canvas-note" role="status">
          {downModules.map((key) => (
            <p key={key} style={{ margin: 0 }}>{key.replace(/_/g, ' ')} is temporarily unavailable.</p>
          ))}
        </div>
      )}
    </div>
  );
}
