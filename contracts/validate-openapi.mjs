import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.OPENAPI_FILE ? path.resolve(process.env.OPENAPI_FILE) : path.join(root, 'openapi', 'v1.yaml');
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

// A parsed document can still be unsafe for client generation if an operation
// has no stable identity, omits a path parameter, or silently documents an
// untyped success/body. Keep these checks here, next to ref resolution, so
// `pnpm contracts:validate` protects the published wire contract rather than
// merely its YAML syntax.
const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const operationIds = new Set();
const contractFailures = [];

function resolve(value, location) {
  if (!value || typeof value !== 'object') return value;
  if ('$ref' in value) {
    const resolved = pointer(api, value.$ref);
    if (resolved === undefined) {
      contractFailures.push(`${location}: unresolved reference ${value.$ref}`);
      return undefined;
    }
    return resolved;
  }
  return value;
}

function hasSchema(content, location) {
  if (!content || typeof content !== 'object') {
    contractFailures.push(`${location}: content is required with a schema`);
    return;
  }
  const mediaTypes = Object.entries(content);
  if (mediaTypes.length === 0) {
    contractFailures.push(`${location}: at least one media type is required`);
    return;
  }
  for (const [mediaType, media] of mediaTypes) {
    if (!media || typeof media !== 'object' || !media.schema || typeof media.schema !== 'object') {
      contractFailures.push(`${location}.${mediaType}: a schema is required`);
    }
  }
}

for (const [route, pathItem] of Object.entries(api.paths)) {
  if (!route.startsWith('/')) contractFailures.push(`paths.${route}: path must begin with /`);
  if (!pathItem || typeof pathItem !== 'object') {
    contractFailures.push(`paths.${route}: path item must be an object`);
    continue;
  }
  const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
  const placeholders = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  for (const [method, rawOperation] of Object.entries(pathItem)) {
    if (!httpMethods.has(method)) continue;
    const operation = resolve(rawOperation, `paths.${route}.${method}`);
    if (!operation || typeof operation !== 'object') {
      contractFailures.push(`paths.${route}.${method}: operation must be an object`);
      continue;
    }
    if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
      contractFailures.push(`paths.${route}.${method}: operationId is required`);
    } else if (operationIds.has(operation.operationId)) {
      contractFailures.push(`paths.${route}.${method}: duplicate operationId ${operation.operationId}`);
    } else {
      operationIds.add(operation.operationId);
    }
    if (!Array.isArray(operation.tags) || operation.tags.length === 0) {
      contractFailures.push(`paths.${route}.${method}: at least one tag is required`);
    }

    const parameters = [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
      .map((parameter, index) => resolve(parameter, `paths.${route}.${method}.parameters[${index}]`))
      .filter(Boolean);
    for (const name of placeholders) {
      const parameter = parameters.find((candidate) => candidate.in === 'path' && candidate.name === name);
      if (!parameter) contractFailures.push(`paths.${route}.${method}: missing path parameter ${name}`);
      else if (parameter.required !== true) contractFailures.push(`paths.${route}.${method}: path parameter ${name} must be required`);
      else if (!parameter.schema || typeof parameter.schema !== 'object') contractFailures.push(`paths.${route}.${method}: path parameter ${name} needs a schema`);
    }

    if (operation.requestBody !== undefined) {
      const requestBody = resolve(operation.requestBody, `paths.${route}.${method}.requestBody`);
      if (!requestBody || typeof requestBody !== 'object') contractFailures.push(`paths.${route}.${method}: requestBody must be an object`);
      else {
        if (requestBody.required !== true) contractFailures.push(`paths.${route}.${method}: requestBody must be required when present`);
        hasSchema(requestBody.content, `paths.${route}.${method}.requestBody`);
      }
    }

    if (!operation.responses || typeof operation.responses !== 'object') {
      contractFailures.push(`paths.${route}.${method}: responses are required`);
      continue;
    }
    const successResponses = Object.entries(operation.responses).filter(([status]) => /^2\d\d$/.test(status));
    if (successResponses.length === 0) contractFailures.push(`paths.${route}.${method}: at least one 2xx response is required`);
    for (const [status, rawResponse] of successResponses) {
      const response = resolve(rawResponse, `paths.${route}.${method}.responses.${status}`);
      if (!response || typeof response !== 'object') {
        contractFailures.push(`paths.${route}.${method}.responses.${status}: response must be an object`);
        continue;
      }
      if (typeof response.description !== 'string' || response.description.length === 0) {
        contractFailures.push(`paths.${route}.${method}.responses.${status}: description is required`);
      }
      if (status !== '204') hasSchema(response.content, `paths.${route}.${method}.responses.${status}`);
    }
  }
}

if (contractFailures.length > 0) {
  throw new Error(`OpenAPI operation contract validation failed:\n${contractFailures.join('\n')}`);
}

console.log(`Validated OpenAPI 3.1 document with ${Object.keys(api.paths).length} paths, ${operationIds.size} operation contracts, and all local $ref targets.`);
