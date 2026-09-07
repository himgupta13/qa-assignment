# Automation Strategy

## Tool choice: Playwright + TypeScript

- **One framework, two layers.** Playwright runs API tests (via `request` fixture) and browser E2E tests
  from the same project, config, reporter, and CI job. For a team of 4 covering 20 services, minimizing the
  number of distinct tools they need to context-switch between matters more than picking the theoretically
  best tool for each layer individually.
- **Matches the stack.** The frontend is Next.js/TypeScript; the frontend BFF (`/api/*`) is what most of our
  tests hit. Writing tests in the same language as the system under test means any QA engineer can read the
  frontend source directly when a test fails, without a translation step.
- **The demo repo already ships a Cypress suite** (`opentelemetry-demo/src/frontend/cypress/e2e/`, 4 files,
  ~250 lines, golden-path UI coverage). I did not duplicate it. Our suite is deliberately complementary:
  API-level negative and fault-injection paths (`cartFailure`, `paymentFailure`, `productCatalogFailure`)
  that the existing suite doesn't cover, plus one Playwright E2E test so the whole thing runs from a single
  command. A real team inheriting both suites would either consolidate onto one tool over time or explicitly
  own the boundary (Cypress = UI regression, Playwright = API/contract) — I'd bring this exact tradeoff to
  the team rather than silently picking one.
- **Not chosen:** a Python (pytest + requests) stack, despite the backend being polyglot with real Python
  services — because the surface we actually integration-test is the frontend BFF, and testing a
  TypeScript API in TypeScript keeps one fewer language in the loop for the common case. I would revisit this
  if the team's automation scope expanded to testing individual backend services directly over gRPC as a
  primary activity rather than an exception (see `product-catalog.grpc.spec.ts` — right now that's one file,
  not a pattern I'd want to scale without reconsidering the language choice).

## Structuring this for a team of 4, not just this assignment

- **Own by flow, not by file.** Matches the pod structure in `test-strategy.md` §3: the Checkout/Payments
  pod owns `tests/api/checkout.spec.ts` and reviews any PR touching it; Cart/Catalog owns the other two
  spec files. `fixtures/` (flagd control, test data, gRPC client) is shared infrastructure — changes there
  need sign-off from whoever's on automation-platform duty that quarter, because a broken fixture breaks
  every pod's tests at once.
- **Test data lives in `fixtures/testData.ts`, not hardcoded per test.** Real product IDs sourced from the
  demo's own seed data (`postgresql/init.sql`), not invented — so tests fail because of real behavior
  changes, not because someone typo'd a product ID that happened to work by accident. As the team adds
  tests, new fixtures get added here, not copy-pasted into new spec files.
- **flagd control is centralized in `fixtures/flagd.ts`.** Every fault-injection test goes through the same
  read-modify-write helper against the frontend's `/feature/api/{read,write}` proxy (confirmed by reading
  the demo's own Cypress test, not guessed). One place to fix if flagd's control mechanism ever changes.

## CI: where tests run, on what triggers

```
PR opened/updated
   │
   ├─▶ npm run test:api   (docker compose up in CI runner; ~2-4 min; blocks merge)
   │
   └─▶ npm run test:e2e   (golden path only; ~1-2 min; blocks merge)

merge to main
   └─▶ full suite + gRPC test (with PRODUCT_CATALOG_GRPC_ADDR resolved) + flagd fault matrix
        nightly, not per-PR — this is where the probabilistic cartFailure percentages
        (10/25/50/75/90%) would get their statistical-sample treatment if we ever built it
```

API tests block every PR because they're fast (~seconds each, no browser) and deterministic. E2E blocks too,
but is kept to one golden-path test specifically so a flaky browser test never becomes a merge-blocking
liability — if it needs to grow, new E2E tests go to the nightly tier first and only get promoted to
PR-blocking once they've proven stable over ~2 weeks.

## Failure surfacing

- Playwright's built-in HTML + JSON reporters (already configured in `playwright.config.ts`) — JSON output
  is what a CI job would parse to post a PR comment summarizing pass/fail by test case ID (the `TC-XX-NN`
  prefixes in test names exist specifically so this mapping is mechanical, not manual).
  `trace: 'retain-on-failure'` and `video: 'retain-on-failure'` mean a failing test in CI is debuggable
  without reproducing locally first — for a distributed system with 20 services, "can't reproduce locally"
  is the default state, not the exception.
- `test.info().annotations.push({ type: 'quality-risk', ... })` (used in a few tests, e.g. TC-CO-04, TC-PC-01
  JPY rounding) surfaces things that are worth a human's attention but aren't necessarily bugs — these
  should route to a triage channel/ticket queue, not silently pass or silently fail the build.

## Flakiness

- **Real fixture cleanup, not hope.** Every fault-injection test resets its flagd flag in `afterEach`, so a
  test that fails mid-run doesn't leave `paymentFailure` stuck at 100% and cascade-fail every test after it —
  this is the single most common cause of "flaky" suites in systems with global mutable state like flagd.
- **Unique test data per run**, not shared fixtures — `uniqueUserId()` timestamps every session ID so
  parallel test runs (Playwright's default `fullyParallel: true`) never collide on the same cart/session,
  which would otherwise produce nondeterministic cross-test interference that looks like flakiness but is
  actually a test-isolation bug.
- **Quarantine, not silent retry-until-green.** `retries: 1` in CI absorbs genuine network blips against a
  freshly-started docker-compose stack. A test that fails, passes on retry, and does this repeatedly across
  runs should be pulled from the blocking suite into a quarantine list (tagged, tracked, and reviewed weekly
  by whoever owns automation-platform that quarter) rather than left to erode trust in the whole suite —
  "the pipeline is always red so nobody looks at it" is the actual failure mode I'm optimizing against, not
  any single flaky test.
- **The probabilistic flagd percentages are the known flakiness risk I haven't automated** (see
  `automation/README.md` — TC-CT-03 is deliberately scripted at 100% only). If this team ever needs the
  10-90% sweep automated, it needs a statistically-sized sample and a tolerance band from day one, not a
  single assertion that happens to pass most of the time — that's exactly the kind of test that becomes
  "the flaky one everyone ignores."

## Test data

No shared, mutating fixtures. Every test generates its own `userId`/session via `uniqueUserId()` and its own
cart from scratch. This trades a little setup boilerplate per test for zero test-order dependency — any test
can run alone, in any order, in parallel, and be re-run without a database reset step. The tradeoff I'd
revisit if the team ever adds tests needing pre-existing historical data (e.g., "a returning customer with
order history") — that would need a seeded, versioned fixture dataset, not per-test generation.
