# Test Cases — Cart Flow

**Risk rationale:** cart state lives outside the request (session-scoped, backed by Valkey/Redis in the full
stack) and is read by checkout as its first step. Bugs here are silent — they don't fail loudly, they just
produce a wrong order later. `flagd` ships `cartFailure` (partial-failure %) and `failedReadinessProbe`
targeted directly at this service. See `test-strategy.md` §1.

**System under test:** frontend REST BFF `GET/POST/DELETE /api/cart` → `cart` (gRPC) → `product-catalog`
(for price/name enrichment on read).

---

### TC-CT-01 — Add item, then add the same item again (quantity accumulation)

**Preconditions:** Fresh session, empty cart.

| Step | Action | Expected result |
|---|---|---|
| 1 | `POST /api/cart` `{ userId, item: { productId: X, quantity: 1 } }` | `200`, cart returned with 1 line item, quantity 1 |
| 2 | `POST /api/cart` again with the **same** `productId`, `quantity: 2` | `200`, cart has **one** line item for `productId` with quantity **3** (accumulated), not two separate line items |
| 3 | `GET /api/cart` | Matches step 2's result — read and write paths agree |

**Edge case:** add a `productId` that doesn't exist in the catalog. Expected: a clean error, not a cart
entry that later crashes checkout when `ProductCatalogService.getProduct` is called to enrich it (`cart.ts`
calls this unconditionally on every read — a bad `productId` in the cart is a landmine for every subsequent
`GET`, not just the write that introduced it).

**Quality risk to flag before ship:** quantity accumulation is my inference from typical cart semantics —
the proto (`AddItemRequest`) doesn't document whether repeated `AddItem` calls accumulate or overwrite. This
is exactly the kind of ambiguity I'd get a definitive answer on from the `cart` service owner before
declaring this test's expected result "correct," since either behavior is defensible and the wrong
assumption in a client integration would ship a real bug.

---

### TC-CT-02 — Empty cart, then read

**Preconditions:** Session with ≥1 item in cart.

| Step | Action | Expected result |
|---|---|---|
| 1 | `DELETE /api/cart` `{ userId }` | `204 No Content` |
| 2 | `GET /api/cart?sessionId={id}` | `200` with an empty `items` array (not an error, not a stale cached copy of the pre-delete cart) |

**Edge case:** call `DELETE /api/cart` on a session that never had a cart (never called `POST`). Expected:
idempotent success, not a `5xx` — a customer navigating to an empty cart page and the UI issuing a defensive
clear-cart call is a realistic path.

---

### TC-CT-03 — Cart read during partial cart-service failure (flagd `cartFailure` = 50%)

**Preconditions:** `cartFailure` set to `50%`. Cart has items from before the flag was enabled.

| Step | Action | Expected result |
|---|---|---|
| 1 | `GET /api/cart` repeated 10x | Roughly half the calls fail; failing calls return a clean `5xx`, not a `200` with corrupted/partial item data (the flag's own description is "fail cart service n% of the time" — the contract should be all-or-nothing per call, never a half-populated success) |
| 2 | On a failing call, verify the frontend doesn't clear/reset local cart UI state on a transient error | Cart badge/UI should not flash to "empty" on a retryable failure — that's a fast way to make a customer think their cart was cleared and re-add items, causing the duplicate-quantity risk from TC-CT-01 |

**Quality risk to flag before ship:** this is the one I'd escalate hardest from the cart flow — a transient
50% failure rate is realistic under load (not just a chaos-testing artifact), and if the frontend's error
handling on a failed cart read is "show empty cart" instead of "show cached/last-known cart with a retry,"
real customers under normal load spikes will see their cart randomly appear empty. That's a conversion and
trust problem, and it's caused by frontend error-handling choices, not the intentional fault injection.
