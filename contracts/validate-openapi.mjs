import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(root, 'openapi', 'v1.yaml');
const source = await fs.readFile(file, 'utf8');
const document = parseDocument(source, { strict: true });
if (document.errors.length > 0) {
  throw new Error(`OpenAPI YAML parse failed: ${document.errors.map((error) => error.message).join('; ')}`);
}
const api = document.toJS({ maxAliasCount: 0 });
if (api?.openapi !== '3.1.0') throw new Error(`Expected OpenAPI 3.1.0, found ${api?.openapi ?? 'missing'}`);
if (!api?.info?.title || !api?.info?.version) throw new Error('OpenAPI info.title and info.version are required');
if (!api?.paths || typeof api.paths !== 'object' || Object.keys(api.paths).length === 0) throw new Error('OpenAPI paths are required');
if (/youtube|enterprise/i.test(JSON.stringify(api))) throw new Error('v1 OpenAPI must not contain YouTube or Enterprise scope');

function pointer(rootValue, reference) {
  if (!reference.startsWith('#/')) throw new Error(`External or malformed $ref is not allowed: ${reference}`);
  return reference.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((value, part) => {
    if (value === undefined || value === null || !(part in value)) return undefined;
    return value[part];
  }, rootValue);
}

const missing = [];
function visit(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if ('$ref' in value) {
    const resolved = pointer(api, value.$ref);
    if (resolved === undefined) missing.push(`${location}: ${value.$ref}`);
  }
  for (const [key, child] of Object.entries(value)) visit(child, `${location}.${key}`);
}
visit(api, 'root');
if (missing.length > 0) throw new Error(`OpenAPI local $ref target(s) missing:\n${missing.join('\n')}`);

console.log(`Validated OpenAPI 3.1 document with ${Object.keys(api.paths).length} paths and all local $ref targets.`);
