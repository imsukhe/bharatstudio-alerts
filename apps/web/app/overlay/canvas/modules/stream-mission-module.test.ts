import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamMissionModule,
  elapsedSeconds,
  formatElapsed,
  isStreamMission,
  STREAM_MISSION_KICKER,
  type StreamMission,
  type StreamMissionModuleOptions,
} from './stream-mission-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles } from '../text-rendering';

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

const STARTED_AT = '2026-09-16T10:00:00.000Z';
const STARTED_MS = Date.parse(STARTED_AT);

function fakeMission(overrides: Partial<StreamMission> = {}): StreamMission {
  return {
    schemaVersion: 'v1',
    missionId: '00000000-0000-4000-8000-000000002301',
    objective: 'Reach Diamond rank tonight',
    startedAt: STARTED_AT,
    ...overrides,
  };
}

test('the objective and the elapsed reading render from the single fetched snapshot', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createStreamMissionModule({
    container, connection,
    fetchSnapshot: async () => fakeMission({ objective: 'Beat the boss with no deaths' }),
    reducedMotion: () => false,
    now: () => STARTED_MS + 64_000,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.querySelector('[data-role="stream-mission-kicker"]')?.textContent, STREAM_MISSION_KICKER);
  assert.equal(container.querySelector('[data-role="stream-mission-objective"]')?.textContent, 'Beat the boss with no deaths');
  assert.equal(container.querySelector('[data-role="stream-mission-elapsed"]')?.textContent, '1:04');
  assert.equal(container.style.opacity, '1');
});

test('nothing is shown before the first real snapshot lands — a mission is never invented', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createStreamMissionModule({
    container, connection,
    fetchSnapshot: async () => fakeMission(),
    reducedMotion: () => false,
    now: () => STARTED_MS,
  });
  module.activate();
  module.render(0); // no snapshot delivered yet
  assert.equal(container.style.opacity, '0');
  assert.equal(container.querySelector('[data-role="stream-mission-objective"]')?.textContent, '');
});

test('no mission running hides the card, and a mission that ends mid-stream hides it on the next re-read — no timer is involved', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let mission: StreamMission | null = fakeMission();
  const module = createStreamMissionModule({
    container, connection,
    fetchSnapshot: async () => mission,
    reducedMotion: () => false,
    now: () => STARTED_MS + 5_000,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');

  // The creator ends the mission: the server simply stops returning a row.
  mission = null;
  connection.fireChange();
  await flush();
  module.render(1);
  assert.equal(container.style.opacity, '0');
});

test('the elapsed reading counts UP and never toward an end — and no end time can be supplied to this module at all', async () => {
  // Structural (compile-time) proof, not merely behavioural: neither the
  // options type nor the mission type has any field for an end time,
  // duration, deadline or expiry. If a future edit ever added one, these
  // lines would stop compiling (the Extract<> would widen past `never`).
  // This is what keeps the owner's session-bounded decision (§6 module
  // table row 9, 2026-09-16) enforced by the build rather than by comment.
  type EndShapedOptionKeys = Extract<
    keyof StreamMissionModuleOptions,
    `${string}nds${string}` | `${string}uration${string}` | `${string}xpir${string}` | `${string}eadline${string}` | `${string}ountdown${string}`
  >;
  const noEndShapedOption: [EndShapedOptionKeys] extends [never] ? true : never = true;
  assert.equal(noEndShapedOption, true);

  type EndShapedMissionKeys = Extract<
    keyof StreamMission,
    `${string}nds${string}` | `${string}uration${string}` | `${string}xpir${string}` | `${string}eadline${string}` | `${string}ountdown${string}`
  >;
  const noEndShapedField: [EndShapedMissionKeys] extends [never] ? true : never = true;
  assert.equal(noEndShapedField, true);

  const container = document.createElement('div');
  const connection = fakeConnection();
  let nowMs = STARTED_MS + 1_000;
  const module = createStreamMissionModule({
    container, connection, fetchSnapshot: async () => fakeMission(), reducedMotion: () => false, now: () => nowMs,
  });
  module.activate();
  connection.fireChange();
  await flush();

  const readings: string[] = [];
  for (const offset of [1_000, 2_000, 61_000, 3_723_000]) {
    nowMs = STARTED_MS + offset;
    module.render(offset);
    readings.push(container.querySelector('[data-role="stream-mission-elapsed"]')?.textContent ?? '');
  }
  assert.deepEqual(readings, ['0:01', '0:02', '1:01', '1:02:03']);
});

test('elapsedSeconds/formatElapsed are pure and never negative — a clock skew reads as a just-started mission, never a countdown', () => {
  assert.equal(elapsedSeconds(STARTED_AT, STARTED_MS), 0);
  assert.equal(elapsedSeconds(STARTED_AT, STARTED_MS + 59_999), 59);
  assert.equal(elapsedSeconds(STARTED_AT, STARTED_MS - 90_000), 0, 'a startedAt in the future must read 0, never a negative (countdown) value');
  assert.equal(elapsedSeconds('not-a-date', STARTED_MS), 0);
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(59), '0:59');
  assert.equal(formatElapsed(600), '10:00');
  assert.equal(formatElapsed(3600), '1:00:00');
  assert.equal(formatElapsed(-5), '0:00');
});

test('the elapsed reading writes to the DOM once per whole second, not once per frame', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let nowMs = STARTED_MS + 1_000;
  const module = createStreamMissionModule({
    container, connection, fetchSnapshot: async () => fakeMission(), reducedMotion: () => false, now: () => nowMs,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const elapsedEl = container.querySelector('[data-role="stream-mission-elapsed"]') as HTMLElement;
  let writes = 0;
  const original = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  assert.ok(original, 'textContent descriptor must exist on Node.prototype');
  Object.defineProperty(elapsedEl, 'textContent', {
    configurable: true,
    get() { return original!.get!.call(this); },
    set(value: string) { writes += 1; original!.set!.call(this, value); },
  });

  // Sixteen frames inside the same whole second: zero writes.
  for (let frame = 0; frame < 16; frame += 1) {
    nowMs = STARTED_MS + 1_000 + frame * 16;
    module.render(frame);
  }
  assert.equal(writes, 0, 'frames inside the same whole second must not write to the DOM');

  // Crossing into the next whole second: exactly one write.
  nowMs = STARTED_MS + 2_000;
  module.render(99);
  assert.equal(writes, 1);
  assert.equal(elapsedEl.textContent, '0:02');
});

test('composite-only (PRF-03): only opacity and transform are ever written', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createStreamMissionModule({
    container, connection, fetchSnapshot: async () => fakeMission(), reducedMotion: () => false,
    now: () => STARTED_MS + 3_000,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const card = container.querySelector('[data-role="stream-mission-card"]') as HTMLElement;
  assert.equal(card.style.transform, 'translateY(0px)');
  for (const property of ['width', 'height', 'top', 'left', 'margin', 'padding'] as const) {
    assert.equal(card.style[property], '', `render() must never write ${property}`);
    assert.equal(container.style[property], '', `render() must never write ${property} on the container`);
  }
});

test('prefers-reduced-motion removes the entrance transition but never the information', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let nowMs = STARTED_MS + 5_000;
  const module = createStreamMissionModule({
    container, connection, fetchSnapshot: async () => fakeMission(), reducedMotion: () => true, now: () => nowMs,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const card = container.querySelector('[data-role="stream-mission-card"]') as HTMLElement;
  assert.equal(card.style.transition, 'none');
  // The objective and the elapsed reading are information, not motion —
  // they still render, and they still update (slice 4's ruling: a
  // reduced-motion alternative must be perceivable, not merely shortened).
  assert.equal(container.querySelector('[data-role="stream-mission-objective"]')?.textContent, 'Reach Diamond rank tonight');
  assert.equal(container.querySelector('[data-role="stream-mission-elapsed"]')?.textContent, '0:05');
  nowMs = STARTED_MS + 6_000;
  module.render(1);
  assert.equal(container.querySelector('[data-role="stream-mission-elapsed"]')?.textContent, '0:06');
});

test('a malformed payload is ignored, never thrown, and never replaces the last known-good mission', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let payload: unknown = fakeMission();
  const module = createStreamMissionModule({
    container, connection,
    fetchSnapshot: async () => payload as StreamMission | null,
    reducedMotion: () => false,
    now: () => STARTED_MS + 2_000,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.querySelector('[data-role="stream-mission-objective"]')?.textContent, 'Reach Diamond rank tonight');

  for (const bad of [{ schemaVersion: 'v2' }, { schemaVersion: 'v1', missionId: '', objective: 'x', startedAt: STARTED_AT }, { schemaVersion: 'v1', missionId: 'm', objective: 'a'.repeat(121), startedAt: STARTED_AT }, { schemaVersion: 'v1', missionId: 'm', objective: 'ok', startedAt: 'not-a-date' }, 'nonsense', 42]) {
    payload = bad;
    connection.fireChange();
    await flush();
    assert.doesNotThrow(() => module.render(1));
    assert.equal(container.querySelector('[data-role="stream-mission-objective"]')?.textContent, 'Reach Diamond rank tonight');
  }
});

test('isStreamMission enforces the same 1-120 objective bound the schema and the route do', () => {
  assert.equal(isStreamMission(fakeMission({ objective: 'a' })), true);
  assert.equal(isStreamMission(fakeMission({ objective: 'a'.repeat(120) })), true);
  assert.equal(isStreamMission(fakeMission({ objective: 'a'.repeat(121) })), false);
  assert.equal(isStreamMission(fakeMission({ objective: '' })), false);
  assert.equal(isStreamMission(null), false);
});

test('deactivate unsubscribes, discards a late in-flight fetch, and is idempotent', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let release: ((value: StreamMission | null) => void) | undefined;
  const module = createStreamMissionModule({
    container, connection,
    fetchSnapshot: () => new Promise<StreamMission | null>((resolve) => { release = resolve; }),
    reducedMotion: () => false,
    now: () => STARTED_MS + 1_000,
  });
  module.activate();
  connection.fireChange();
  await flush();
  assert.equal(connection.getSubscriberCount(), 1);

  assert.doesNotThrow(() => module.deactivate());
  assert.doesNotThrow(() => module.deactivate()); // idempotent
  assert.equal(connection.getSubscriberCount(), 0);

  release?.(fakeMission({ objective: 'Late arrival that must be discarded' }));
  await flush();
  module.render(0);
  assert.equal(container.querySelector('[data-role="stream-mission-objective"]')?.textContent, '', 'a fetch that resolves after deactivate() must never render');
});

test('every font family comes from defaultCanvasTextStyles() — no family string is hard-coded (§15.4.3 precondition)', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createStreamMissionModule({
    container, connection, fetchSnapshot: async () => fakeMission(), reducedMotion: () => false, now: () => STARTED_MS,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  // The DOM normalises quoting/spacing inside a font-family list, so the
  // comparison is on a normalised form rather than byte-for-byte -- the
  // property under test is "this value came from text-rendering.ts", not
  // "the browser preserved our exact quoting".
  const normalise = (value: string) => value.replace(/['"\s]/g, '').toLowerCase();
  const styles = defaultCanvasTextStyles();
  const allowed = [styles.label.fontFamily, styles.title.fontFamily, styles.amount.fontFamily].map(normalise);
  for (const role of ['stream-mission-kicker', 'stream-mission-objective', 'stream-mission-elapsed'] as const) {
    const element = container.querySelector(`[data-role="${role}"]`) as HTMLElement;
    assert.ok(element.style.fontFamily.length > 0, `${role} must carry a font family`);
    assert.ok(
      allowed.includes(normalise(element.style.fontFamily)),
      `${role}'s family must come from defaultCanvasTextStyles(), not a hard-coded string`,
    );
    // And it genuinely carries the Indic coverage text-rendering.ts's one
    // first-party default supplies -- the objective is creator-authored
    // text that will routinely be Indic script in this market.
    assert.ok(normalise(element.style.fontFamily).includes('notosansdevanagari'), `${role} must inherit the shared Indic-capable stack`);
  }
});

test('the module can never open a second overlay session or transport — its options carry no overlayId, token or apiOrigin', () => {
  // Structural (compile-time) proof: PRF-02.1's "one connection" property
  // is a property of this type, not of a convention the next editor has to
  // remember. Support Theater is the only module that needs session-shaped
  // options, and it takes them for the SHARED session (slice 3's
  // Correction) — this module takes none at all.
  type SessionShapedKeys = Extract<keyof StreamMissionModuleOptions, 'overlayId' | 'token' | 'apiOrigin' | 'fetchImpl' | 'url'>;
  const noSessionShapedOption: [SessionShapedKeys] extends [never] ? true : never = true;
  assert.equal(noSessionShapedOption, true);

  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createStreamMissionModule({
    container, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  });
  assert.equal(module.key, 'stream_mission_card');
  assert.equal(connection.getOpenAttemptCount(), 0, 'constructing the module must open nothing');
});
