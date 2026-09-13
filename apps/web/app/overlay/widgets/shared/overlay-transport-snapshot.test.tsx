import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { useOverlayTransport, type SnapshotOutcome } from './overlay-transport';

/*
 * Covers the crux property this migration must not lose: a widget shows
 * its CURRENT state immediately on connect (never only events after a
 * cursor), a reconnect never resets it to empty/zero, a dropped
 * connection recovers, and malformed/unauthorized responses degrade
 * rather than throw. See overlay-transport.ts's header comment for the
 * design this asserts.
 */

function setHashToken(token: string | null) {
  window.location.hash = token ? `#token=${token}` : '';
}

function Harness<T>({ fetchSnapshot }: { fetchSnapshot: (apiOrigin: string, token: string, overlayId: string) => Promise<SnapshotOutcome<T>> }) {
  const { value, unavailable } = useOverlayTransport<T>({
    overlayId: 'ov1',
    fetchSnapshot,
    getApiOrigin: () => 'https://api.example.test',
    fallbackPollMs: 50,
  });
  return <div data-testid="state">{JSON.stringify({ value, unavailable })}</div>;
}

function readState() {
  return JSON.parse(screen.getByTestId('state').textContent ?? '{}') as { value: unknown; unavailable: boolean };
}

// A body-less/never-ok response for the events endpoint — every test below
// uses this unless it specifically exercises the stream itself, so the
// widget's displayed state only ever comes from the explicit snapshot read.
function neverConnectsEventsResponse() {
  return { ok: false, status: 503 };
}

test('shows current state immediately on connect, before any SSE stream could deliver an event', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  let snapshotCalls = 0;
  mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('/events')) return neverConnectsEventsResponse();
    snapshotCalls += 1;
    return { ok: false, status: 500 }; // unreachable branch guard below overrides
  });
  const fetchSnapshot = async (): Promise<SnapshotOutcome<{ n: number }>> => {
    snapshotCalls += 1;
    return { status: 'ok', value: { n: 42 } };
  };
  render(<Harness fetchSnapshot={fetchSnapshot} />);
  await waitFor(() => assert.equal((readState().value as { n: number } | null)?.n, 42));
  assert.ok(snapshotCalls >= 1);
  mock.reset();
});

test('a reconnect (stream drops mid-way, transient re-read fails) never resets an already-known value to empty', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('/events')) return neverConnectsEventsResponse();
    return { ok: false, status: 500 };
  });
  let call = 0;
  const fetchSnapshot = async (): Promise<SnapshotOutcome<{ n: number }>> => {
    call += 1;
    // First read succeeds with a real value; every read after that
    // simulates a transient failure during a reconnect window.
    if (call === 1) return { status: 'ok', value: { n: 7 } };
    return { status: 'error' };
  };
  render(<Harness fetchSnapshot={fetchSnapshot} />);
  await waitFor(() => assert.equal((readState().value as { n: number } | null)?.n, 7));
  // Let the fallback poll fire at least once more (transient failures) —
  // the rendered value must still be 7, never null/zero.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((readState().value as { n: number } | null)?.n, 7);
  assert.equal(readState().unavailable, false);
  mock.reset();
});

test('a dropped SSE connection (network error) recovers: the stream retries and reconnects on its own', async () => {
  setHashToken('overlay-token-cccccccccccccccccccccccccccccccc');
  let eventsAttempts = 0;
  mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('/events')) {
      eventsAttempts += 1;
      if (eventsAttempts === 1) throw new TypeError('network error');
      return neverConnectsEventsResponse();
    }
    return { ok: false, status: 500 };
  });
  const fetchSnapshot = async (): Promise<SnapshotOutcome<{ n: number }>> => ({ status: 'ok', value: { n: 1 } });
  render(<Harness fetchSnapshot={fetchSnapshot} />);
  await waitFor(() => assert.ok(eventsAttempts >= 2), { timeout: 3000 });
  mock.reset();
});

test('an unauthorized snapshot read clears to the empty state without throwing', async () => {
  setHashToken('overlay-token-dddddddddddddddddddddddddddddddd');
  mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('/events')) return neverConnectsEventsResponse();
    return { ok: false, status: 500 };
  });
  const fetchSnapshot = async (): Promise<SnapshotOutcome<{ n: number }>> => ({ status: 'unauthorized' });
  render(<Harness fetchSnapshot={fetchSnapshot} />);
  await waitFor(() => assert.equal(readState().unavailable, true));
  assert.equal(readState().value, null);
  mock.reset();
});

test('a malformed SSE frame (garbage data line) never throws — it only ever triggers a re-read, which itself validates', async () => {
  setHashToken('overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  const encoder = new TextEncoder();
  let streamed = false;
  mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('/events')) {
      if (streamed) return neverConnectsEventsResponse();
      streamed = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': replay-start\n\n'));
          controller.enqueue(encoder.encode('id: cur-1\nevent: goal.update\ndata: {not even json\n\n'));
          controller.close();
        },
      });
      return { ok: true, status: 200, body };
    }
    return { ok: false, status: 500 };
  });
  let snapshotCalls = 0;
  const fetchSnapshot = async (): Promise<SnapshotOutcome<{ n: number }>> => {
    snapshotCalls += 1;
    return { status: 'ok', value: { n: snapshotCalls } };
  };
  render(<Harness fetchSnapshot={fetchSnapshot} />);
  await waitFor(() => assert.ok(snapshotCalls >= 2), { timeout: 2000 }); // mount read + refetch triggered by the frame
  assert.doesNotThrow(() => readState());
  mock.reset();
});

test('no token in the hash: no fetch is made at all, and the widget renders its unavailable/empty state', async () => {
  setHashToken(null);
  let called = false;
  mock.method(globalThis, 'fetch', async () => { called = true; throw new Error('must not be called'); });
  const fetchSnapshot = async (): Promise<SnapshotOutcome<{ n: number }>> => { called = true; return { status: 'ok', value: { n: 1 } }; };
  render(<Harness fetchSnapshot={fetchSnapshot} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(called, false);
  assert.equal(readState().unavailable, true);
  mock.reset();
});
