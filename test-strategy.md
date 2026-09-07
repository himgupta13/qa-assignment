# Test Strategy — OpenTelemetry Astronomy Shop

Target system: the [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo) ("Astro Shop"), a
polyglot, 20-service e-commerce demo (Go, Java, Python, Node.js, .NET, Ruby, Rust, PHP) that communicates
internally over gRPC, exposes a Next.js frontend with a REST BFF layer at `/api/*`, and ships with a real
feature-flag service (`flagd`) that can inject faults into 11+ services on demand.

## 1. Where the quality risk actually lives

Risk here isn't evenly spread across 20 services — it concentrates at the seams, not inside any one service.

| Flow | Why it's the highest risk | Services touched |
|---|---|---|
| **Checkout / Place Order** | It's the only flow that moves money and is the terminal step of every user journey. It fans out to 5 downstream calls (cart read, currency convert, shipping quote, payment charge, email confirm) in a single synchronous request from the frontend's point of view — one slow or wrong downstream call and the customer either loses their order or gets charged with no confirmation. `flagd` ships `paymentFailure`, `paymentUnreachable`, `cartFailure`, and `kafkaQueueProblems` specifically because the maintainers know this is where things break. | frontend → checkout → cart, currency, shipping, payment, email; checkout also emits a Kafka event for `accounting`/`fraud-detection` |
| **Cart** | State lives outside the request (session-scoped, backed by Valkey/Redis in the full stack). Any currency or quantity bug here is invisible until checkout, so it's a silent-failure risk, not a loud one. `cartFailure` and `failedReadinessProbe` flags target this service directly. | frontend → cart → product-catalog (for pricing enrichment) |
| **Product listing, search & currency conversion** | Every page — home, product detail, cart, checkout confirmation — re-fetches product data and re-converts currency independently. A currency-conversion rounding bug or a stale-price bug doesn't fail loudly; it just quietly shows the wrong number in one place and the right number in another. `productCatalogFailure` is targeted at a specific product ID (`OLJCESPC7Z`), which tells you the maintainers already know per-product failure handling is a gap. | frontend → product-catalog, currency |

Everything else (ads, recommendations, image loading, the chatbot, the load generator, observability stack) is either
decorative, best-effort, or explicitly designed to degrade gracefully — I would not put manual test depth there.
I'd cover them with lightweight smoke checks only.

**Deliberately out of scope for deep testing:** `image-provider`, `ad`, `recommendation` (best-effort, UI already
tolerates empty results), the OTel Collector / Jaeger / Grafana / Prometheus / OpenSearch observability stack
(these are infrastructure the demo uses to *show* telemetry, not product surface we own), `react-native-app`,
`chatbot` (LLM-backed, non-deterministic — see below), and `load-generator` (a test tool, not a service under test).

## 2. Test pyramid

```
        ▲  E2E (UI, Playwright)               ~10 tests   — golden-path + 2-3 broken-path journeys
       ╱ ╲ Contract (proto / OpenAPI)           ~15 tests  — frontend BFF ↔ backend gRPC shape checks
      ╱   ╲ Integration (API, against          ~40-60 tests — checkout/cart/catalog REST BFF, real backends,
     ╱     ╲  docker-compose, no mocks)                       flagd-driven fault injection
    ╱───────╲ Unit                              existing    — owned by service teams, not QA; QA's job is
   ╱─────────╲                                              coverage *visibility*, not authorship
```

- **Unit** — owned by the engineers on each of the 20 services. QA's role is to gate on coverage trend, not
  write these tests. Writing unit tests for code you don't own in a polyglot 20-service repo is a losing trade.
- **Integration/API** — the center of gravity. Run against `docker compose up` with real service-to-service
  calls (no mocks) hitting the frontend's REST BFF (`/api/products`, `/api/cart`, `/api/checkout`, etc.).
  This is where `flagd` flags earn their keep — every fault-injection flag becomes a negative-path test case
  instead of a support ticket. Fast enough to run on every PR, close enough to production to catch real bugs.
- **Contract** — the frontend BFF talks gRPC to backends via `pb/demo.proto`. Any service can change its
  proto and silently break the frontend at runtime since there's no compile-time link across languages. I'd
  add a contract check that diffs `PlaceOrderRequest`/`Money`/`Product` message shapes against a checked-in
  baseline and fails the build on breaking changes, before it ever gets to an E2E test.
- **E2E (UI)** — kept deliberately small: browse → add to cart → checkout happy path, plus 2-3 broken paths
  (payment declined, empty cart checkout, currency switch mid-session). E2E is slow and flaky by nature; I
  don't use it to re-verify logic already covered at the API layer, only to verify the layers are wired
  together correctly through the browser.
- **Performance** — out of the automated pyramid, run separately. `load-generator` (k6-based) already ships
  with the repo; I'd point it at the checkout flow with a threshold on p95 latency and error rate, run
  nightly, not per-PR. I would **not** try to build a custom perf framework — reuse what's there.
- **Explicitly left unautomated:** visual/pixel regression (low ROI on a demo app with frequent legitimate
  UI churn), the `chatbot` service (LLM output isn't deterministic — I'd smoke-test that it responds at all,
  not assert on its content), cross-browser matrix beyond Chromium (no evidence of browser-specific bugs in
  this stack; I'd add it reactively if one showed up), and exhaustive currency-pair combinatorics (I'd sample
  representative pairs — USD, EUR, JPY (no minor unit), and one unsupported code — rather than testing all
  ~30 supported currencies).

## 3. QA ownership in a pod model (20 services)

Twenty services is too many for a "QA owns everything" model and too few to need a dedicated QA-per-service
model. I'd organize by **flow, not by service**, because that's where the risk lives (see §1):

- **3 flow pods**, each with one QA engineer as the accountable owner: *Checkout & Payments*, *Cart &
  Catalog*, *Everything else* (ads/recs/observability/chatbot — shared, lower-touch).
- Each pod owner is accountable for the integration-level test suite for their flow and reviews any
  automation PR that touches it, but does **not** own unit tests inside individual services — that stays
  with the service's engineering owner (see `CODEOWNERS`-style mapping already implied by `src/<service>/`).
- A 4th QA engineer floats as **automation platform owner**: CI pipeline health, flakiness triage, test data,
  and the agentic tooling in `agentic/`. This role rotates quarterly so knowledge doesn't silo.
- Cross-pod contract changes (e.g., a proto change in `checkout`) require sign-off from every pod whose flow
  touches that message, enforced by the contract-test gate in CI, not by a manual review checklist.

## 4. Where quality gates live in CI/CD

```
PR opened ──▶ lint + unit (owned by service team)         [gate: must pass, <5 min]
          ──▶ contract tests (proto/schema diff)          [gate: must pass, <2 min]
          ──▶ integration/API suite (docker compose up)   [gate: must pass, <10 min]
          ──▶ E2E smoke (golden path only)                [gate: must pass, <5 min]
          ──▶ merge to main
main ──▶ nightly: full E2E + flagd fault-injection matrix + load-generator perf run
                                                            [gate: pages on-call if it regresses, doesn't block]
release tag ──▶ full regression + perf sign-off            [gate: manual QA sign-off before promote]
```

Fast, deterministic gates (contract, integration) block the PR. Slow or inherently noisy gates (full E2E
matrix, perf) run post-merge and alert rather than block — blocking every PR on a flaky, 30-minute suite is
how teams learn to ignore CI.

## 5. Metrics I'd actually track

- **Escaped defect rate** — bugs found in main/nightly or later, per flow pod, per two-week window. This is
  the single metric I'd escalate on if it trends up for the Checkout pod specifically, because that's the
  flow with financial and reputational blast radius.
- **Defect leakage ratio** — (escaped defects) / (escaped + caught-in-CI defects). Tracked per pod so it
  surfaces which flow's test suite is under-investing, not just an aggregate number that hides the problem.
- **Automation coverage by flow, not by line** — % of manually-identified test cases in `test-cases/` that
  have an automated counterpart in `automation/`. Line coverage is meaningless across 8 languages; flow
  coverage against documented risk is not.
- **Regression stability (flake rate)** — % of CI runs where a test fails then passes on retry with no code
  change, tracked per suite. If a suite's flake rate crosses ~5%, it loses its "blocking" status until fixed
  (see `automation-strategy.md` for the quarantine mechanism).
- **Mean time to CI signal** — from PR push to gate result. If this creeps up, the gate structure in §4 is
  wrong and needs rebalancing, not just "add more parallelism."

I would *not* track raw test count or pass-rate percentage as headline metrics — both are trivially gameable
(write more trivial tests; skip flaky ones) and neither tells you anything about risk actually covered.
