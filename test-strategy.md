# Test Strategy: OpenTelemetry Astronomy Shop

Target: the [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo), 20 services in
8 languages, gRPC between services, a Next.js frontend with a REST BFF at `/api/*`, and a feature-flag
service (`flagd`) that can inject faults into most of the stack on demand.

## 1. Where the risk is

Risk is not spread evenly across 20 services. It sits at the seams, and it sits where money moves.

| Flow | Why it is high risk | Services |
|---|---|---|
| **Checkout / Place order** | The only flow that charges a card. One synchronous request fans out to cart, currency, shipping, payment, email, and a Kafka event. The order of those calls matters: the card is charged *before* shipping is quoted and before the cart is emptied, and the cart-empty error is discarded (`src/checkout/main.go`). A failure after the charge leaves a paid customer with a full cart or no order. Confirmed live: `cartFailure` at 100% gives a 200, a charge, and a cart that is still populated (TC-CO-05). Two concurrent checkouts for the same cart both succeed with different order IDs (TC-CO-04). | frontend → checkout → cart, currency, shipping, payment, email, Kafka |
| **Cart** | State lives in Valkey, keyed by a browser-generated `userId`. Quantity changes are sent as signed deltas to the same `AddItem` call used for adding, and there is no lower bound: a delta past zero persists a negative quantity (TC-CT-08). Every read re-fetches price from the catalog, so a bad `productId` in the cart breaks every later read, not just the write. | frontend → cart → product-catalog |
| **Catalog and currency** | Every page converts prices independently. A rounding difference shows as two different numbers for the same item on two pages. A missing product returns a 500 from the BFF instead of the 404 the backend signals, because the route has no error handling (TC-PC-02, confirmed). JPY is zero-decimal and is the obvious rounding trap. | frontend → product-catalog, currency |

What I deliberately do not test deeply: `ad`, `recommendation`, `image-provider` (best effort, the UI
tolerates empty results), the observability stack (infrastructure, not product), `chatbot`
(non-deterministic), `react-native-app`, and `load-generator` (a tool, not a target). Smoke checks only.

## 2. Test pyramid

```
        E2E (browser)         ~10   golden path + 2 or 3 broken paths
     Integration + contract   50-70 API + gRPC against docker compose, no mocks, flagd faults
   Unit                       n/a   owned by service teams; QA tracks coverage trend, does not write them
```

**Unit.** Owned by each service's engineers. In eight languages, QA writing unit tests for code it does
not own is a bad trade. QA's job here is visibility: coverage trend per service, gated in CI.

**Integration and contract, the centre of gravity.** Run against `docker compose up` with real
service-to-service calls, through the BFF and, where the BFF has no route (search), directly over gRPC.
Two kinds of check share the suite:

- Contract: diff `pb/demo.proto` message shapes against a checked-in baseline (`buf breaking` does
  this), and validate BFF responses against the OpenAPI in `agentic/openapi/`. This is the only
  compile-time-equivalent link across eight languages. A required field added to `PlaceOrderRequest`
  fails here, not as a 500 in staging.
- Behaviour: place a real order and assert the cart is cleared; toggle `paymentFailure`,
  `productCatalogFailure`, `cartFailure` and assert the API fails the right way and does not silently
  succeed. Every flagd flag is a repeatable negative test instead of a support ticket.

Fast enough to run on every PR (target under 10 minutes including compose boot). The cost is a full stack
per run and a shared, mutable flagd, which forces the fault-injection tests to run serially.

**E2E.** One golden path plus two or three broken paths. Its job is to prove the browser, frontend and BFF
are wired together, not to re-verify logic already proven at the API layer.

**Performance.** `load-generator` ships with the repo. Point it at checkout with p95 and error-rate
thresholds, nightly, not per PR. No custom framework.

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
