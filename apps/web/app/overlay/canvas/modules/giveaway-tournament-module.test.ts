import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGiveawayTournamentModule } from './giveaway-tournament-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { GiveawayTournamentState } from './giveaway-tournament-logic';

/*
 * §6 catalogue module #17 (Giveaway / Tournament Card) — the renderer's own
 * cases.
 *
 * The case that carries a recorded product decision rather than a
 * mechanical requirement is the NOTHING-AFTER-CONCLUSION one: when a
 * creator closes a giveaway or concludes a tournament the read returns
 * nothing and this card paints nothing. There is deliberately no terminal
 * state, because a terminal label on a bracket is a winner announcement
 * with the name left out — and §17.1 permits a winner announcement only
 * WITH CONSENT, which this schema has no mechanism for.
 *
 * The other cases that matter are negative and cover the whole rendered
 * subtree: nothing this module can paint contains a winner, a prize, an
 * escrow, an address, a claim link, a seed, odds, or a participant in any
 * shape.
 *
 * The countdown case is the one structural novelty: this module ticks on
 * the SHARED rAF loop's own `render(timestampMs)` call, never on a timer
 * of its own.
 */

function fakeConnection(): MasterCanvasConnection & { fireChange(): void } {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeToEvents: () => () => {},
    acknowledge: async () => ({ ok: false }),
    getOpenAttemptCount: () => 0,
    getSubscriberCount: () => listeners.size,
    fireChange() { for (const l of listeners) l(); },
  };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const closesAt = '2026-09-17T10:30:00.000Z';
const opensAtMs = Date.parse('2026-09-17T10:00:00.000Z');

const both: GiveawayTournamentState = {
  schemaVersion: 'v1',
  entryCount: 143,
  entryClosesAt: closesAt,
  tournamentCurrentRound: 2,
  tournamentTotalRounds: 3,
  tournamentCompletedMatchesInRound: 1,
  tournamentMatchesInRound: 2,
};

function mount(
  fetchSnapshot: () => Promise<GiveawayTournamentState | null>,
  now: () => number = () => opensAtMs,
  reducedMotion = () => false,
) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createGiveawayTournamentModule({ container, connection, fetchSnapshot, reducedMotion, now });
  module.activate();
  return { container, connection, module };
}

function lineText(container: HTMLElement, role: string): string {
  return (container.querySelector(`[data-role="${role}"]`) as HTMLElement).textContent ?? '';
}

function fillTransform(container: HTMLElement): string {
  return (container.querySelector('[data-role="tournament-fill"]') as HTMLElement).style.transform;
}

test('the module key is the catalogue key migration 0131 already names', () => {
  const { module } = mount(async () => null);
  assert.equal(module.key, 'giveaway_tournament_card');
});

test('both halves render as two aggregate lines and a round fill', async () => {
  const { container, connection, module } = mount(async () => both);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(lineText(container, 'giveaway-line'), '143 entries · closes in 30:00');
  assert.equal(lineText(container, 'tournament-line'), 'Round 2 of 3 · 1 of 2 matches complete');
  assert.equal(fillTransform(container), 'scaleX(0.5)');
});

test('a giveaway with zero entries still shows — that is the invitation', async () => {
  const { container, connection, module } = mount(async () => ({
    ...both, entryCount: 0,
    tournamentCurrentRound: null, tournamentTotalRounds: null,
    tournamentCompletedMatchesInRound: null, tournamentMatchesInRound: null,
  }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(lineText(container, 'giveaway-line'), 'No entries yet · closes in 30:00');
  assert.equal(lineText(container, 'tournament-line'), '');
});

test('a null snapshot paints nothing — and so does a concluded tournament, by construction', async () => {
  // A closed giveaway and a concluded tournament both return zero rows
  // from the read, which reaches this module as null. There is no terminal
  // state to render and no result to announce.
  const { container, connection, module } = mount(async () => null);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
  assert.equal(lineText(container, 'giveaway-line'), '');
  assert.equal(lineText(container, 'tournament-line'), '');
  assert.equal(fillTransform(container), 'scaleX(0)');
  for (const forbidden of ['winner', 'champion', 'won', 'prize', 'claim']) {
    assert.equal(container.textContent?.toLowerCase().includes(forbidden), false);
  }
});

test('the countdown ticks on the SHARED rAF loop, with no timer of its own', async () => {
  let nowMs = opensAtMs;
  const { container, connection, module } = mount(async () => both, () => nowMs);
  connection.fireChange();
  await flush();

  module.render(0);
  assert.equal(lineText(container, 'giveaway-line'), '143 entries · closes in 30:00');

  // No refetch, no timer, no new snapshot — just the next frame the one
  // shared loop was going to deliver anyway.
  nowMs += 65_000;
  module.render(16);
  assert.equal(lineText(container, 'giveaway-line'), '143 entries · closes in 28:55');

  nowMs = opensAtMs + 1_800_000;
  module.render(32);
  assert.equal(lineText(container, 'giveaway-line'), '143 entries · entry closed');
});

test('nothing the renderer can paint carries a winner, a prize, a participant or a seed', async () => {
  const polluted = {
    ...both,
    winner: 'Riya',
    prize: 'A gaming mouse',
    escrowHeld: true,
    shippingAddress: '12 MG Road',
    claimUrl: 'https://example.invalid/claim',
    seed: 'abc123',
    odds: 2,
    participants: [{ name: 'Riya' }],
    discordName: 'riya#1234',
    viewerId: '00000000-0000-4000-8000-0000000000a2',
  };
  const { container, connection, module } = mount(async () => polluted as unknown as GiveawayTournamentState);
  connection.fireChange();
  await flush();
  module.render(0);

  // The guard refuses the whole payload, so the card paints nothing rather
  // than painting the parts it recognised.
  assert.equal(container.style.opacity, '0');
  const rendered = (container.textContent ?? '').toLowerCase();
  for (const forbidden of ['riya', 'mouse', 'mg road', 'claim', 'abc123', 'discord']) {
    assert.equal(rendered.includes(forbidden), false, `"${forbidden}" must never reach the DOM`);
  }
});

test('the DOM is bounded: six elements, created once, whatever the state', async () => {
  const { container, connection, module } = mount(async () => both);
  connection.fireChange();
  await flush();
  module.render(0);
  const first = container.querySelectorAll('*').length;

  for (let frame = 1; frame <= 40; frame += 1) module.render(frame * 16);
  connection.fireChange();
  await flush();
  module.render(700);

  assert.equal(container.querySelectorAll('*').length, first);
  assert.equal(first, 6);
});

test('render() writes only opacity, transform and text', async () => {
  const { container, connection, module } = mount(async () => both);
  connection.fireChange();
  await flush();
  module.render(0);

  const card = container.querySelector('[data-role="giveaway-tournament-card"]') as HTMLElement;
  const track = container.querySelector('[data-role="tournament-track"]') as HTMLElement;
  // Set once in activate(), never rewritten per frame.
  assert.equal(track.style.height, '6px');
  assert.equal(card.style.transform, 'translateY(0)');
  assert.equal(card.style.opacity, '1');
  // The fill is a scaleX, never a width.
  assert.equal((container.querySelector('[data-role="tournament-fill"]') as HTMLElement).style.width, '');
});

test('deactivate releases the shared connection subscription and discards an in-flight fetch', async () => {
  let resolveFetch: ((value: GiveawayTournamentState | null) => void) | undefined;
  const { container, connection, module } = mount(() => new Promise((resolve) => { resolveFetch = resolve; }));
  connection.fireChange();
  assert.equal(connection.getSubscriberCount(), 1);

  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0);

  resolveFetch?.(both);
  await flush();
  module.render(0);
  // The superseded answer is discarded rather than rendered as current.
  assert.equal(container.style.opacity, '0');
  assert.equal(lineText(container, 'giveaway-line'), '');
});

test('reduced motion declares no transition', async () => {
  const { container } = mount(async () => both, () => opensAtMs, () => true);
  const card = container.querySelector('[data-role="giveaway-tournament-card"]') as HTMLElement;
  const fill = container.querySelector('[data-role="tournament-fill"]') as HTMLElement;
  assert.equal(card.style.transition, 'none');
  assert.equal(fill.style.transition, 'none');
});
