import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiOrigin } from './api-origin';

test('development may use the local API default', () => {
  assert.equal(getApiOrigin(undefined, 'development'), 'http://localhost:4100');
});

test('production requires an explicit HTTPS API origin', () => {
  assert.throws(() => getApiOrigin(undefined, 'production'), /api_origin_not_configured/);
  assert.throws(() => getApiOrigin('http://api.example.test', 'production'), /api_origin_must_use_https/);
  assert.throws(() => getApiOrigin('https://localhost:4100', 'production'), /api_origin_must_not_use_localhost/);
  assert.equal(getApiOrigin('https://api.example.test/', 'production'), 'https://api.example.test');
});

test('invalid API origins fail closed', () => {
  assert.throws(() => getApiOrigin('not a URL', 'development'), /api_origin_invalid/);
  assert.throws(() => getApiOrigin('file:///tmp/api', 'development'), /api_origin_invalid/);
  assert.throws(() => getApiOrigin('http://api.example.test/base', 'development'), /api_origin_invalid/);
  assert.throws(() => getApiOrigin('http://api.example.test/?token=secret', 'development'), /api_origin_invalid/);
});
