# Automation — Checkout, Cart & Product Catalog

Playwright (TypeScript) suite automating the highest-risk test cases from [`../test-cases/`](../test-cases/).

## Setup

```bash
# From the repo root, with the demo app already cloned as a sibling of this repo's
# opentelemetry-demo/ directory (see root README.md for the clone step):
cd opentelemetry-demo
docker compose up --wait

cd ../automation
npm install
npx playwright install --with-deps chromium
```

## Running

```bash
npm test              # everything (api + e2e)
npm run test:api      # API-level tests only — no browser needed, fastest signal
npm run test:e2e      # UI golden path only
npm run report        # open the last HTML report
```

Override the target with `BASE_URL=http://localhost:8080 npm test` if the frontend isn't on the default port.

The one gRPC test (`product-catalog.grpc.spec.ts`) is skipped by default because product-catalog's gRPC port
isn't fixed on the host (`compose.yaml` publishes it to a random port). Resolve it and run with:

```bash
export PRODUCT_CATALOG_GRPC_ADDR=$(docker compose -f ../opentelemetry-demo/compose.yaml port product-catalog 3550 | sed 's/0.0.0.0/localhost/')
RUN_GRPC_TESTS=1 npx playwright test product-catalog.grpc
```

## What's automated

All 19 tests below were run and pass against a real `docker compose up` stack (not just type-checked or
listed) — see "Live verification" below for what that surfaced.

| Test case | File | Automated? |
|---|---|---|
| TC-CO-01 (happy path + multi-item) | `tests/api/checkout.spec.ts` | Yes |
| TC-CO-02 (payment declined) | `tests/api/checkout.spec.ts` | Yes |
| TC-CO-03 (downstream cart failure) | *adapted* — see below | Adapted |
| TC-CO-04 (empty cart) | `tests/api/checkout.spec.ts` | Yes — pins a **confirmed bug** (see below) |
| TC-CO-05 (currency mismatch) | — | **No** — see below |
| TC-CT-01 (quantity accumulation) | `tests/api/cart.spec.ts` | Yes |
| TC-CT-02 (empty cart, idempotent delete) | `tests/api/cart.spec.ts` | Yes |
| TC-CT-03 (partial cartFailure %) | `tests/api/cart.spec.ts` | Yes, corrected against real behavior (see below) |
| TC-PC-01 (currency consistency, JPY) | `tests/api/product-catalog.spec.ts` | Yes |
| TC-PC-02 (targeted product failure) | `tests/api/product-catalog.spec.ts` | Yes (2 tests) |
| TC-PC-03 (search edge cases) | `tests/api/product-catalog.grpc.spec.ts` | Yes, via direct gRPC (see below) |
| Nonexistent product ID | `tests/api/product-catalog.spec.ts` | Yes — pins a **confirmed bug** (see below) |
| Golden path (browse → cart → checkout) | `tests/e2e/golden-path.spec.ts` | Yes (UI) |

**Automation coverage: 10 of 11 documented test cases automated (91%)** — the checkout flow's currency
mismatch case is the one deliberate gap.

## Live verification: two confirmed bugs, three corrected assumptions

Once Docker was available, every test in this suite was run against the real app, not just type-checked.
That surfaced real findings — some in the test suite's own assumptions, two in the application itself:

1. **CONFIRMED BUG — `GET /api/products/{id}` for a nonexistent ID returns an unhandled 500, not a 404.**
   `product-catalog`'s `GetProduct` (`main.go`) correctly signals gRPC `codes.NotFound`, but the frontend BFF
   route (`pages/api/products/[productId]/index.ts`) has no error handling around the call at all, so the
   rejection becomes a generic 500. Independently, the agentic pipeline's generated suite in `../agentic/`
   caught this same gap on its own when pointed at the live app instead of its mock — see
   `../agentic/AGENT-DESIGN.md`. `product-catalog.spec.ts` now pins the 500 as a regression guard.
2. **CONFIRMED BUG — checking out an empty cart 500s with a generic `{"error":"Failed to place order."}`**
   instead of a graceful 4xx. `checkout.spec.ts` TC-CO-04 was originally written as an open ambiguity
   ("what *should* happen?") and resolved by running it live; now pins the bug as a regression guard.
3. **Corrected assumption — `cartFailure` only affects `EmptyCart`, not `GetCart`/`AddItem`.**
   `src/cart/src/services/CartService.cs` only reads the flag inside `EmptyCart`, and even then routes to a
   hardcoded unreachable store (`"badhost:1234"` in `Program.cs`) rather than a documented error path.
   TC-CT-03 originally targeted `GetCart` and failed against the live app; split into one test documenting
   the (surprising) GET/AddItem no-op and one targeting the `DELETE` path that actually triggers the flag.
4. **Corrected assumption — flagd propagation isn't instant.** The flag-write endpoint returns before
   flagd/the target service has actually applied the new value; a test firing its next request immediately
   after a write could observe the stale value. Added an empirical 1s wait in `fixtures/flagd.ts`.
5. **Corrected assumption — flagd state is global, so parallel tests raced each other.** Playwright's
   default `fullyParallel` let one test's flag change leak into an unrelated concurrent request from another
   test. The `api` project now runs serially (`fullyParallel: false, workers: 1` in `playwright.config.ts`).
6. **Two E2E selector corrections**: `CypressFields.CheckoutItem` (`data-cy="checkout-item"`) turned out to
   be dead in this flow — set on `components/CheckoutItem/CheckoutItem.tsx`, but the real order-confirmation
   page (`pages/cart/checkout/[orderId]/index.tsx`) renders its own markup with no data-cy hooks at all.
   `golden-path.spec.ts` now asserts on real rendered content (the confirmation heading + the actual product
   name) instead. Also, `CheckoutForm`'s field labels are plain `<p>` tags with no real `label`-`for`
   association (a minor a11y gap, worth flagging to engineering) — moot for the golden path since the form
   ships pre-filled with valid sample data and doesn't need filling at all.

None of this was hypothetical — every item above is a real result from actually executing the suite, not a
prediction about what might go wrong.

## What's not automated, and why

- **TC-CO-05 (currency mismatch at checkout)** — asserting the converted total is *correct* requires
  independently recomputing the same conversion the `currency` service performs, which means either
  duplicating its logic in the test (brittle — a rate-source change breaks the test, not the product) or
  calling `currency.Convert` directly and asserting our answer matches its answer (which mostly just proves
  the service is consistent with itself, not that the conversion is *correct*). This is a case I'd want a
  domain-specific oracle (a fixed, versioned exchange-rate table) before automating precisely — until then
  it's a manual/exploratory case, documented so it isn't silently dropped.
- **TC-CO-03, adapted rather than literal** — the test case as written targets `cartFailure` during
  checkout, but `flagd`'s `cartFailure` flag is percentage-based (10/25/50/75/90/100%), not a deterministic
  on/off, and checkout's actual first downstream dependency in the code (`checkout.ts` → `ProductCatalogService`)
  is more directly and deterministically exercised via `productCatalogFailure`, which *is* deterministic and
  targets a single product ID. I substituted that as the automated proxy for "a downstream call inside
  checkout fails cleanly and isn't misclassified as a payment decline," and left the literal
  100%-`cartFailure`-during-checkout scenario as a manual case, because a genuinely flaky percentage-based
  flag makes for a flaky automated assertion, not a reliable regression gate.
- **TC-CT-03 is scripted at `cartFailure=100%` only**, not the full 10-90% sweep. Percentages below 100% are
  fundamentally probabilistic — a test asserting "roughly half the calls fail" either needs a large enough
  sample to be statistically meaningful (slow, still occasionally flaky) or a generous tolerance (weak).
  100% gives a deterministic, fast, reliable signal for the behavior that actually matters ("does a failure
  fail cleanly"); I'd only invest in the probabilistic sweep if a real incident showed partial-failure
  handling specifically (not just failure handling in general) was buggy.
- **TC-PC-03 (search)** required going outside the REST BFF entirely — see the code comment in
  `product-catalog.spec.ts`. The frontend never exposes `SearchProducts` over REST; only gRPC has it. This
  was a genuine discovery from reading `src/frontend/pages/api/products/*`, not a known limitation stated
  in the assignment — I automated it at the gRPC layer instead of skipping it or writing a fake REST test
  that wouldn't actually exercise search.
- **TC-CO-04 (empty cart) is automated as a risk-flagging test, not a strict pass/fail** — the spec doesn't
  document expected behavior here (see the test case file), so the test records whichever behavior exists
  as a `quality-risk` annotation for a human to review, rather than asserting a guess as ground truth and
  either false-failing on correct-but-unexpected behavior or false-passing on a real bug.
- **Full currency-pair combinatorics** (all ~30 supported currencies) — sampled (USD, EUR, JPY) per
  `test-strategy.md` §2's explicit "left unattended" call; a full sweep is mechanical to add later if a
  currency-specific bug ever surfaces.

## Notes on the UI test

`tests/e2e/golden-path.spec.ts` selectors are taken directly from the frontend's own source — the app's
`data-cy` test hooks (`src/frontend/utils/enums/CypressFields.ts`) — and the flow (add-to-cart
auto-navigates to `/cart`; placing an order navigates to `/checkout`) is confirmed by reading the app's own
`Checkout.cy.ts`. Passes against the live app; see "Live verification" above for the two selector
corrections this needed after actually running it (a dead `data-cy` hook and non-label-associated form
fields).
