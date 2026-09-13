# Test Strategy: OpenTelemetry Astronomy Shop

Target: the [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo), 20 services in
8 languages, gRPC between services, a Next.js frontend with a REST BFF at `/api/*`, and a feature-flag
service (`flagd`) that can inject faults into most of the stack on demand.

## 1. Where the risk is

Risk is not spread evenly across 20 services. It sits at the seams, and it sits where money moves.

- **Checkout / Place order** — the only flow that charges a card, fanning one request out to cart,
  currency, shipping, payment, email, and a Kafka event. *Business impact if it fails:* a paid customer
  with no order, an order with no charge, or two charges for one order — each a chargeback, a refund, and
  a support ticket. 
- **Cart** — Valkey-backed state that checkout reads first, carrying price and quantity through from
  add-to-cart to purchase. *Business impact if it fails:* the customer is billed for something other than
  what the cart showed, or a quantity update silently goes negative and flows into checkout unclamped.
- **Catalog and currency** — every page converts and displays price independently. *Business impact if it
  fails:* the same customer sees two different prices for one item in two places, or a product 500s
  instead of 404ing and looks broken rather than sold out (TC-PC-02, confirmed).

What I deliberately do not test deeply: `ad`, `recommendation`, `image-provider` (best effort, the UI
tolerates empty results), the observability stack (infrastructure, not product), `chatbot`
(non-deterministic), `react-native-app`, and `load-generator` (a tool, not a target). Smoke checks only.

## 2. Test pyramid

```
E2E (browser)         ~10   golden path + 2 or 3 broken paths
Integration + contract   50-70 API + gRPC against docker compose, no mocks, flagd faults
Unit                      owned by service teams; QA tracks coverage trend, does not write them
```

**Unit.** Owned by each service's engineers. In eight languages, QA writing unit tests for code it does
not own is a bad trade. QA's job here is visibility: coverage trend per service, gated in CI.

**Integration and Contract Test Cases** Test Cases covering interaction of different services and E2E user flows, these can be of 2 types:

- Behaviour: place a real order and assert the cart is cleared; toggle `paymentFailure`,
  `productCatalogFailure`, `cartFailure` and assert the API fails the right way and does not silently
  succeed. Every flagd flag is a repeatable negative test instead of a support ticket.
- Contract: API Contract Validation: Validate API contracts agreed upon between two different services. REST APIs triggered from the Frontend must adhere to the API contract agreed between FE and BE. Schema validation of the actual API responses against the defined contract helps ensure that the communication between FE and BE remains consistent and compliant with the agreed specifications.


**E2E.** E2E Business Happy Flow including Frontend &  some negative cases that cant be covered in integration scenarios. Its job is to prove the browser, frontend and BFF
are wired together, not to re-verify logic already proven at the API layer.

**Performance.**

*Which flow.* Checkout/Place Order is the primary target — it's the flow ranked highest risk in §1, so a
latency or error regression there is a direct revenue and trust cost, not just a bad experience. Cart and
the product/currency read paths are the secondary target: they're hit on nearly every page view, so a
regression there compounds across an entire session rather than one transaction.

*Metrics — not just "is it fast."* Latency as percentiles (p50/p90/p95/p99) per endpoint, never a single
average — an average hides exactly the tail latency that drives complaints and cart abandonment. Error/
failure rate under load, separately from latency (a fast 500 is not a pass). Sustained throughput before
the system degrades, not just its behavior at one fixed concurrency. For checkout specifically, the true
end-to-end transaction time across its full downstream fan-out (cart, currency, shipping, payment, email),
not just the outermost response time — a slow single downstream call can hide inside an otherwise-acceptable
aggregate.

*API performance vs. end-to-end.* Test at the API layer first — hitting REST/gRPC endpoints directly, no
browser — because it isolates a backend regression from frontend rendering noise and is cheap enough to run
often. Add a smaller browser-driven pass to capture real user-perceived load time (time-to-interactive, not
just server response time), which an API-only test can't see. Run more than one load shape: steady-state
(expected normal traffic), peak/spike (a sale or marketing-driven burst), and a longer soak/endurance run
(memory and connection leaks typically only show up after hours, not minutes) — a single fixed-load run
answers none of these on its own.

*Tooling.* The specific tool matters less than covering the right flow with the right metrics — any
scriptable load generator (e.g. k6, Locust, JMeter, Gatling) can do this. Prefer whichever the team already
runs, or whichever integrates most easily with the existing observability/metrics-and-tracing backend,
over introducing a new one just for this. If a tracing/metrics pipeline is already in place (as it is here,
via OpenTelemetry), reuse it to compute these percentiles instead of building a bespoke report-parsing
script — most systems with any observability already have an answer to "what's this endpoint's p95"
sitting in it unused.

*Baseline.* Derive it empirically — the current p50/p95/error-rate under realistic (production or
production-like staging) traffic — never an arbitrary number picked in a meeting. Version it like any other
test fixture (commit it, review changes to it) so "did we regress" is a comparison against a recorded
number, not a guess, and re-baseline deliberately after an intentional architecture change rather than
letting it silently drift.

*Cadence.* Nightly, not per PR, against an environment that's had time to warm up — a freshly booted,
PR-scoped stack is never warmed up long enough for a load number to mean anything. A breach pages on-call
the same way a nightly E2E regression does (§4); it does not block a merge.

**Left unautomated, on purpose:** percentage-based flag variants (a single-run assertion on "roughly
half fail" is flaky by construction), full currency-pair combinatorics (sample USD, EUR, JPY), currency
correctness against an external rate (needs a versioned rate table as oracle), and anything whose subject
is browser storage or tabs (TC-CT-05, TC-CT-06) until the team decides a browser test is worth its upkeep.

## 3. QA ownership in a pod model

Organise by flow, not by service, because that is where the risk is: **Checkout and payments**, **Cart and
catalog**, **Everything else** (ads, recommendations, observability, chatbot). Each flow has one accountable
QA owner who maintains its integration suite, reviews automation PRs that touch it, and signs off releases
for it. Unit tests stay with the service's engineering owner. A fourth, rotating role owns the platform:
CI health, flakiness triage, test data, shared fixtures, the agentic tooling. It rotates quarterly so the
pipeline is not one person's knowledge.

Cross-flow changes (a proto field several flows read) need sign-off from every affected flow, enforced by
the contract gate in CI rather than by a checklist.

How a feature moves through QA:

1. Test design before code: the flow owner writes cases from the acceptance criteria, including the
   relevant flagd fault scenarios, and reviews them with the engineer and product owner.
2. Automation lands with the feature, in the same PR or a fast follow, reviewed by the flow owner.
3. PR gate: contract, integration and the golden-path E2E run and must pass.
4. Pre-release: the full E2E set and the fault matrix run against the release candidate.
5. A time-boxed exploratory pass on the feature and its neighbours (a cart change also gets a look at
   checkout).
6. Sign-off is a checklist per touched flow: suite green, exploratory done, no open Sev1/Sev2, known issues
   written down. No verbal go-aheads.
7. Anything that escapes to production gets a regression test before the incident is closed.

## 4. Quality gates in CI/CD

```
PR        → lint + unit (service teams)               must pass, < 5 min
          → contract (proto diff, OpenAPI validate)   must pass, < 2 min
          → integration/API (docker compose up)       must pass, < 10 min
          → E2E golden path                           must pass, < 5 min
          → merge
main      → nightly: full E2E + fault matrix + perf   pages on regression, does not block
release   → full regression + perf sign-off           manual QA sign-off before promote
```

Fast, deterministic gates block. Slow or noisy gates alert. Blocking every PR on a 30-minute suite with a
5% flake rate is how a team learns to ignore CI.

## 5. Metrics

**Headline: production leakage.** Defects found in production divided by all defects found, per flow, per
two-week window. Per flow because a leak in checkout and a leak in recommendations are not the same
problem, and a blended number hides the bad flow behind the good one. Every leaked Sev1/Sev2 in checkout
gets a root cause naming the gate that should have caught it and the test that now does.

Supporting metrics, each explaining why leakage moves:

- **Escaped defects by gate.** Of pre-production defects, which gate caught them. If E2E is catching
  everything and integration nothing, the pyramid is inverted in practice whatever the plan says.
- **Automation coverage by flow.** Share of documented manual cases with an automated counterpart, split
  into automated as written, adapted, pinned bug, and manual only. Line coverage across eight languages
  means nothing.
- **Regression stability.** Share of CI runs where a test fails then passes on retry with no code change.
  Above roughly 5% a suite loses its blocking status until fixed. That is a gate removed, so it is tracked
  as a leading indicator of leakage, not as a hygiene number.
- **Time to CI signal.** From push to gate result. When it creeps up, people merge before the result.

Not tracked as headline numbers: raw test count and pass rate. Both are trivially gameable and neither
says anything about risk covered.
