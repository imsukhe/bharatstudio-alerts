import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(root, 'validate-openapi.mjs');
const source = await readFile(path.join(root, 'openapi', 'v1.yaml'), 'utf8');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'bharatstudio-openapi-validator-'));

// AUD-PAY-01: this runtime field pre-dates this test, but omitting it from the
// published direct-tip request schema makes generated clients reject the exact
// browser request the API accepts. Keep the public contract parity check next
// to the general OpenAPI validator cases rather than relying on a text grep.
const api = parseDocument(source, { strict: true }).toJS({ maxAliasCount: 0 });
const directTipOrder = api.paths['/v1/public/channels/{handle}/tips/orders'].post;
assert.deepEqual(directTipOrder.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CreateTipOrderRequest');
assert.deepEqual(api.components.schemas.CreateTipOrderRequest.properties.turnstileToken.type, ['string', 'null']);
assert.equal(api.components.schemas.CreateTipOrderRequest.properties.turnstileToken.maxLength, 2048);
assert.ok(directTipOrder.responses['403'], 'direct tip order must document the existing bot-verification outcome');

const cases = [
  {
    name: 'duplicate operation ID',
    source: source.replace('operationId: exchangeGoogleIdentity', 'operationId: getPublicChannel'),
    expected: 'duplicate operationId getPublicChannel',
  },
  {
    name: 'untyped successful response',
    source: source.replace(
      "        '202':\n          description: Idempotent maintenance run accepted or already recorded.\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/MaintenanceResult'",
      "        '202':\n          description: Idempotent maintenance run accepted or already recorded.",
    ),
    expected: 'responses.202: content is required with a schema',
  },
  {
    name: 'undeclared path parameter',
    source: source.replace('      parameters:\n        - $ref: \'#/components/parameters/Handle\'\n      responses:', '      responses:'),
    expected: 'missing path parameter handle',
  },
];

try {
  for (const [index, testCase] of cases.entries()) {
    const fixture = path.join(temporaryDirectory, `${index}.yaml`);
    await writeFile(fixture, testCase.source, 'utf8');
    const result = spawnSync(process.execPath, [validator], {
      env: { ...process.env, OPENAPI_FILE: fixture },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${testCase.name}: validator unexpectedly passed`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(testCase.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  console.log(`Validated ${cases.length} negative OpenAPI operation-contract cases.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
