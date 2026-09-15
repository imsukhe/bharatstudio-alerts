import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiOriginPath = new URL('../../lib/api-origin.ts', import.meta.url).pathname;
let tipFormPromise: Promise<typeof import('./TipForm').TipForm> | undefined;

async function loadTipForm() {
  if (!tipFormPromise) {
    mock.module(apiOriginPath, { namedExports: { getApiOrigin: () => 'https://api.example.test' } });
    tipFormPromise = import('./TipForm').then((module) => module.TipForm);
  }
  return tipFormPromise;
}

const definitionId = '00000000-0000-4000-8000-000000000091';

test('a viewer-selected paid vote is serialized as a complete paired tag on the ordinary tip order', async () => {
  const TipForm = await loadTipForm();
  let orderBody: Record<string, unknown> | undefined;
  mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.endsWith('/paid-votes')) {
      return new Response(JSON.stringify({ schemaVersion: 'v1', items: [{ definitionId, label: 'Choose a game', options: [{ optionKey: 'game_a', label: 'Game A' }] }] }), { status: 200 });
    }
    if (text.endsWith('/tips/orders')) {
      orderBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000092', provider: 'razorpay', providerOrderId: 'order_test', amountPaise: 10000, currency: 'INR', status: 'created' }), { status: 201 });
    }
    throw new Error(`unexpected URL ${text}`);
  });

  render(<TipForm handle="demo_creator" acceptingTips minimumTipPaise={1000} />);
  const picker = await screen.findByLabelText(/Add your support vote/i);
  fireEvent.change(picker, { target: { value: `${definitionId}:game_a` } });
  fireEvent.submit(picker.closest('form')!);
  await waitFor(() => assert.ok(orderBody));
  assert.equal(orderBody?.interactionDefinitionId, definitionId);
  assert.equal(orderBody?.voteOptionKey, 'game_a');
});

test('a malformed or unavailable catalogue never renders a picker and cannot add a tag', async () => {
  const TipForm = await loadTipForm();
  let orderBody: Record<string, unknown> | undefined;
  mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/paid-votes')) return new Response(JSON.stringify({ schemaVersion: 'v1', items: [{ definitionId, queueId: 'private', label: 'bad', options: [] }] }), { status: 200 });
    orderBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000093', provider: 'razorpay', providerOrderId: 'order_test', amountPaise: 10000, currency: 'INR', status: 'created' }), { status: 201 });
  });

  render(<TipForm handle="demo_creator_2" acceptingTips minimumTipPaise={1000} />);
  await waitFor(() => assert.equal(screen.queryByLabelText(/Add your support vote/i), null));
  const form = screen.getByRole('button', { name: /continue to tip/i }).closest('form')!;
  fireEvent.submit(form);
  await waitFor(() => assert.ok(orderBody));
  assert.equal('interactionDefinitionId' in (orderBody ?? {}), false);
  assert.equal('voteOptionKey' in (orderBody ?? {}), false);
});
