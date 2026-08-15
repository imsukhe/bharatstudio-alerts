import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(root, 'json-schema');
const fixtureDir = path.join(root, 'fixtures');
const enumDir = path.join(root, 'enums');
const openApiFile = path.join(root, 'openapi', 'v1.yaml');
const catalogueFile = path.join(root, 'template-catalogue.json');

const fixtureToSchema = {
  'alert-event.json': 'alert-event.schema.json',
  'api/channel-config.json': 'channel-config-response.schema.json',
  'cloud-task-command.json': 'cloud-task-command.schema.json',
  'entitlement-result.json': 'entitlement-result.schema.json',
  'error-envelope.json': 'error-envelope.schema.json',
  'multi-queue-delivery.json': 'multi-queue-delivery.schema.json',
  'overlay-reconnect.json': 'overlay-reconnect-case.schema.json',
  'overlay-sse-event.json': 'overlay-sse-event.schema.json',
  'payment-webhook-delivery.json': 'payment-webhook-delivery.schema.json',
  'payment-webhook-duplicate.json': 'payment-webhook-duplicate.schema.json',
  'queue-delivery.json': 'queue-delivery.schema.json',
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemaCache = new Map();
async function loadSchema(fileName) {
  if (!schemaCache.has(fileName)) {
    const schema = JSON.parse(await fs.readFile(path.join(schemaDir, fileName), 'utf8'));
    schemaCache.set(fileName, schema);
    ajv.addSchema(schema);
  }
  return schemaCache.get(fileName);
}

await loadSchema('channel-config.schema.json');

const failures = [];

const catalogue = JSON.parse(await fs.readFile(catalogueFile, 'utf8'));
if (catalogue.schemaVersion !== 'v1' || catalogue.catalogueId !== 'visuals-v6') failures.push('template-catalogue.json: invalid catalogue identity');
if (catalogue.authoritativeDesignCount !== 600 || catalogue.familyCount !== 30 || catalogue.variantsPerFamily !== 20) failures.push('template-catalogue.json: expected 600 designs, 30 families and 20 variants per family');
if (!Array.isArray(catalogue.supportedEvents) || catalogue.supportedEvents.length !== 12) failures.push('template-catalogue.json: expected 12 supported event types');
if (!Array.isArray(catalogue.families) || catalogue.families.length !== 30) failures.push('template-catalogue.json: expected 30 family records');
if (catalogue.knownIntegrityFindings?.metadataExceptions?.length !== 0) failures.push('template-catalogue.json: unresolved metadata exceptions remain');
const expectedTiers = { free: 'v01', creator: 'v07', studio: 'v15' };
for (const [tier, variant] of Object.entries(expectedTiers)) {
  if (catalogue.tierMinimumVariant?.[tier] !== variant) failures.push(`template-catalogue.json: ${tier} minimum variant must be ${variant}`);
}
for (let index = 0; index < (catalogue.families ?? []).length; index += 1) {
  const family = catalogue.families[index];
  const start = index * 20 + 1;
  const end = start + 19;
  const expectedRange = `BSA-${String(start).padStart(3, '0')}..BSA-${String(end).padStart(3, '0')}`;
  if (family.familyId !== `F${String(index + 1).padStart(2, '0')}` || family.designRange !== expectedRange) {
    failures.push(`template-catalogue.json: family ${index + 1} range is not contiguous (${expectedRange})`);
  }
}

// v1 deliberately excludes YouTube and Enterprise. Keep this guard scoped to
// executable contract artifacts only: planning documents may mention the
// excluded products, but a route/schema/fixture must not quietly introduce
// them into the client contract.
const forbiddenContractTerms = [
  /youtube/i,
  /enterprise/i,
  /youtube\.readonly/i,
  /youtube\.channel-memberships\.creator/i,
];
const contractFiles = [
  openApiFile,
  ...((await fs.readdir(schemaDir)).filter((name) => name.endsWith('.json')).map((name) => path.join(schemaDir, name))),
  ...((await fs.readdir(enumDir)).filter((name) => name.endsWith('.json')).map((name) => path.join(enumDir, name))),
  ...((await fs.readdir(fixtureDir, { recursive: true })).filter((name) => typeof name === 'string' && (name.endsWith('.json') || name.endsWith('.yaml'))).map((name) => path.join(fixtureDir, name))),
];
for (const file of contractFiles) {
  const text = await fs.readFile(file, 'utf8');
  const matched = forbiddenContractTerms.find((term) => term.test(text));
  if (matched) failures.push(`${path.relative(root, file)}: forbidden v1 capability term ${matched}`);
}

for (const [fixtureName, schemaName] of Object.entries(fixtureToSchema)) {
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureDir, fixtureName), 'utf8'));
  const schema = await loadSchema(schemaName);
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  if (fixture.$schema !== schema.$id) {
    failures.push(`${fixtureName}: $schema must equal ${schema.$id}`);
    continue;
  }
  if (!validate(fixture)) {
    failures.push(`${fixtureName}: ${ajv.errorsText(validate.errors)}`);
  }
}

// Prove the format plugin is active rather than merely configured: an invalid
// UUID must be rejected by the same compiled contract used for fixtures.
const alertSchema = await loadSchema('alert-event.schema.json');
const alertValidator = ajv.getSchema(alertSchema.$id);
const invalidFormatFixture = JSON.parse(await fs.readFile(path.join(fixtureDir, 'alert-event.json'), 'utf8'));
invalidFormatFixture.eventId = 'not-a-uuid';
if (alertValidator(invalidFormatFixture)) {
  failures.push('alert-event.json: invalid UUID negative case was accepted');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${Object.keys(fixtureToSchema).length} fixtures plus the v1 template catalogue contract with Draft 2020-12, format enforcement and v1 capability exclusion (including invalid-UUID rejection).`);
}
