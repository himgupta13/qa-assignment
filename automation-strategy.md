# Automation Strategy

## Tool choice: Playwright + TypeScript

- **One framework, two layers.** Playwright runs API tests (via `request` fixture) and browser E2E tests from the same project, config, reporter, and CI job. For a team of 4 covering 20 services, minimizing the number of distinct tools they need to context-switch between matters more than picking the theoretically best tool for each layer individually.

- **Matches the stack.** The frontend is Next.js/TypeScript; the frontend BFF (`/api/*`) is what most of our tests hit. Writing tests in the same language as the system under test means any QA engineer can read the frontend source directly when a test fails, without a translation step and vice-versa.


## Structuring this for a team of 4, not just this assignment

- **Own by flow, not by file.** Matches the pod structure in `test-strategy.md` §3: the Checkout/Payments pod owns `tests/api/checkout.spec.ts` and reviews any PR touching it; Cart/Catalog owns the other two spec files. `fixtures/` (flagd control, test data) is shared infrastructure — changes there need sign-off from whoever's on automation-platform duty that quarter, because a broken fixture breaks every pod's tests at once.
- **Test data lives in `fixtures/testData.ts`, not hardcoded per test.** Real product IDs sourced from the demo's own seed data (`postgresql/init.sql`), not invented — so tests fail because of real behavior changes, not because someone typo'd a product ID that happened to work by accident. As the team adds tests, new fixtures get added here, not copy-pasted into new spec files.
- **flagd control is centralized in `fixtures/flagd.ts`.** Every fault-injection test goes through the same read-modify-write helper against the frontend's `/feature/api/{read,write}` proxy (confirmed by reading the demo's own Cypress test, not guessed). One place to fix if flagd's control mechanism ever changes.

## CI: where tests run, on what triggers

```
API Test Case execution on each Dev PR opened/updated                                                    
   │
   ├─▶ npm run test:api   (docker compose up in CI runner; ~2-4 min; blocks merge)
   │      tests/api/checkout.spec.ts    
   │      tests/api/cart.spec.ts           
   │      tests/api/product-catalog.spec.ts 
   │
   └─▶ npm run test:e2e   (golden path only; ~1-2 min; blocks merge)
          tests/e2e/golden-path.spec.ts     — browse → cart → checkout, one test (Ensure TC is not flaky)

Nightly schedule on main dev branch on QA Environment                                    
   └─▶ All Regression Scenarios (UI+API including contract tests) Report should be published before Team checks in so that they can triage failed cases (if any). Create (Add Auto bug creation tool) bug for failures due to product bug, report any infra stability or fix flaky test script.
   └─▶ Performance run of critical APIs/Flows & comparison with previous run numbers to ensure KPIs are not degrading once new code is merged.
```

**Why this split:** API tests block every PR because they're fast (~seconds each, no browser) and
deterministic — every TC-ID in `checkout.spec.ts`/`cart.spec.ts`/`product-catalog.spec.ts` is scripted at a
flag value (0% or 100%, never a percentage in between) specifically so it's fast AND reliable enough to gate
a merge. E2E blocks too, but is kept to exactly one golden-path test so a flaky browser test never becomes a
merge-blocking liability — new E2E tests go to the nightly tier first and only get promoted to PR-blocking
once they've proven stable over ~2 weeks of nightly runs, the same bar the flake-quarantine policy below uses
in reverse.

## Execution model: parallel vs. sequential, and where it runs

- **The `api` project runs sequentially, on purpose** (`fullyParallel: false, workers: 1` in
  `playwright.config.ts`), because flagd's config is one global, mutable resource shared by the whole running
  app — not scoped per test, per file, or per worker. Running API tests in parallel surfaced real
  cross-test contamination live (a concurrent worker's `paymentFailure` toggle bled into an unrelated request
  from another worker's test — see `automation/README.md`). Serializing this project trades suite speed for
  correctness against that shared external state; ~20 seconds sequential is a trade I'd take over an
  intermittently-wrong test every time.
- **The `e2e-chromium` project can stay parallel-safe** (Playwright's default `fullyParallel: true` applies),
  because each test gets its own isolated `BrowserContext` (separate cookies/localStorage/session) and the
  one golden-path test doesn't touch flagd at all. If a future E2E test needs to toggle a flag, it inherits
  the same serialization problem as the API project and should move into a serialized project, not stay
  parallel by default.
- **Where it runs: an ephemeral CI-hosted runner, not a shared long-lived remote VM — deliberately.** Each
  PR's job boots its own fresh `docker compose up` stack (all 20 services) inside the CI runner and points
  `BASE_URL` at `localhost`, then tears it down after the job. I considered the alternative — a persistent
  remote VM/staging cluster that's always up, so CI just points `BASE_URL` at it and skips the ~2-4 minute
  compose boot — and rejected it as the default specifically because of the flagd finding above: a shared
  remote environment doesn't just risk one test stepping on another *within* a run, it risks one PR's job
  stepping on a completely different PR's concurrent job, on a shared mutable flagd instance, with no test
  framework serialization able to protect against that at all. An ephemeral per-run stack makes that class of
  bug structurally impossible instead of relying on discipline to avoid it.
  - The one place I'd reconsider this: a **nightly** run is a single scheduled job, not N concurrent PR jobs,
    so the cross-job contamination risk mostly disappears. If the ~2-4 minute boot cost ever becomes a real
    bottleneck for the nightly's larger scope (a future percentage sweep + full currency matrix), a
    persistent staging VM reused only by the nightly job (never by PR jobs) would be a reasonable trade-off to
    revisit then — not something I'd build ahead of an actual bottleneck.

## Reporting: what gets published, and to whom

Different audiences need different altitudes of the same run — a QA engineer triaging a red build needs the
trace and the exact assertion that failed; an EM or PM checking in on quality needs a trend, not a stack
trace. This suite's reporters are already split for that (`playwright.config.ts`: `list`, `html`, `json`), and
CI is where that raw output turns into something each audience actually looks at:

- **QA pod owner (deep triage):** the full Playwright HTML report — including `trace: 'retain-on-failure'`
  and `video: 'retain-on-failure'` — is uploaded as a CI artifact and linked directly from the failing check,
  so a failing test in CI is debuggable without reproducing locally first. For a distributed system with 20
  services, "can't reproduce locally" is the default state, not the exception, so this link (not a re-run
  request) is the first thing a triaging engineer should reach for. Artifacts are retained for a fixed window
  (e.g. 14 days) so a failure that isn't triaged same-day is still inspectable a few days later.
- **PR author / reviewers (fast signal):** a CI step parses `test-results/results.json` and posts a PR
  comment summarizing pass/fail **by test-case ID** (the `TC-XX-NN` prefixes in every test name exist
  specifically so this mapping is mechanical, not a human re-reading test titles) — enough for a reviewer to
  see "TC-CO-03 regressed" without opening the full HTML report, with a link into it for when they need to.
- **Broader stakeholders (EM, PM, other pods):** get a rolled-up digest, not raw reports — a scheduled job
  posts a short nightly/weekly summary to a wider Slack channel: overall pass rate and its trend, any newly
  broken TC-ID, and a count of open `quality-risk` annotations. This is deliberately not the same channel or
  the same content as the QA-triage artifact above — a stakeholder digest that's just as noisy as a triage
  report trains people to stop reading it.
- **`quality-risk` annotations get their own path, not buried in a green build.**
  `test.info().annotations.push({ type: 'quality-risk', ... })` (used in e.g. TC-CO-06, TC-CT-08, TC-PC-01's
  JPY rounding) surfaces things worth a human's attention that aren't necessarily bugs. A CI step extracts
  these from the JSON report and either files/updates a ticket-queue entry or posts to a dedicated QA-findings
  channel — this is the mechanical link back to `test-strategy.md` §5's escaped-defect and leakage metrics:
  a finding that sits only in a green CI run and never reaches a human is exactly the kind of thing that
  later shows up as "escaped to production" with nothing in the tracker explaining it was already known.

## How the reports actually help a QA engineer triage a failure

- **Start from the TC-ID, not the stack trace.** A failing test's name maps directly to a row in
  `test-cases/*.md`, so the first triage question — "what was this actually supposed to verify, and why does
  it matter" — is answered by the manual test case, not by re-deriving intent from assertion code.
- **A "CONFIRMED BUG" test going red can mean the bug got fixed — check which direction before paging anyone.**
  Tests like TC-CO-06 (empty-cart 500) and TC-CT-08's negative-quantity case are pinned to the CURRENT
  (bad) behavior on purpose, as a regression guard against the app quietly getting *worse* in a different way.
  If one of these flips from pass to fail, the first thing to check is whether the underlying bug was fixed
  (good news — update the test's expectation) rather than assuming every red test means new damage. This
  distinction needs to be obvious from the test name/comment, not something a triaging engineer has to
  rediscover — which is why every pinned-bug test in this suite says "CONFIRMED BUG" or "(bug)" directly in
  its title.
- **Trace + video collapse "can't reproduce locally" for API failures too, not just UI ones.** Even though
  `trace`/`video` are most associated with browser tests, the API project's traces still capture the exact
  request/response pair and timing for a failing assertion — for flagd-adjacent tests specifically, the trace
  shows whether the flag write, the propagation wait, and the actual request happened in the order and timing
  the test assumed, which is usually the real question when one of those tests flakes (see "Flakiness" below).
- **Route by pod ownership, not by whoever's online.** Per `test-strategy.md` §3, `checkout.spec.ts` failures
  route to the Checkout & Payments pod owner and `cart.spec.ts`/`product-catalog.spec.ts` failures to Cart &
  Catalog — the PR comment and the Slack triage post both tag the owning pod automatically from the file
  path, so triage doesn't default to "whoever noticed the red build first," which is how ownership erodes.

## Flakiness

- **Real fixture cleanup, not hope.** Every fault-injection test resets its flagd flag in `afterEach`, so a test that fails mid-run doesn't leave `paymentFailure` stuck at 100% and cascade-fail every test after it — this is the single most common cause of "flaky" suites in systems with global mutable state like flagd.
- **Unique test data per run**, not shared fixtures — `uniqueUserId()` timestamps every session ID so parallel test runs (Playwright's default `fullyParallel: true`) never collide on the same cart/session, which would otherwise produce nondeterministic cross-test interference that looks like flakiness but is actually a test-isolation bug.
- **Quarantine, not silent retry-until-green.** `retries: 1` in CI absorbs genuine network blips against a freshly-started docker-compose stack. A test that fails, passes on retry, and does this repeatedly across runs should be pulled from the blocking suite into a quarantine list (tagged, tracked, and reviewed weekly by whoever owns automation-platform that quarter) rather than left to erode trust in the whole suite —
  "the pipeline is always red so nobody looks at it" is the actual failure mode I'm optimizing against, not any single flaky test.
- **The probabilistic flagd percentages are the known flakiness risk I haven't automated** (see
  `automation/README.md` — TC-CT-04 is deliberately scripted at 100% only). If this team ever needs the
  10-90% sweep automated, it needs a statistically-sized sample and a tolerance band from day one, not a
  single assertion that happens to pass most of the time — that's exactly the kind of test that becomes
  "the flaky one everyone ignores."

## Test data

No shared, mutating fixtures. Every test generates its own `userId`/session via `uniqueUserId()` and its own
cart from scratch. This trades a little setup boilerplate per test for zero test-order dependency — any test
can run alone, in any order, in parallel, and be re-run without a database reset step. The tradeoff I'd
revisit if the team ever adds tests needing pre-existing historical data (e.g., "a returning customer with
order history") — that would need a seeded, versioned fixture dataset, not per-test generation.
