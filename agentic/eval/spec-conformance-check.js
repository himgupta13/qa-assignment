#!/usr/bin/env node
// Static check: every HTTP call the generated test suite makes must target a path+method
// that actually exists in agentic/openapi/frontend-api.yaml. This is the guardrail against
// the agent hallucinating an endpoint that sounds plausible but isn't in the contract —
// a cheap, fast check that runs before we ever spend time executing the generated tests.
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SPEC_PATH = path.resolve(__dirname, '../openapi/frontend-api.yaml');
const AGENTIC_DIR = path.resolve(__dirname, '..');

// Dynamically discover every generated-suite directory (agentic/generated/,
// agentic/generated-test/, or any future agentic/generated-*/) instead of hardcoding one
// directory name, so conformance checking follows wherever a suite actually got written.
function findGeneratedDirs() {
  return fs
    .readdirSync(AGENTIC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^generated/.test(entry.name))
    .map((entry) => path.join(AGENTIC_DIR, entry.name));
}

function loadSpecPaths() {
  const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf-8'));
  const entries = [];
  for (const [pathTemplate, methods] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(methods)) {
      // Turn /products/{productId} into a regex that matches /products/OLJCESPC7Z etc.
      const regexStr = '^' + pathTemplate.replace(/\{[^}]+\}/g, '[^/]+') + '(\\?.*)?$';
      entries.push({ method: method.toUpperCase(), pathTemplate, regex: new RegExp(regexStr) });
    }
  }
  return entries;
}

function extractCalls(fileContent) {
  // Matches request.get('/products/x'), request.post(`/checkout?...`), etc.
  const callRe = /request\.(get|post|put|delete|patch)\(\s*[`'"]([^`'"]+)[`'"]/g;
  const calls = [];
  let m;
  while ((m = callRe.exec(fileContent))) {
    calls.push({ method: m[1].toUpperCase(), url: m[2] });
  }
  return calls;
}

function normalizeUrl(url) {
  // Strip a leading /api if present (spec paths are relative to servers[0], which already
  // includes /api), and collapse template-literal interpolations to a placeholder segment
  // so `${PRODUCT_IDS.X}` still matches `{productId}`'s regex (`[^/]+`).
  return url.replace(/^\/api/, '').replace(/\$\{[^}]+\}/g, 'X');
}

function main() {
  const specPaths = loadSpecPaths();
  const generatedDirs = findGeneratedDirs();
  if (generatedDirs.length === 0) {
    console.error(`No generated* directory found under ${AGENTIC_DIR}`);
    process.exit(1);
  }

  let fileCount = 0;
  let violations = [];
  for (const dir of generatedDirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.spec.ts'));
    for (const file of files) {
      fileCount += 1;
      const relPath = path.join(path.basename(dir), file);
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const calls = extractCalls(content);
      for (const call of calls) {
        const normalized = normalizeUrl(call.url);
        const matches = specPaths.some((p) => p.method === call.method && p.regex.test(normalized));
        if (!matches) {
          violations.push(`${relPath}: ${call.method} ${call.url} does not match any operation in frontend-api.yaml`);
        }
      }
    }
  }

  if (fileCount === 0) {
    console.error('No generated *.spec.ts files found — nothing to check.');
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error('CONFORMANCE FAILED — generated tests call endpoints not in the spec:');
    violations.forEach((v) => console.error('  - ' + v));
    process.exit(1);
  }

  console.log(
    `CONFORMANCE OK — checked ${fileCount} generated file(s) across ${generatedDirs.length} ` +
      `director${generatedDirs.length === 1 ? 'y' : 'ies'} (${generatedDirs.map((d) => path.basename(d)).join(', ')}), ` +
      `all calls trace to a spec'd operation.`
  );
}

main();
