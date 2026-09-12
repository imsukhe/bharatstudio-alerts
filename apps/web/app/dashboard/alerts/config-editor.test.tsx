import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelConfigEditor } from '../ChannelConfigEditor';
import type { ChannelConfigValues } from '../../lib/api';

// ChannelConfigEditor is a pure controlled component (no data fetching of
// its own — see README.md "component with no data fetching") so it needs
// no mock-api: render it directly with fixture props and assert on the
// onChange payloads it produces, exactly like a real save-then-PATCH
// caller would receive them.

const baseDraft: ChannelConfigValues = {
  minimumTipPaise: 1000,
  defaultDisplaySeconds: 8,
  defaultStyle: 'standard_card',
  locale: 'en-IN',
  reducedMotion: false,
  brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 120, ttsEligible: true, displayStyle: 'standard_card', displayMinMs: 8000, ttsOverflowPolicy: 'extend' }],
  tts: { enabled: false, language: 'en-IN', overflowPolicy: 'extend', paddingMs: 0 },
  display: { anchor: 'bottom_center', offsetX: 0, offsetY: 0, scale: 1, widthPercent: 80, maxVisibleItems: 1 },
  queue: { mode: 'fifo', stackLimit: 1, rateLimitPerMinute: 60, aggregationWindowSeconds: 30, aggregationThreshold: 5, approvalRequired: false, quietMode: { enabled: false, start: '23:00', end: '07:00', timezone: 'Asia/Kolkata' } },
};

function renderEditor(overrides: Partial<Parameters<typeof ChannelConfigEditor>[0]> = {}) {
  let latest: ChannelConfigValues = baseDraft;
  const onChange = (next: ChannelConfigValues) => { latest = next; };
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => event.preventDefault();
  const utils = render(
    <ChannelConfigEditor version={3} draft={baseDraft} saving={false} onChange={onChange} onSubmit={onSubmit} {...overrides} />,
  );
  return { ...utils, getLatest: () => latest };
}

test('shows the config version passed in, so a stale draft is visually distinguishable after a reload', () => {
  renderEditor();
  assert.ok(screen.getByText('Alert configuration · v3'));
});

test('editing minimum tip converts the rupee input back to paise', () => {
  const { getLatest } = renderEditor();
  const input = screen.getByLabelText(/Minimum tip/);
  fireEvent.change(input, { target: { value: '25' } });
  assert.equal(getLatest().minimumTipPaise, 2500);
});

test('editing a bracket char limit updates only that bracket, leaving the others untouched', () => {
  const twoBrackets: ChannelConfigValues = {
    ...baseDraft,
    brackets: [
      { amountMinPaise: 1000, amountMaxPaise: 49_999, charLimit: 120, ttsEligible: true, displayStyle: 'standard_card', displayMinMs: 8000, ttsOverflowPolicy: 'extend' },
      { amountMinPaise: 50_000, amountMaxPaise: null, charLimit: 200, ttsEligible: true, displayStyle: 'banner', displayMinMs: 10_000, ttsOverflowPolicy: 'extend' },
    ],
  };
  const { getLatest } = renderEditor({ draft: twoBrackets });
  const charLimitInputs = screen.getAllByLabelText(/Message limit/);
  fireEvent.change(charLimitInputs[0], { target: { value: '80' } });
  const next = getLatest();
  assert.equal(next.brackets?.[0].charLimit, 80);
  assert.equal(next.brackets?.[1].charLimit, 200); // untouched
});

test('"Remove final bracket" is disabled with a single bracket — a channel can never be left with zero brackets', () => {
  renderEditor();
  const removeButton = screen.getByRole('button', { name: 'Remove final bracket' });
  assert.equal((removeButton as HTMLButtonElement).disabled, true);
});

test('adding a bracket splits the previously open-ended bracket at the new boundary instead of leaving a gap', () => {
  const { getLatest } = renderEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Add higher bracket' }));
  const next = getLatest();
  assert.equal(next.brackets?.length, 2);
  // The old single open bracket (min 1000, max null) must now close where
  // the new bracket starts, or a real amount would fall into neither.
  assert.equal(next.brackets?.[0].amountMaxPaise, next.brackets?.[1].amountMinPaise! - 1);
  assert.equal(next.brackets?.[1].amountMaxPaise, null); // new bracket stays open-ended
});

test('the save button is disabled and reads "Saving…" while a submit is in flight, so a slow PATCH cannot be double-fired', () => {
  renderEditor({ saving: true });
  const button = screen.getByRole('button', { name: 'Saving…' });
  assert.equal((button as HTMLButtonElement).disabled, true);
});

test('submitting the form invokes onSubmit', () => {
  let submitted = false;
  render(
    <ChannelConfigEditor
      version={1}
      draft={baseDraft}
      saving={false}
      onChange={() => {}}
      onSubmit={(event) => { event.preventDefault(); submitted = true; }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  assert.equal(submitted, true);
});
