import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLobbyStatusModule } from './lobby-status-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { LobbyStatus } from './lobby-status-logic';

/*
 * §6 catalogue module #16 (Lobby Status) — the renderer's own cases.
 *
 * The case that carries a recorded product decision rather than a
 * mechanical requirement is the ZERO-CONFIRMED one: unlike the Moderator
 * Status Card, this card SHOWS at 0/16 with an empty queue, because "a
 * lobby is open and it has sixteen seats" is the invitation the card
 * exists to deliver. It is asserted in both directions so the decision
 * cannot quietly rot into "it happens to work".
 *
 * The other case that matters is negative and covers the whole rendered
 * subtree: nothing this module can paint contains a room code, a password,
 * a seat token, a player identifier, an in-game name, a Discord name,
 * initials or an avatar.
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

function mount(fetchSnapshot: () => Promise<LobbyStatus | null>, reducedMotion = () => false) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createLobbyStatusModule({ container, connection, fetchSnapshot, reducedMotion });
  module.activate();
  return { container, connection, module };
}

function labelText(container: HTMLElement): string {
  return (container.querySelector('[data-role="lobby-status-label"]') as HTMLElement).textContent ?? '';
}

function fillTransform(container: HTMLElement): string {
  return (container.querySelector('[data-role="lobby-status-fill"]') as HTMLElement).style.transform;
}

test('the module key is the catalogue key migration 0131 already names', () => {
  const { module } = mount(async () => null);
  assert.equal(module.key, 'lobby_status');
});

test('an open lobby renders "8/16 seats confirmed · 12 in queue"', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 12 }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(labelText(container), '8/16 seats confirmed · 12 in queue');
  assert.equal(fillTransform(container), 'scaleX(0.5)');
});

test('the card SHOWS at zero confirmed with an empty queue — that is the invitation, not an empty state', async () => {
  // Deliberately the opposite of the Moderator Status Card's zero rule,
  // and the reason is the opposite too: there a zero carries no
  // information, here "a lobby is open and it has sixteen seats" is
  // exactly what a viewer needs in order to join.
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 0, queueCount: 0 }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(labelText(container), '0/16 seats confirmed');
  assert.equal(fillTransform(container), 'scaleX(0)');
});

test('a null snapshot renders nothing, and the card hides again when a lobby closes', async () => {
  let current: LobbyStatus | null = { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 12 };
  const { container, connection, module } = mount(async () => current);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');

  // The lobby closes -- or the token expires, or the channel loses the
  // entitlement. All three arrive here as the same null and all three
  // render the same nothing.
  current = null;
  connection.fireChange();
  await flush();
  module.render(16);
  assert.equal(container.style.opacity, '0');
  assert.equal(labelText(container), '');
  assert.equal(fillTransform(container), 'scaleX(0)', 'the fill must reset, not linger at its last value');
});

test('§16: nothing the renderer can paint is a code, a password, a name or an avatar', async () => {
  // Asserted against the WHOLE rendered subtree, not just the label, so a
  // decorative element cannot smuggle one in. The store cannot supply any
  // of these either -- the guard rejects the payload outright -- so this
  // is the third independent line, not the first.
  const leaking = {
    schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 12,
    roomCode: 'BGMI-4417', password: 'hunter2', seatToken: 'st_9f2c',
    playerName: 'Riya', discordName: 'riya#1234', initials: 'RS',
    avatarUrl: 'https://cdn.example.invalid/a.png',
  } as unknown as LobbyStatus;

  const { container, connection, module } = mount(async () => leaking);
  connection.fireChange();
  await flush();
  module.render(0);

  // The guard rejected the whole payload, so the card renders nothing at
  // all rather than rendering the three good numbers out of a body that
  // also carried a room code.
  assert.equal(container.style.opacity, '0');
  const rendered = (container.textContent ?? '').toLowerCase();
  for (const forbidden of ['bgmi', 'hunter2', 'st_9f2c', 'riya', 'discord', 'rs', 'avatar', 'http']) {
    assert.ok(!rendered.includes(forbidden), `the rendered card must never contain "${forbidden}"`);
  }
  assert.ok(!container.innerHTML.includes('http'), 'no URL of any kind may reach the Canvas (§9.1.1)');
});

test('the rendered card never says "player", "code", "password" or "queue policy"', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 12 }));
  connection.fireChange();
  await flush();
  module.render(0);

  const rendered = (container.textContent ?? '').toLowerCase();
  assert.ok(rendered.includes('8/16 seats confirmed'));
  for (const forbidden of ['player', 'code', 'password', 'policy', 'ready check', 'discord']) {
    assert.ok(!rendered.includes(forbidden), `the rendered card must never contain "${forbidden}"`);
  }
});

test('PRF-03: render() touches only transform and opacity, and the DOM is bounded', async () => {
  let current: LobbyStatus = { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 1, queueCount: 1 };
  const { container, connection, module } = mount(async () => current);
  connection.fireChange();
  await flush();
  module.render(0);

  const card = container.querySelector('[data-role="lobby-status-card"]') as HTMLElement;
  const track = container.querySelector('[data-role="lobby-status-track"]') as HTMLElement;
  const nodesAfterFirst = container.querySelectorAll('*').length;
  const trackHeightAfterFirst = track.style.height;
  const cardDisplayAfterFirst = card.style.display;

  // Twenty updates, every one of them changing both numbers. A renderer
  // that appended a node per update, or that wrote a layout property,
  // would show it here.
  for (let i = 2; i <= 21; i += 1) {
    current = { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: i % 17, queueCount: i };
    connection.fireChange();
    await flush();
    module.render(i * 16);
  }

  assert.equal(container.querySelectorAll('*').length, nodesAfterFirst, 'the DOM must be created once and reused, never grown per update');
  assert.equal(nodesAfterFirst, 5, 'five elements: card, kicker, track, fill, label');
  assert.equal(track.style.height, trackHeightAfterFirst, 'the track height is declared once and never animated');
  assert.equal(card.style.display, cardDisplayAfterFirst, 'layout properties are declared in activate(), never written per frame');
});

test('render() is a cheap no-op when nothing changed', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 0 }));
  connection.fireChange();
  await flush();
  module.render(0);
  const transformAfterFirst = fillTransform(container);

  module.render(16);
  module.render(32);
  assert.equal(fillTransform(container), transformAfterFirst);
  assert.equal(labelText(container), '8/16 seats confirmed');
});

test('deactivate releases the shared connection subscription and discards an in-flight fetch', async () => {
  let resolveFetch: (value: LobbyStatus | null) => void = () => {};
  const { container, connection, module } = mount(() => new Promise<LobbyStatus | null>((resolve) => { resolveFetch = resolve; }));
  assert.equal(connection.getSubscriberCount(), 1);
  connection.fireChange();

  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0, 'deactivate must release the subscription on the shared connection');

  // The fetch that was already in flight resolves AFTER deactivate. Its
  // answer must be discarded rather than painted onto a module that is no
  // longer active.
  resolveFetch({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 12 });
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('a failing fetch renders nothing rather than a stale or partial lobby', async () => {
  const { container, connection, module } = mount(async () => { throw new Error('network'); });
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
  assert.equal(labelText(container), '');
});

test('reduced motion declares no transition, and still renders the same numbers', async () => {
  const { container, connection, module } = mount(
    async () => ({ schemaVersion: 'v1', seatCount: 10, confirmedSeatCount: 5, queueCount: 3 }),
    () => true,
  );
  connection.fireChange();
  await flush();
  module.render(0);

  const card = container.querySelector('[data-role="lobby-status-card"]') as HTMLElement;
  const fill = container.querySelector('[data-role="lobby-status-fill"]') as HTMLElement;
  assert.equal(card.style.transition, 'none');
  assert.equal(fill.style.transition, 'none');
  assert.equal(labelText(container), '5/10 seats confirmed · 3 in queue');
});
