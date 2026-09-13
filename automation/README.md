# Automation — Checkout, Cart & Product Catalog

Playwright (TypeScript) suite automating the highest-risk test cases from [`../test-cases/`](../test-cases/).

## Setup

```bash
# Start the app (see root README.md for the clone step), then:
cd automation
npm install
npx playwright install --with-deps chromium
```

## Execution

```bash
npm test              # everything (api + e2e)
npm run test:api      # API-level tests only — no browser needed, fastest signal
npm run test:e2e      # UI golden path only
npm run report        # open the last HTML report
```

Override the target with `BASE_URL=http://localhost:8080 npm test` if the frontend isn't on the default port.

## Reports

Every run writes three things locally, per `playwright.config.ts`'s reporter config:
- `playwright-report/` — the HTML report (`npm run report` opens the most recent one; screenshots,
  traces, and video are attached here for anything that failed, per `trace: 'retain-on-failure'` /
  `video: 'retain-on-failure'`)
- `test-results/results.json` — the same run in machine-readable form, keyed by test name (the `TC-XX-NN`
  prefixes exist so this maps back to `test-cases/*.md` mechanically)
- `test-results/` — raw per-test artifacts (traces, screenshots) the HTML report links into

Locally, that's the whole story — open `playwright-report/index.html` and read it. In CI, this same output
is what gets published outward: the HTML report as a build artifact linked from the failing check, a PR
comment summarizing pass/fail by test-case ID parsed from `results.json`, and a rolled-up pass-rate digest
for non-QA stakeholders. See `../automation-strategy.md`'s "Reporting: what gets published, and to whom"
for the full breakdown of which artifact goes to which audience and why.

## What's automated

**Checkout**
- Single-item happy path, verifying every mandatory field (TC-CO-01)
- Multi-item, multi-quantity happy path (TC-CO-02)
- Payment declined (TC-CO-03)
- Idempotency under concurrent duplicate requests (TC-CO-04)
- Cart-service failure during checkout (TC-CO-05)
- Empty-cart checkout (TC-CO-06)

**Cart**
- Mandatory cart-page fields, the API-verifiable subset (TC-CT-01)
- Quantity accumulation on repeated add (TC-CT-02)
- Empty cart and idempotent delete (TC-CT-03)
- Partial cart-service failure (TC-CT-04)
- Currency switch on cart (TC-CT-07)
- Quantity update and recalculation (TC-CT-08)

**Product catalog**
- Currency consistency across conversions, including JPY (TC-PC-01)
- Targeted product-catalog failure (TC-PC-02)
- Nonexistent product ID

Not automated: TC-PC-03 (search edge cases). `SearchProducts` exists on the service but the frontend's REST
BFF never exposes a search/query route — the only way to exercise it is a direct gRPC client, which this
suite deliberately doesn't carry just for one test case. Manual/exploratory only.

**UI**
- Golden path: browse → add to cart → checkout


## Live verification: five confirmed bugs


1. **`GET /api/products/{id}` for a nonexistent ID returns an unhandled 500, not a 404.**
   `product-catalog`'s `GetProduct` (`main.go`) correctly signals gRPC `codes.NotFound`, but the frontend BFF
   route (`pages/api/products/[productId]/index.ts`) has no error handling around the call at all, so the
   rejection becomes a generic 500. Independently, the agentic pipeline's generated suite in `../agentic/`
   caught this same gap on its own when pointed at the live app instead of its mock — see
   `../agentic/AGENT-DESIGN.md`. `product-catalog.spec.ts` now pins the 500 as a regression guard.
2. **checking out an empty cart 500s with a generic `{"error":"Failed to place order."}`**
   instead of a graceful 4xx. `checkout.spec.ts` TC-CO-06 pins the bug as a regression guard.
3. **checkout has no idempotency protection at all.** Firing two genuinely concurrent,
   identical `POST /api/checkout` requests for the same cart against the live stack returned **200 on both**,
   with **two different `orderId`s** — a double-click, or a client retry racing the original request,
   produces two separate orders (and, presumably, two separate charges). Verified this is specifically a
   *concurrency* bug, not a general retry-safety gap: a *sequential* second checkout (waited for the first to
   fully finish) correctly hit the empty-cart bug above instead, because the cart really was empty by then —
   only genuinely overlapping requests double-order. `checkout.spec.ts` TC-CO-04 pins the concurrent case as a
   regression guard. This is the single highest-severity finding in this suite given the direct
   chargeback/revenue-leakage impact called out in `test-strategy.md` §1.
4. **`POST /api/cart` (AddItem) has no lower-bound validation on quantity.** The
   frontend implements "update quantity" as a delta against this same endpoint (`delta = new - old`,
   confirmed by reading `Cart.provider.tsx`), so a large enough negative delta is a normal user action
   (repeatedly decreasing a quantity), not an attack. Driving the delta below zero live produced: at exactly
   zero, a cart line with `quantity: 0` that is **not removed** and still carries full product enrichment; one
   step further, a cart line with a **negative** quantity (e.g. `-5`), persisted and returned as-is by both the
   write and a subsequent read. `cart.spec.ts` TC-CT-08 pins both steps as a regression guard. Whether this
   negative quantity is clamped anywhere downstream (e.g. at checkout) is explicitly **not** verified here —
   flagged as an open question in the test's annotation, not assumed either way.


5. **Minor finding - a 1-nanos rounding discrepancy between two independent price lookups.** Comparing
   a product's unit price from `GET /api/products/{id}` against the same product's cost inside a checkout
   response occasionally differs by exactly 1 `nanos` (e.g. `949999999` vs. `950000000`) — a sub-cent
   floating-point artifact, not a whole-unit pricing bug. TC-CO-02 uses a 1-nanos tolerance rather than exact
   equality and flags any larger discrepancy as a quality risk, so this doesn't manufacture flakiness out of a
   rounding quirk that isn't what the test is actually checking.

