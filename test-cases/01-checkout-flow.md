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

### TC-CO-01 — Happy path: place an order with a valid cart

**Preconditions:** App running, all flagd flags `off`. Session with a non-empty cart (≥1 item added via
`POST /api/cart`).

| Step | Action | Expected result |
|---|---|---|
| 1 | `GET /api/cart?sessionId={id}&currencyCode=USD` | Cart returned with the expected item(s) and enriched product data |
| 2 | `POST /api/checkout?currencyCode=USD` with `{ userId, email, address, creditCard }` matching the session's cart | `200 OK`. Response body is an `OrderResult`: non-empty `order_id`, `shipping_tracking_id`, `shipping_cost`, correct `shipping_address`, and `items[]` matching the cart contents with per-item cost |
| 3 | `GET /api/cart?sessionId={id}` | Cart is now **empty** — checkout must clear it server-side |
| 4 | Sum of `items[].cost` + `shipping_cost` | Equals the total the UI showed pre-checkout, in the same currency, within rounding tolerance |

**Edge cases to also cover:**
- Cart with quantity > 1 of the same product (line-item cost = unit price × quantity, not just unit price).
- Multiple distinct products in one order (all must appear in the response, none dropped or duplicated).

**Quality risk to flag before ship:** the response reconstructs the cost of each item independently on the
frontend (`checkout.ts` calls `ProductCatalogService.getProduct` per item to redisplay it) rather than
trusting the price the backend actually charged. If product-catalog pricing changes between "add to cart"
and "place order," the confirmation screen can show a different price than what was charged. This is a
**pricing-integrity risk**, not just a display bug, and I'd want engineering to confirm the charged amount
(from `payment`) is what's persisted as the order of record, not the redisplay value.

---

### TC-CO-02 — Payment declined (flagd `paymentFailure` = 100%)

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

**Quality risk to flag before ship:** there is no visible retry/idempotency key in `PlaceOrderRequest`. If a
customer double-clicks "place order" during a slow payment call, nothing in the contract prevents a double
charge. I would not ship a payment flow without confirming idempotency behavior with engineering, even
though I can't fully verify it black-box.

---

### TC-CO-03 — Downstream cart-service failure during checkout (flagd `cartFailure` = 100%)

**Preconditions:** `cartFailure = 100%`. Attempt checkout.

| Step | Action | Expected result |
|---|---|---|
| 1 | `POST /api/checkout` | Request fails cleanly (`5xx`) with no partial order created — checkout reads the cart as its first step, so this should fail before payment is ever attempted |
| 2 | Reset flag, `GET /api/cart` | Original cart state is intact (no data loss from the failed attempt) |

**Quality risk to flag before ship:** verify (via logs/traces, since this is what the OTel stack is for) that
a cart-read failure during checkout does **not** still proceed to charge the card. Order-of-operations bugs
in a 5-service fan-out are exactly the kind of thing that's invisible in a demo and catastrophic in
production.

---

### TC-CO-04 — Checkout with an empty cart

**Preconditions:** Session with no items in cart (fresh session or after `DELETE /api/cart`).

| Step | Action | Expected result |
|---|---|---|
| 1 | `POST /api/checkout` with a valid address/email/card but the empty-cart session | Documented/expected behavior is either a client-side block (UI shouldn't allow reaching checkout) or a clean `4xx` from the API — **not** a `200` with a $0 order and a shipping charge |

**This is a genuine ambiguity** — the proto/BFF code has no explicit empty-cart guard I could find. I'd flag
this as a **quality risk to escalate**, not assume-and-move-on: an empty order that still charges shipping,
or one that silently succeeds with no items, is the kind of bug that only shows up from a real user's odd
click path (e.g., two tabs open, one empties the cart while the other has an in-flight checkout).

---

### TC-CO-05 — Currency mismatch between cart currency and checkout currency

**Preconditions:** Add items to cart while browsing in EUR (`currencyCode=EUR`), then submit checkout with
`?currencyCode=USD`.

| Step | Action | Expected result |
|---|---|---|
| 1 | `POST /api/checkout?currencyCode=USD` after browsing/adding in EUR | Order total and `shipping_cost` are computed in USD, converted correctly from the underlying USD-denominated catalog price — not a stale EUR figure carried over from the cart view |
| 2 | Compare against `GET /api/currency` conversion for the same product/quantity | Amounts match within rounding tolerance |

**Edge case:** submit `currencyCode` that isn't in `GetSupportedCurrencies` (e.g., `XXX`). Expected: clean
`4xx`, not a silent fallback to USD (a silent fallback would mean a customer is charged in a currency they
didn't select, without being told).
