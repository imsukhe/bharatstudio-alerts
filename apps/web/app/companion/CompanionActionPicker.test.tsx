import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CompanionActionPicker } from './CompanionActionPicker';
import type { CatalogueEntry } from './action-catalogue';
import type { Queue } from '../lib/api';

// No API mocking needed: CompanionActionPicker is a pure prop-driven
// component (all gating/target-building logic lives in action-catalogue.ts
// and is invoked synchronously) — this exercises it directly rather than
// through the page, which is covered separately in page.test.tsx.

const activeQueue: Queue = { schemaVersion: 'v1', queueId: '11111111-1111-1111-1111-111111111111', channelId: 'c1', name: 'Main queue', paused: false, active: true };

function renderPicker(overrides: Partial<Parameters<typeof CompanionActionPicker>[0]> = {}) {
  const onAssign = overrides.onAssign ?? (() => {});
  render(
    <CompanionActionPicker
      maxSlots={8}
      takenSlotCount={0}
      entitledGroups={new Set(['alerts', 'mirror', 'stream'])}
      overlayConnected={false}
      activeQueues={[activeQueue]}
      canOperate={true}
      busy={false}
      onAssign={onAssign}
      {...overrides}
    />,
  );
  return { onAssign };
}

function rowFor(actionLabel: string): HTMLElement {
  const heading = screen.getByText(actionLabel);
  const row = heading.closest('.companion-catalogue-row');
  if (!row) throw new Error(`row not found for ${actionLabel}`);
  return row as HTMLElement;
}

test('a locked (not-entitled) action and an inactive (entitled-but-not-live) action render as visibly distinct states', () => {
  // 'obs' is NOT in entitledGroups -> locked. 'alerts' IS entitled but
  // overlayConnected=false -> inactive. If these ever collapsed into one
  // rendering path, an operator could not tell "not on my plan" (locked)
  // from "on my plan, just not live yet" (inactive) -- the whole point of
  // the two-layer gate design documented at the top of the component.
  renderPicker();

  const lockedRow = rowFor('Set OBS scene');
  const inactiveRow = rowFor('Pause queue');

  assert.equal(lockedRow.getAttribute('data-gate'), 'locked');
  assert.equal(inactiveRow.getAttribute('data-gate'), 'inactive');

  // Locked: no Add button at all, an "Unavailable" tag, and the reason is
  // styled as an error (this is a plan limitation).
  assert.equal(within(lockedRow).queryByRole('button', { name: 'Add' }), null);
  assert.ok(within(lockedRow).getByText('Unavailable'));
  assert.match(lockedRow.querySelector('.error-text')?.textContent ?? '', /not available on this channel's current plan/i);

  // Inactive: an Add button IS present (you can still pre-wire the slot),
  // no "Unavailable" tag, and the reason text is not styled as an error.
  assert.ok(within(inactiveRow).getByRole('button', { name: 'Add' }));
  assert.equal(within(inactiveRow).queryByText('Unavailable'), null);
  assert.equal(inactiveRow.querySelector('.error-text'), null);
  assert.match(inactiveRow.textContent ?? '', /not currently live/i);
});

test('an available (entitled + no activation signal) action shows an Add button and no locked/inactive reason text', () => {
  renderPicker();
  const availableRow = rowFor('Start Mirror');
  assert.equal(availableRow.getAttribute('data-gate'), 'available');
  assert.ok(within(availableRow).getByRole('button', { name: 'Add' }));
  assert.doesNotMatch(availableRow.textContent ?? '', /not available on this channel|not currently live/i);
});

test('with no free slots left, every Add button is disabled and the helper text explains why', () => {
  renderPicker({ maxSlots: 2, takenSlotCount: 2 });
  assert.ok(screen.getByText(/no free slots left/i));
  const addButtons = screen.getAllByRole('button', { name: 'Add' });
  assert.ok(addButtons.length > 0);
  for (const button of addButtons) assert.equal((button as HTMLButtonElement).disabled, true);
});

test('read-only (canOperate=false): no Add button renders anywhere, even for available/inactive actions', () => {
  renderPicker({ canOperate: false });
  assert.equal(screen.queryAllByRole('button', { name: 'Add' }).length, 0);
});

test('obs_set_scene collects a scene name before it can be added — no free-text field pretending to configure a target it cannot', () => {
  const onAssign = mock.fn();
  renderPicker({ entitledGroups: new Set(['obs']), onAssign });
  fireEvent.click(within(rowFor('Set OBS scene')).getByRole('button', { name: 'Add' }));

  const draftRow = rowFor('Set OBS scene');
  const sceneInput = within(draftRow).getByPlaceholderText('e.g. Starting Soon');
  const addToLayout = within(draftRow).getByRole('button', { name: 'Add to layout' });

  // Nothing typed yet -> cannot be added.
  assert.equal((addToLayout as HTMLButtonElement).disabled, true);

  fireEvent.change(sceneInput, { target: { value: 'Starting Soon' } });
  assert.equal((addToLayout as HTMLButtonElement).disabled, false);
  fireEvent.click(addToLayout);

  assert.equal(onAssign.mock.calls.length, 1);
});

test('obs_set_scene assigns with the typed scene name as the targetLabel', () => {
  let captured: unknown[] | null = null;
  renderPicker({ entitledGroups: new Set(['obs']), onAssign: (...args: unknown[]) => { captured = args; } });
  fireEvent.click(within(rowFor('Set OBS scene')).getByRole('button', { name: 'Add' }));
  const draftRow = rowFor('Set OBS scene');
  fireEvent.change(within(draftRow).getByPlaceholderText('e.g. Starting Soon'), { target: { value: 'Starting Soon' } });
  fireEvent.click(within(draftRow).getByRole('button', { name: 'Add to layout' }));

  assert.ok(captured);
  const [entry, targetId, targetLabel] = captured as [CatalogueEntry, string, string | undefined];
  assert.equal(entry.action, 'obs_set_scene');
  assert.equal(targetLabel, 'Starting Soon');
  assert.match(targetId, /^[0-9a-f-]{36}$/);
});

test('obs_toggle_source needs a scene name AND a numeric scene item id — not a single free-text field', () => {
  let captured: unknown[] | null = null;
  renderPicker({ entitledGroups: new Set(['obs']), onAssign: (...args: unknown[]) => { captured = args; } });
  fireEvent.click(within(rowFor('Toggle OBS source')).getByRole('button', { name: 'Add' }));
  const draftRow = rowFor('Toggle OBS source');

  const sceneInput = within(draftRow).getByPlaceholderText('e.g. Main Scene');
  const itemInput = within(draftRow).getByPlaceholderText('e.g. 12');
  const addToLayout = within(draftRow).getByRole('button', { name: 'Add to layout' });

  // Scene alone is not enough.
  fireEvent.change(sceneInput, { target: { value: 'Main Scene' } });
  assert.equal((addToLayout as HTMLButtonElement).disabled, true);

  // The numeric field strips non-digit input rather than accepting free text.
  fireEvent.change(itemInput, { target: { value: 'abc12x' } });
  assert.equal((itemInput as HTMLInputElement).value, '12');
  assert.equal((addToLayout as HTMLButtonElement).disabled, false);

  fireEvent.click(addToLayout);
  assert.ok(captured);
  const [entry, , targetLabel] = captured as [CatalogueEntry, string, string | undefined];
  assert.equal(entry.action, 'obs_toggle_source');
  assert.equal(targetLabel, 'Main Scene#12');
});

test('a queue-target action (pause_queue) assigns the selected queue id as targetId with no targetLabel', () => {
  let captured: unknown[] | null = null;
  renderPicker({ onAssign: (...args: unknown[]) => { captured = args; } });
  fireEvent.click(within(rowFor('Pause queue')).getByRole('button', { name: 'Add' }));
  const draftRow = rowFor('Pause queue');
  fireEvent.change(within(draftRow).getByRole('combobox'), { target: { value: activeQueue.queueId } });
  fireEvent.click(within(draftRow).getByRole('button', { name: 'Add to layout' }));

  assert.ok(captured);
  const [, targetId, targetLabel] = captured as [CatalogueEntry, string, string | undefined];
  assert.equal(targetId, activeQueue.queueId);
  assert.equal(targetLabel, undefined);
});

test('a no-target action (mirror_start) needs no fields and assigns immediately with a generated id', () => {
  let captured: unknown[] | null = null;
  renderPicker({ onAssign: (...args: unknown[]) => { captured = args; } });
  fireEvent.click(within(rowFor('Start Mirror')).getByRole('button', { name: 'Add' }));
  const draftRow = rowFor('Start Mirror');
  assert.ok(within(draftRow).getByText(/needs no target/i));
  fireEvent.click(within(draftRow).getByRole('button', { name: 'Add to layout' }));

  assert.ok(captured);
  const [entry, targetId, targetLabel] = captured as [CatalogueEntry, string, string | undefined];
  assert.equal(entry.action, 'mirror_start');
  assert.equal(targetLabel, undefined);
  assert.match(targetId, /^[0-9a-f-]{36}$/);
});
