# Test Cases — Checkout / Place Order Flow

**Risk rationale:** highest-risk flow in the system. Moves money, fans out to 5 downstream services in one
request (cart, currency, shipping, payment, email), and is the terminal step of every user journey — a bug
here either loses an order, double-charges a customer, or confirms an order that was never actually placed.
See `test-strategy.md` §1.

**System under test:** frontend REST BFF `POST /api/checkout?currencyCode={code}` → `checkout` (gRPC) →
`cart`, `currency`, `shipping`, `payment`, `email`, plus a Kafka event to `accounting`/`fraud-detection`.

**Environment:** `docker compose up`, frontend at `http://localhost:8080`. Feature-flag manipulation via
flagd UI at `http://localhost:8080/feature` or the flagd API, per `src/flagd/demo.flagd.json`.

---

### Mandatory checkout-page fields (reference for all cases below)

Per the actual frontend source (`CheckoutForm.tsx` and `pages/cart/checkout/[orderId]/index.tsx`), these are
the fields every happy-path test must explicitly verify — not just "checkout succeeded":

**On the checkout form, before submit:**
- Email address
- Shipping address: street address, city, state, country, zip code
- Credit card number (format-validated client-side against `\d{4}-\d{4}-\d{4}-\d{4}`)
- Credit card expiration month and year
- Credit card CVV (3 digits)

**On the order-confirmation page, after submit:**
- Confirmation heading/messaging ("Your order is complete!" + confirmation-email note)
- **Order ID** — non-empty, and must be unique per order (verified across repeat runs / multiple orders in the
  same session, not just non-empty on one run)
- Shipping address as entered (street, city/state/zip, country) — must echo what was submitted, not defaults
- **Per line item:** item name, quantity, item price (the page renders `unit price × quantity`, not just unit
  price — a multi-quantity order showing the unit price instead of the line total is a real bug class here)
- Shipping cost (as its own line, separate from item cost)
- Order total (= sum of all line-item totals + shipping cost)

---

### TC-CO-01 — Happy path: single-item order

**Preconditions:** App running, all flagd flags `off`. Fresh session, empty cart.

| Step | Action | Expected result |
|---|---|---|
| 1 | Add exactly **one** product, quantity 1, via `POST /api/cart` (or the UI "Add to Cart") | `GET /api/cart` shows one line item, quantity 1 |
| 2 | Open checkout, enter email, shipping address (street, city, state, country, zip), and a valid credit card (valid number format, valid future expiration month/year, valid 3-digit CVV) | Form accepts all fields, no client-side validation errors |
| 3 | Submit checkout — `POST /api/checkout?currencyCode=USD` | `200 OK`. Response is an `OrderResult` with non-empty `order_id`, `shipping_tracking_id`, `shipping_cost`, `shipping_address` matching what was entered, and `items[]` with exactly the one product |
| 4 | Verify confirmation page against the **mandatory field list above** | Order ID present and non-empty; shipping address matches entry; the one item shows correct name, quantity (1), and price = unit price; shipping cost shown; total = item price + shipping cost |
| 5 | `GET /api/cart?sessionId={id}` | Cart is now **empty** |
| 6 | Sum of `items[].cost` + `shipping_cost` from the API response | Equals the total shown on the confirmation page, same currency, within rounding tolerance |

**Quality risk to flag before ship:** the order the frontend receives has no line-total and no order-total
field. The confirmation page (`pages/cart/checkout/[orderId]/index.tsx`) computes `cost × quantity` and the
sum itself, client-side, from the per-unit `cost` in the checkout response. The displayed number therefore
does match what checkout charged (the `cost` comes from the order, not a re-fetch), but there is no
server-side total to reconcile against, and `payment` is never asked what it actually charged. Step 6
above is the only check that ties the two together, and it is a client-side sum. Engineering should
persist the charged total on the order record so it can be audited without recomputing it.

---

### TC-CO-02 — Happy path: multiple items, multiple quantities, one order

**Preconditions:** App running, all flagd flags `off`. Fresh session, empty cart.

| Step | Action | Expected result |
|---|---|---|
| 1 | Add **at least 3 distinct products** to the cart, with **differing quantities** (e.g., product A ×1, product B ×3, product C ×2) via repeated `POST /api/cart` calls | `GET /api/cart` shows all 3 line items with the correct quantity for each |
| 2 | Open checkout, enter a valid email, shipping address, and valid credit card details (as in TC-CO-01) | Form accepts all fields |
| 3 | Submit checkout — `POST /api/checkout?currencyCode=USD` | `200 OK`. `items[]` in the response contains **all 3 products**, none dropped, none duplicated, none merged into one line |
| 4 | Verify confirmation page against the **mandatory field list above**, per line item | Each item shows its own name, its own quantity, and a price equal to **unit price × that item's quantity** (not the unit price alone — this is the specific bug class multi-quantity orders expose) |
| 5 | Verify **order ID** on this order vs. any prior order in the same test run/session | Order IDs are distinct — confirms IDs aren't session-scoped constants or reused across orders |
| 6 | Verify shipping cost and total | Shipping cost is a single charge for the order (not per-item); total = sum of all 3 line-item totals + shipping cost |
| 7 | `GET /api/cart?sessionId={id}` | Cart is now **empty** |

**Edge case within this test:** include one product at quantity 1 alongside the higher-quantity items, to
confirm the per-line-item price math (`unit price × quantity`) isn't only correct when quantity happens to be
the same for every item.

---

### TC-CO-03 — Payment declined (flagd `paymentFailure` = 100%)

**Preconditions:** Set `paymentFailure` flag to `100%` via flagd. Valid cart and valid checkout payload.

| Step | Action | Expected result |
|---|---|---|
| 1 | `POST /api/checkout` with a valid payload | `422` with `{ error: "Your payment could not be processed...", code: "PAYMENT_FAILED" }` per `checkout.ts`'s `PAYMENT_FAILURE_PREFIX` handling |
| 2 | `GET /api/cart?sessionId={id}` | Cart is **still populated** — a declined payment must not clear the cart (customer should be able to retry) |
| 3 | Reset flag to `off`, repeat step 1 | Order succeeds |

**Edge case:** `paymentUnreachable = on` (service down, not a decline) should surface as a `500` generic
failure, not the `422` payment-decline message — the code path explicitly distinguishes `Unavailable`/
`Internal` gRPC codes from an actual decline (`checkout.ts` lines checking `code = Unavailable`). This is
worth a dedicated test because conflating "your card was declined" with "our payment service is down" is a
customer-trust problem, not just a status-code nitpick.

---

### TC-CO-04 — Idempotency: duplicate checkout submission must not double-charge


**Preconditions:** All flagd flags `off`. Valid, non-empty cart. Valid checkout payload.

| Step | Action | Expected result |
|---|---|---|
| 1 | Fire two `POST /api/checkout` requests **back-to-back with the same session/cart state** (simulating a double-click) — e.g., issue them concurrently or within the same request window, both carrying identical payload | Only **one** order is actually placed and charged: either the second request is rejected/deduplicated (e.g., `409 Conflict` or an idempotent replay of the first response), or the cart is already empty by the time the second request lands and it fails cleanly (`4xx`, "cart is empty") rather than creating a second order |
| 2 | Inspect the `payment` service (via logs/traces — this is exactly what the OTel stack is for) for the number of charge attempts/transactions recorded for this session | Exactly **one** successful charge, not two |
| 3 | Inspect `order_id` values returned by each of the two requests (if both returned `200`) | If both succeeded, this is itself a **confirmed bug** — two order IDs for one customer action means a duplicate charge; the test should fail loudly here, not silently accept "well, it returned 200 twice" |
| 4 | Repeat with the second request delayed to simulate a slow-network retry (e.g., resend the identical checkout request 2-3 seconds after the first, before confirming the first succeeded) | Same expectation as step 1 — one order, one charge, regardless of the timing of the duplicate |
| 5 | Repeat with a **client-side retry after a `paymentUnreachable`-induced timeout** (toggle `paymentUnreachable` briefly, let the first request fail/timeout, retry once flag is `off`) | Confirms the retry-after-failure path (the realistic "checkout errored, customer clicked place order again" case) also results in exactly one successful order, not a race where the first attempt actually succeeded downstream despite the client seeing a timeout |

**If this test cannot be run black-box** (e.g., the API has no way to submit truly concurrent identical
requests, or `payment`/order records aren't inspectable without backend access), that is itself a finding to
report, not a reason to skip it — it means idempotency is unverified and unverifiable from the outside, which
is a gap engineering needs to close (an idempotency key on `PlaceOrderRequest`, or a dedupe check keyed on
cart/session), given the direct chargeback and revenue-leakage impact called out in `test-strategy.md` §1.

---

### TC-CO-05 — Cart-service failure during checkout (flagd `cartFailure` = 100%)

**What the code actually does (read before running):** `PlaceOrder` in `src/checkout/main.go` reads the
cart, charges the card, requests shipping, and only then calls `EmptyCart`. The `EmptyCart` error is
discarded (`_ = cs.emptyUserCart(...)`). `cartFailure` only affects `EmptyCart` (`CartService.cs`), not
reads. So the flag does not stop checkout; it makes the last step fail silently after money has moved.
An earlier version of this test case assumed the opposite order and expected a clean 5xx. That was wrong.

**Preconditions:** `cartFailure = 100%`. Cart with one item. Valid checkout payload.

| Step | Action | Expected result | Actual (verified live, 13 Sep) |
|---|---|---|---|
| 1 | `POST /api/checkout` | Either the order is placed **and** the cart is cleared, or the order is refused before the charge. Never "charged, order confirmed, cart still full." | `200`, `orderId` returned, card charged |
| 2 | `GET /api/cart?sessionId={id}` | Empty | **Still contains the purchased item** |
| 3 | Reset flag, place order again from the same (stale) cart | Should not be possible: the item was already bought | Second order, second charge |

**Confirmed bug.** The customer sees a confirmation page and a full cart. The natural next click is
"Place order" again, which charges them twice for the same items. Nothing is reported to the caller, so
this is invisible to the frontend and to support until a customer complains. Automated in
`automation/tests/api/checkout.spec.ts` as TC-CO-05, pinned to the current behaviour.

**Edge case (manual, no fault flag exists for it):** shipping is requested *after* the charge. A shipping
failure returns `Unavailable` to the customer with the card already charged, and no order record. Same
class of problem, different service. Worth a fault hook in `shipping` so it can be tested the same way.

**Edge case (automated as TC-CO-05b):** an unrelated downstream failure during order-item enrichment
(`productCatalogFailure` on a product in the cart) must surface as a generic 500, not as `PAYMENT_FAILED`.
Telling a customer their card was declined when the catalog was down is a trust problem.

**Quality risk to flag before ship:** the charge is not the last step, and the steps after it can fail
without unwinding it. Either move `chargeCard` after the steps that can fail, or make the post-charge
failures compensating (refund or explicit "paid, cart not cleared" state), and surface `EmptyCart`
failures instead of discarding them.

---

### TC-CO-06 — Checkout with an empty cart

**Preconditions:** Session with no items in cart (fresh session or after `DELETE /api/cart`).

| Step | Action | Expected result |
|---|---|---|
| 1 | `POST /api/checkout` with a valid address/email/card but the empty-cart session | Documented/expected behavior is either a client-side block (UI shouldn't allow reaching checkout) or a clean `4xx` from the API — **not** a `200` with a $0 order and a shipping charge |

**This is a genuine ambiguity** — the proto/BFF code has no explicit empty-cart guard I could find. I'd flag
this as a **quality risk to escalate**, not assume-and-move-on: an empty order that still charges shipping,
or one that silently succeeds with no items, is the kind of bug that only shows up from a real user's odd
click path (e.g., two tabs open, one empties the cart while the other has an in-flight checkout).

---

### TC-CO-07 — Currency mismatch between cart currency and checkout currency

**Preconditions:** Add items to cart while browsing in EUR (`currencyCode=EUR`), then submit checkout with
`?currencyCode=USD`.

| Step | Action | Expected result |
|---|---|---|
| 1 | `POST /api/checkout?currencyCode=USD` after browsing/adding in EUR | Order total and `shipping_cost` are computed in USD, converted correctly from the underlying USD-denominated catalog price — not a stale EUR figure carried over from the cart view |
| 2 | Compare against `GET /api/currency` conversion for the same product/quantity | Amounts match within rounding tolerance |

**Edge case:** submit `currencyCode` that isn't in `GetSupportedCurrencies` (e.g., `XXX`). Expected: clean
`4xx`, not a silent fallback to USD (a silent fallback would mean a customer is charged in a currency they
didn't select, without being told).
