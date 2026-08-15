import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('static Alerts deployment ships a browser security-header contract', () => {
  const headers = readFileSync(join(process.cwd(), 'public', '_headers'), 'utf8');
  assert.match(headers, /X-Content-Type-Options:\s+nosniff/);
  assert.match(headers, /Referrer-Policy:\s+strict-origin-when-cross-origin/);
  assert.match(headers, /X-Frame-Options:\s+DENY/);
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /https:\/\/accounts\.google\.com/);
  assert.match(headers, /https:\/\/checkout\.razorpay\.com/);
  assert.doesNotMatch(headers, /RAZORPAY_KEY_SECRET|DATABASE_URL|NOTIFICATION_TOKEN/);
});
