import assert from 'node:assert/strict';
import test from 'node:test';
import { neutralizeUrls, type UrlDomainRuleForMatching } from '../src/domain/url-neutralization.js';

/*
 * SAF-10 (packages/db/migrations/0154). Pure, DB-free tests of the
 * transform itself. The store's own correctness (persistence, auth) is
 * proven in apps/api/test/url-domain-rules-routes.test.ts; the database
 * layer's own guarantees (empty-by-default, structural allow/deny
 * precedence via the unique index) are proven in
 * packages/db/tests/saf_url_ssml_pii.sql.
 */

test('SAF-10: an unlisted URL is neutralised by default -- the reused TTS-side baseline, not an invented one', () => {
  const result = neutralizeUrls('check this out https://unlisted.example/path', []);
  assert.equal(result.text, 'check this out  link removed ');
  assert.equal(result.neutralizedCount, 1);
  assert.deepEqual(result.neutralizedHosts, ['unlisted.example']);
});

test('SAF-10: an empty domain-rule list neutralises every URL by the baseline, never zero and never "deny everything" via some inverted-empty-array bug', () => {
  const clean = neutralizeUrls('no links here at all', []);
  assert.equal(clean.text, 'no links here at all');
  assert.equal(clean.neutralizedCount, 0);

  const withUrl = neutralizeUrls('https://a.example and https://b.example', []);
  assert.equal(withUrl.neutralizedCount, 2);
});

test('SAF-10: an allow-listed domain is passed through untouched; the rest of the message keeps its original casing', () => {
  const rules: UrlDomainRuleForMatching[] = [{ domain: 'mychannel.example', rule: 'allow' }];
  const result = neutralizeUrls('My Own Link: https://mychannel.example/merch', rules);
  assert.equal(result.text, 'My Own Link: https://mychannel.example/merch');
  assert.equal(result.neutralizedCount, 0);
});

test('SAF-10: a deny-listed domain is always neutralised', () => {
  const rules: UrlDomainRuleForMatching[] = [{ domain: 'scam.example', rule: 'deny' }];
  const result = neutralizeUrls('go here https://scam.example/free-money', rules);
  assert.equal(result.neutralizedCount, 1);
  assert.deepEqual(result.neutralizedHosts, ['scam.example']);
});

test('SAF-10 precedence: deny, allow and default each resolve independently and correctly across three different domains in the same message', () => {
  const rules: UrlDomainRuleForMatching[] = [
    { domain: 'good.example', rule: 'allow' },
    { domain: 'bad.example', rule: 'deny' },
  ];
  const result = neutralizeUrls(
    'safe https://good.example/a scam https://bad.example/b unknown https://unlisted.example/c',
    rules,
  );
  assert.match(result.text, /safe https:\/\/good\.example\/a/); // allow: untouched
  assert.doesNotMatch(result.text, /bad\.example/); // deny: neutralised
  assert.doesNotMatch(result.text, /unlisted\.example/); // default: neutralised
  assert.deepEqual(result.neutralizedHosts.sort(), ['bad.example', 'unlisted.example']);
});

test('SAF-10: domain comparison is case-insensitive and resists zero-width-character evasion inside the host, via the ONE shared normalizeForSafetyMatching call', () => {
  const rules: UrlDomainRuleForMatching[] = [{ domain: 'mychannel.example', rule: 'allow' }];
  const upper = neutralizeUrls('https://MyChannel.Example/path', rules);
  assert.equal(upper.neutralizedCount, 0, 'case must not defeat an allow rule');
});

test('SAF-10: a message with no URLs at all is returned byte-for-byte unchanged', () => {
  const text = 'thanks for the stream, loved it!';
  const result = neutralizeUrls(text, []);
  assert.equal(result.text, text);
  assert.equal(result.neutralizedCount, 0);
  assert.deepEqual(result.neutralizedHosts, []);
});

test('SAF-10: neutralised audit trail records hosts only -- never the raw URL, path or query string', () => {
  const result = neutralizeUrls('https://unlisted.example/secret-path?token=abc123', []);
  assert.deepEqual(result.neutralizedHosts, ['unlisted.example']);
  assert.ok(!result.neutralizedHosts.some((h) => h.includes('token') || h.includes('secret-path')));
});
