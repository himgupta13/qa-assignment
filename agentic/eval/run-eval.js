#!/usr/bin/env node
// Eval layer for the test-generation agentic workflow. Three gates, in order, each one
// cheaper/faster than the next so we fail fast:
//
//   1. Spec conformance   — static check, no execution. Catches hallucinated endpoints.
//   2. TypeScript compile — catches syntactically invalid or type-unsafe generated code.
//   3. Mutation kill rate — run the suite against a FAITHFUL mock (must all pass) and
//      then a MUTATED mock with known injected bugs (must catch at least one). This is
//      the answer to "how do you know the output is correct": a suite that passes
//      against both a correct and a broken implementation isn't testing anything — it's
//      asserting the response has *a* body, not that the body is *right*.
'use strict';

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  return result.status === 0;
}

function waitForServer(url, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() - start > timeoutMs) reject(new Error(`Server at ${url} never came up`));
          else setTimeout(attempt, 200);
        });
    })();
  });
}

async function runAgainstMock(mode) {
  const server = spawn('node', ['eval/mock-server.js'], {
    cwd: ROOT,
    env: { ...process.env, MODE: mode, PORT: '4000' },
    stdio: 'pipe',
  });

  try {
    await waitForServer('http://localhost:4000/api/products');
    const result = spawnSync('npx', ['playwright', 'test'], {
      cwd: ROOT,
      env: { ...process.env, BASE_URL: 'http://localhost:4000' },
      encoding: 'utf-8',
    });
    return { passed: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  } finally {
    server.kill();
  }
}

async function main() {
  console.log('\n=== Gate 1: spec conformance ===');
  if (!run('node', ['eval/spec-conformance-check.js'])) {
    console.error('\nEVAL FAILED at Gate 1 (spec conformance). Fix hallucinated endpoints before proceeding.');
    process.exit(1);
  }

  console.log('\n=== Gate 2: TypeScript compile ===');
  if (!run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'])) {
    console.error('\nEVAL FAILED at Gate 2 (typecheck). Generated code does not compile.');
    process.exit(1);
  }

  console.log('\n=== Gate 3a: run against FAITHFUL mock (expect all pass) ===');
  const faithful = await runAgainstMock('faithful');
  console.log(faithful.stdout);
  if (!faithful.passed) {
    console.error('\nEVAL FAILED at Gate 3a. Generated tests fail against a correct implementation — false positives.');
    process.exit(1);
  }

  console.log('\n=== Gate 3b: run against MUTATED mock (expect at least one failure) ===');
  const mutated = await runAgainstMock('mutated');
  console.log(mutated.stdout);
  if (mutated.passed) {
    console.error(
      '\nEVAL FAILED at Gate 3b. Generated tests ALL PASSED against a deliberately broken implementation ' +
        '— the suite has zero mutation-kill power and is not actually testing the contract.'
    );
    process.exit(1);
  }

  console.log(
    '\n=== EVAL PASSED ===\n' +
      'Gate 1 (conformance): OK\n' +
      'Gate 2 (typecheck): OK\n' +
      'Gate 3a (faithful mock, all pass): OK\n' +
      'Gate 3b (mutated mock, caught at least one injected bug): OK\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
