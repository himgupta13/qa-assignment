# Automation — Checkout, Cart & Product Catalog

Playwright (TypeScript) suite automating the highest-risk test cases from [`../test-cases/`](../test-cases/).

## Setup

```bash
# Start the app (see root README.md for the clone step), then:
cd automation
npm install
npx playwright install --with-deps chromium
```

The suite is self-contained. It does not read anything from the `opentelemetry-demo/` clone: the one
proto the gRPC test needs is vendored at `protos/demo.proto` (upstream commit `e297a3be`). An earlier
version resolved the proto from the clone at test-discovery time, which meant `npm test` without the clone
present collected **zero** tests and aborted. That is fixed; the gRPC client is now created lazily inside
the skipped-unless-configured describe.

## Running

```bash
npm test              # everything (api + e2e)
npm run test:api      # API-level tests only — no browser needed, fastest signal
npm run test:e2e      # UI golden path only
npm run report        # open the last HTML report
```

Override the target with `BASE_URL=http://localhost:8080 npm test` if the frontend isn't on the default port.

The four gRPC search tests (`product-catalog.grpc.spec.ts`) are skipped unless `PRODUCT_CATALOG_GRPC_ADDR`
is set, because product-catalog's gRPC port isn't fixed on the host (`compose.yaml` publishes it to a
random port). Resolve it and run with:

```bash
export PRODUCT_CATALOG_GRPC_ADDR=$(docker compose -f ../opentelemetry-demo/compose.yaml port product-catalog 3550 | sed 's/0.0.0.0/localhost/')
npm test
```

## What's automated



| Test case | File | Automated? |
|---|---|---|
| TC-CO-01 (single-item happy path, mandatory fields) | `tests/api/checkout.spec.ts` | Yes |
| TC-CO-02 (multi-item/multi-quantity happy path) | `tests/api/checkout.spec.ts` | Yes |
| TC-CO-03 (payment declined) | `tests/api/checkout.spec.ts` | Yes |
| TC-CO-04 (idempotency) | `tests/api/checkout.spec.ts` | Yes — pins a **newly confirmed bug** (see below) |
| TC-CO-05 (cart failure during checkout) | `tests/api/checkout.spec.ts` | Yes — pins a **confirmed bug** (see below); TC-CO-05b covers the "not misclassified as a decline" edge |
| TC-CO-06 (empty cart) | `tests/api/checkout.spec.ts` | Yes — pins a **confirmed bug** (see below) |
| TC-CO-07 (currency mismatch) | — | **No** — see below |
| TC-CT-01 (mandatory cart-page fields) | `tests/api/cart.spec.ts` | Yes, API-verifiable fields only (see below) |
| TC-CT-02 (quantity accumulation) | `tests/api/cart.spec.ts` | Yes |
| TC-CT-03 (empty cart, idempotent delete) | `tests/api/cart.spec.ts` | Yes |
| TC-CT-04 (partial cartFailure %) | `tests/api/cart.spec.ts` | Yes, corrected against real behavior (see below) |
| TC-CT-05 (session persistence across "relogin") | — | **No** — see below |
| TC-CT-06 (multi-tab/multi-browser consistency) | — | **No** — see below |
| TC-CT-07 (currency switch on cart) | `tests/api/cart.spec.ts` | Yes |
| TC-CT-08 (quantity update recalculation) | `tests/api/cart.spec.ts` | Yes — pins a **newly confirmed bug** (see below) |
| TC-PC-01 (currency consistency, JPY) | `tests/api/product-catalog.spec.ts` | Yes |
| TC-PC-02 (targeted product failure) | `tests/api/product-catalog.spec.ts` | Yes (2 tests) |
| TC-PC-03 (search edge cases) | `tests/api/product-catalog.grpc.spec.ts` | Yes, via direct gRPC (see below) |
| Nonexistent product ID | `tests/api/product-catalog.spec.ts` | Yes — pins a **confirmed bug** (see below) |
| Golden path (browse → cart → checkout) | `tests/e2e/golden-path.spec.ts` | Yes (UI) |

**Automation coverage: 15 of 18 documented test cases automated.** Broken down honestly:

| Category | Cases |
|---|---|
| Automated as written | TC-CO-01, 02, 03; TC-CT-01 (API fields), 02, 03, 07; TC-PC-01, 02, 03 (via gRPC) |
| Automated, pinned to a confirmed bug | TC-CO-04, TC-CO-05, TC-CO-06, TC-CT-08 (negative quantity), nonexistent product |
| Automated after correcting the test case | TC-CT-04 (`cartFailure` only affects `EmptyCart`) |
| Manual only | TC-CO-07 (needs a rate oracle), TC-CT-05, TC-CT-06 (browser storage / tabs) |

## Live verification: five confirmed bugs, corrected assumptions

Every test in this suite runs against the real app, not just type-checked. That surfaced real findings — some
in the test suite's own assumptions, five in the application itself:

0. **CONFIRMED BUG — a cart-service failure during checkout is swallowed: the card is charged, the order is
   confirmed, and the cart stays full.** `PlaceOrder` in `src/checkout/main.go` charges, ships, then calls
   `EmptyCart` and discards the error (`_ = cs.emptyUserCart(...)`). With `cartFailure=100%`, verified live:
   `200` with an `orderId`, and `GET /api/cart` afterwards still returns the purchased item. The obvious
   next click re-orders the same items. An earlier version of TC-CO-05 assumed checkout would fail *before*
   the charge; reading the source showed the opposite order, and running it confirmed the consequence.
   `checkout.spec.ts` TC-CO-05 pins the current behaviour. Together with #3 below this is the highest-severity
   pair in the suite: post-charge steps can fail without unwinding the charge, and duplicates are not
   prevented.

1. **CONFIRMED BUG — `GET /api/products/{id}` for a nonexistent ID returns an unhandled 500, not a 404.**
   `product-catalog`'s `GetProduct` (`main.go`) correctly signals gRPC `codes.NotFound`, but the frontend BFF
   route (`pages/api/products/[productId]/index.ts`) has no error handling around the call at all, so the
   rejection becomes a generic 500. Independently, the agentic pipeline's generated suite in `../agentic/`
   caught this same gap on its own when pointed at the live app instead of its mock — see
   `../agentic/AGENT-DESIGN.md`. `product-catalog.spec.ts` now pins the 500 as a regression guard.
2. **CONFIRMED BUG — checking out an empty cart 500s with a generic `{"error":"Failed to place order."}`**
   instead of a graceful 4xx. `checkout.spec.ts` TC-CO-06 pins the bug as a regression guard.
3. **CONFIRMED BUG (new) — checkout has no idempotency protection at all.** Firing two genuinely concurrent,
   identical `POST /api/checkout` requests for the same cart against the live stack returned **200 on both**,
   with **two different `orderId`s** — a double-click, or a client retry racing the original request,
   produces two separate orders (and, presumably, two separate charges). Verified this is specifically a
   *concurrency* bug, not a general retry-safety gap: a *sequential* second checkout (waited for the first to
   fully finish) correctly hit the empty-cart bug above instead, because the cart really was empty by then —
   only genuinely overlapping requests double-order. `checkout.spec.ts` TC-CO-04 pins the concurrent case as a
   regression guard. This is the single highest-severity finding in this suite given the direct
   chargeback/revenue-leakage impact called out in `test-strategy.md` §1.
4. **CONFIRMED BUG (new) — `POST /api/cart` (AddItem) has no lower-bound validation on quantity.** The
   frontend implements "update quantity" as a delta against this same endpoint (`delta = new - old`,
   confirmed by reading `Cart.provider.tsx`), so a large enough negative delta is a normal user action
   (repeatedly decreasing a quantity), not an attack. Driving the delta below zero live produced: at exactly
   zero, a cart line with `quantity: 0` that is **not removed** and still carries full product enrichment; one
   step further, a cart line with a **negative** quantity (e.g. `-5`), persisted and returned as-is by both the
   write and a subsequent read. `cart.spec.ts` TC-CT-08 pins both steps as a regression guard. Whether this
   negative quantity is clamped anywhere downstream (e.g. at checkout) is explicitly **not** verified here —
   flagged as an open question in the test's annotation, not assumed either way.
5. **Corrected assumption — `cartFailure` only affects `EmptyCart`, not `GetCart`/`AddItem`.**
   `src/cart/src/services/CartService.cs` only reads the flag inside `EmptyCart`, and even then routes to a
   hardcoded unreachable store (`"badhost:1234"` in `Program.cs`) rather than a documented error path.
   TC-CT-04 originally targeted `GetCart` and failed against the live app; split into one test documenting
   the (surprising) GET/AddItem no-op and one targeting the `DELETE` path that actually triggers the flag.
6. **Corrected assumption (new) — checkout's `items[].cost` is a per-unit price, not a line total.** TC-CO-02
   was originally written expecting `cost.units` to already be `unit price × quantity` (per the manual test
   case's framing of the bug class a multi-quantity order is meant to expose) and failed against the live app
   for a quantity-3 line. Tracing it: the checkout API returns the raw per-unit `Money`, and it's the
   frontend's own order-confirmation page (`pages/cart/checkout/[orderId]/index.tsx`) that multiplies
   `cost × quantity` client-side to render what a customer sees as the line total. The API contract itself
   has no "line total" field — TC-CO-02 now asserts what the API actually contracts to (correct quantity,
   correct *unit* cost per line), and documents the multiplication as a presentation-layer concern outside
   this test's layer.
7. **Minor finding (new) — a 1-nanos rounding discrepancy between two independent price lookups.** Comparing
   a product's unit price from `GET /api/products/{id}` against the same product's cost inside a checkout
   response occasionally differs by exactly 1 `nanos` (e.g. `949999999` vs. `950000000`) — a sub-cent
   floating-point artifact, not a whole-unit pricing bug. TC-CO-02 uses a 1-nanos tolerance rather than exact
   equality and flags any larger discrepancy as a quality risk, so this doesn't manufacture flakiness out of a
   rounding quirk that isn't what the test is actually checking.
8. **Pre-existing flakiness, now hardened (new) — TC-CO-05b's 500 body is occasionally plain text, not JSON.**
   Under `productCatalogFailure`, the checkout 500 is usually the BFF's own `{"error": "..."}` JSON, but
   running this repeatedly surfaced an intermittent plain-text `"Internal Server Error"` body instead — most
   likely a framework/proxy-level default error page bypassing the route's own error handling under this
   specific fault condition. The status-code assertion (not `PAYMENT_FAILED`) is unconditional; the
   body-shape assertions are now skipped (with a quality-risk annotation) when the body isn't JSON, so this
   doesn't turn into an intermittently-failing test on top of being a separate, real thing worth engineering's
   attention.
9. **Three E2E selector corrections**: `CypressFields.CheckoutItem` (`data-cy="checkout-item"`) turned out to
   be dead in this flow — set on `components/CheckoutItem/CheckoutItem.tsx`, but the real order-confirmation
   page (`pages/cart/checkout/[orderId]/index.tsx`) renders its own markup with no data-cy hooks at all.
   `golden-path.spec.ts` now asserts on real rendered content (the confirmation heading + the actual product
   name) instead. Also, `CheckoutForm`'s field labels are plain `<p>` tags with no real `label`-`for`
   association (a minor a11y gap, worth flagging to engineering) — moot for the golden path since the form
   ships pre-filled with valid sample data and doesn't need filling at all. Third, found by re-running the
   suite repeatedly during this revision: a bare `getByText(productName)` on the confirmation page
   intermittently hit a Playwright strict-mode violation (2 matches) because the page's own
   Ad/Recommendations section can independently reference the same product name (e.g. "Solar System Color
   Imager for sale. 30% off.") — depends on which product the golden path happens to pick and what gets
   recommended alongside it, so it didn't show up every run. Fixed by scoping the assertion to the
   confirmation item's actual markup (`S.ItemName` renders as a heading), which disambiguates it from the ad
   copy regardless of the product/recommendation combination.
10. **Corrected assumption — flagd propagation isn't instant.** The flag-write endpoint returns before
    flagd/the target service has actually applied the new value; a test firing its next request immediately
    after a write could observe the stale value. Added an empirical 1s wait in `fixtures/flagd.ts`.
11. **Corrected assumption — flagd state is global, so parallel tests raced each other.** Playwright's
    default `fullyParallel` let one test's flag change leak into an unrelated concurrent request from another
    test. The `api` project now runs serially (`fullyParallel: false, workers: 1` in `playwright.config.ts`).

None of this was hypothetical — every item above is a real result from actually executing the suite, not a
prediction about what might go wrong.

## What's not automated, and why

- **TC-CO-07 (currency mismatch at checkout)** — asserting the converted total is *correct* requires
  independently recomputing the same conversion the `currency` service performs, which means either
  duplicating its logic in the test (brittle — a rate-source change breaks the test, not the product) or
  calling `currency.Convert` directly and asserting our answer matches its answer (which mostly just proves
  the service is consistent with itself, not that the conversion is *correct*). This is a case I'd want a
  domain-specific oracle (a fixed, versioned exchange-rate table) before automating precisely — until then
  it's a manual/exploratory case, documented so it isn't silently dropped.
- **TC-CT-05 (cart persistence across a simulated "session expiry"/relogin) and TC-CT-06 (multi-tab/browser
  consistency)** — both are new manual cases whose entire subject is client-side browser state: whether
  `localStorage` survives a restart, and whether two open tabs/browsers share or diverge on cart data. The
  REST API this suite talks to has no concept of "a tab" or "a browser" at all — every request is just a
  `userId` string, so an API-level test proving "the same userId returns the same cart" would be trivially
  true and wouldn't actually exercise the browser-storage behavior the manual test case cares about. This
  needs a real browser test (opening two `BrowserContext`/pages, inspecting `localStorage`, reloading), which
  belongs in `tests/e2e/` — deliberately not added yet, consistent with this suite's E2E layer staying
  intentionally thin (see `../automation-strategy.md`) until a team decides it's worth the added
  flakiness/maintenance surface for a browser-storage-specific scenario, rather than folding it in silently
  alongside the one golden-path test.
- **TC-CO-05's shipping edge case** (shipping quoted *after* the charge, so a shipping failure leaves a
  charged customer with no order) is manual: no flagd flag targets `shipping`, and there is no other fault
  hook for it. Worth adding one upstream so it can be tested the same way as `cartFailure`.
- **TC-CT-04 is scripted at `cartFailure=100%` only**, not the full 10-90% sweep. Percentages below 100% are
  fundamentally probabilistic — a test asserting "roughly half the calls fail" either needs a large enough
  sample to be statistically meaningful (slow, still occasionally flaky) or a generous tolerance (weak).
  100% gives a deterministic, fast, reliable signal for the behavior that actually matters ("does a failure
  fail cleanly"); I'd only invest in the probabilistic sweep if a real incident showed partial-failure
  handling specifically (not just failure handling in general) was buggy.
- **TC-CT-01's shipping-cost and cart-total fields are not automated at the API layer.** Per
  `test-cases/02-cart-flow.md`'s "Mandatory cart-page fields" reference, shipping and cart total are computed
  entirely client-side (`components/CartItems/CartItems.tsx` calls a separate shipping-quote endpoint against
  a hardcoded address, then sums it with item totals) — `GET /api/cart` has no "shipping" or "total" field to
  assert on at all. TC-CT-01 automates everything the API actually contracts to (item name, quantity, unit
  price, per-item enrichment); verifying the two aggregate fields as rendered is a UI-level check, which would
  need the same real-browser investment as TC-CT-05/06 above.
- **TC-PC-03 (search)** required going outside the REST BFF entirely — see the code comment in
  `product-catalog.spec.ts`. The frontend never exposes `SearchProducts` over REST; only gRPC has it. This
  was a genuine discovery from reading `src/frontend/pages/api/products/*`, not a known limitation stated
  in the assignment — I automated it at the gRPC layer instead of skipping it or writing a fake REST test
  that wouldn't actually exercise search.
- **TC-CO-06 (empty cart) is automated as a risk-flagging test, not a strict pass/fail** — the spec doesn't
  document expected behavior here (see the test case file), so the test records whichever behavior exists
  as a `quality-risk` annotation for a human to review, rather than asserting a guess as ground truth and
  either false-failing on correct-but-unexpected behavior or false-passing on a real bug.
- **Full currency-pair combinatorics** (all ~30 supported currencies) — sampled (USD, EUR, JPY) per
  `test-strategy.md` §2's explicit "left unattended" call; a full sweep is mechanical to add later if a
  currency-specific bug ever surfaces.

## Notes on the UI test

`tests/e2e/golden-path.spec.ts` selectors are taken directly from the frontend's own source — the app's
`data-cy` test hooks (`src/frontend/utils/enums/CypressFields.ts`) — and the flow (add-to-cart auto-navigates
to `/cart`; placing an order navigates to `/checkout`) is confirmed by reading the app's own `Checkout.cy.ts`.
Passes against the live app; see "Live verification" above for the two selector corrections this needed after
actually running it (a dead `data-cy` hook and non-label-associated form fields).
