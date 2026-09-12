import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiSourceDirectory = path.join(root, '..', 'apps', 'api', 'src');
const routeDirectory = path.join(apiSourceDirectory, 'routes');
const routeFiles = [
  path.join(apiSourceDirectory, 'app.ts'),
  ...((await fs.readdir(routeDirectory)).filter((name) => name.endsWith('.ts')).sort().map((name) => path.join(routeDirectory, name))),
];
const routeCallPattern = /app\.(get|post|put|patch|delete|head|options)\b/g;
// Route registrations use a literal path as their first runtime argument. The
// generic portion is intentionally non-greedy: it accepts the nested generic
// types in Fastify handlers while still requiring the following call paren.
const literalRoutePattern = /app\.(get|post|put|patch|delete|head|options)(?:<[\s\S]*?>)?\(\s*(['"])(\/[^'"\r\n]*)\2/g;

const runtimeOperations = new Map();
let routeCallCount = 0;
for (const file of routeFiles) {
  const source = await fs.readFile(file, 'utf8');
  routeCallCount += [...source.matchAll(routeCallPattern)].length;
  for (const match of source.matchAll(literalRoutePattern)) {
    const method = match[1].toUpperCase();
    const route = match[3].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const key = `${method} ${route}`;
    if (runtimeOperations.has(key)) throw new Error(`Duplicate literal Fastify route declaration: ${key}`);
    runtimeOperations.set(key, path.relative(root, file));
  }
}

if (runtimeOperations.size !== routeCallCount) {
  throw new Error(
    `Could not inventory every Fastify route declaration: found ${routeCallCount} app.<method> calls but ${runtimeOperations.size} literal paths. `
    + 'Use a literal first path argument or extend contracts/runtime-route-inventory.mjs before shipping the route.',
  );
}

const document = parseDocument(await fs.readFile(path.join(root, 'openapi', 'v1.yaml'), 'utf8'), { strict: true });
if (document.errors.length > 0) throw new Error(`OpenAPI YAML parse failed: ${document.errors.map((error) => error.message).join('; ')}`);
const openApi = document.toJS({ maxAliasCount: 0 });
const documentedOperations = new Set();
for (const [route, pathItem] of Object.entries(openApi.paths ?? {})) {
  if (!pathItem || typeof pathItem !== 'object') continue;
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
    if (pathItem[method]) documentedOperations.add(`${method.toUpperCase()} ${route}`);
  }
}

const undocumented = [...runtimeOperations.keys()].filter((key) => !documentedOperations.has(key)).sort();
const stale = [...documentedOperations].filter((key) => !runtimeOperations.has(key)).sort();
const documentedRuntimeOperations = runtimeOperations.size - undocumented.length;

console.log(`Runtime route inventory: ${runtimeOperations.size} literal operations; ${documentedRuntimeOperations} covered by the approved OpenAPI; ${undocumented.length} outside that published surface; ${stale.length} stale OpenAPI operations.`);
if (undocumented.length > 0) {
  console.log('\nRuntime operations outside the published OpenAPI:');
  for (const key of undocumented) console.log(`- ${key} (${runtimeOperations.get(key)})`);
}
if (stale.length > 0) {
  console.log('\nOpenAPI operations absent from runtime:');
  for (const key of stale) console.log(`- ${key}`);
}
