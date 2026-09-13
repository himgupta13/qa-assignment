# Test Cases — Cart Flow

**Risk rationale:** cart state lives outside the request, in Valkey, keyed by a `userId` the browser
generates and keeps in `localStorage`. A wrong quantity or price here is invisible until checkout, when
money moves. The frontend implements "change quantity" as a signed delta against the same `AddItem` call
used for adding, so the write path is more subtle than it looks. See `test-strategy.md` §1.

**System under test:** frontend REST BFF `GET/POST/DELETE /api/cart` → `cart` (gRPC, .NET) →
`product-catalog` (for per-item price enrichment on every read).

**Environment:** `docker compose up`, frontend at `http://localhost:8080`. Feature flags via
`http://localhost:8080/feature`. Note that `cartFailure` only affects `EmptyCart` (`CartService.cs`), not
`GetCart` or `AddItem`; this was found by running TC-CT-04 and is reflected below.

---

### Mandatory cart-page fields (reference for all cases below)

- **Item name** (with product image/link)
- **Quantity** — shown via an editable dropdown (values 1–10; there is no "0"/remove-item option in the
  dropdown itself — the only way to remove a single item is `Empty Cart`, which clears everything)
- **Unit price**
- **Line total** (= unit price × quantity — not just the unit price repeated)
- **Shipping** (a single row for the whole cart, not per item)
- **Cart total** (= sum of all line totals + shipping)

**Known quality risk, hardcoded shipping address:** the cart page's shipping row is a quote for a
hardcoded address (`1600 Amphitheatre Parkway, Mountain View`, in `components/CartItems/CartItems.tsx`),
not the address the customer will enter at checkout. The shipping figure and the cart total shown here
can therefore differ from what checkout charges. TC-CT-01 step 5 checks for this.


---

### TC-CT-01 — Happy path: verify all mandatory fields on a populated cart

**Preconditions:** Fresh session (or `DELETE /api/cart` first). No flagd faults active.

| Step | Action | Expected result |
|---|---|---|
| 1 | Add **2 distinct products** with different quantities (e.g., product A ×2, product B ×1) via `POST /api/cart` or the UI | `GET /api/cart` returns both line items with correct quantities |
| 2 | Load the cart page and verify **per line item**: name, quantity, unit price, line total | Name matches the product; quantity matches what was added and is shown via the editable dropdown; unit price matches the catalog price for the selected currency; line total = unit price × quantity for that item |
| 3 | Verify the **Shipping** row | A non-blank, non-zero shipping value is shown (unless the catalog genuinely has free shipping) |
| 4 | Verify the **Cart Total** row | Cart total = sum of all line totals + shipping, matching (within rounding tolerance) `GET /api/cart` amounts summed the same way |
| 5 | Change the checkout form's address on the same page to a different city/zip, then compare the shipping row against `POST /api/shipping` called with that new address | Expected finding, per the hardcoded-address risk above: the shipping row does **not** change, because it is quoted for the hardcoded address, not the form's. Record the discrepancy between the shown shipping and the quote for the real address |


---

### TC-CT-02 — Add item, then add the same item again (quantity accumulation)

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

---

### TC-CT-03 — Empty cart, then read

**Preconditions:** Session with ≥1 item in cart.

| Step | Action | Expected result |
|---|---|---|
| 1 | `DELETE /api/cart` `{ userId }` | `204 No Content` |
| 2 | `GET /api/cart?sessionId={id}` | `200` with an empty `items` array (not an error, not a stale cached copy of the pre-delete cart) |

**Edge case:** call `DELETE /api/cart` on a session that never had a cart (never called `POST`). Expected:
idempotent success, not a `5xx` — a customer navigating to an empty cart page and the UI issuing a defensive
clear-cart call is a realistic path.

---

### TC-CT-04 — Cart-service failure (flagd `cartFailure`)

**What the flag actually does (found by running the first version of this case):** the flag's description
says "fail cart service n% of the time," but `CartService.cs` only reads it inside `EmptyCart`, and on the
failing branch routes the call to a store configured with an unreachable host (`badhost:1234` in
`Program.cs`). `GetCart` and `AddItem` never consult the flag. So this case tests the delete path, at 100%
for determinism, and records the read/write no-op as a finding rather than asserting a failure that never
comes.

**Preconditions:** `cartFailure = 100%`. Cart with one item.

| Step | Action | Expected result |
|---|---|---|
| 1 | `GET /api/cart` and `POST /api/cart` | Both succeed (`200`). Documented so nobody writes a test expecting them to fail |
| 2 | `DELETE /api/cart` | Fails with a `5xx`, not a silent `204` with the cart still populated. Observed live: `500` after roughly two seconds, which is the connection attempt to the unreachable host timing out |
| 3 | Reset flag, `GET /api/cart` | Items are still there; the failed delete did not half-apply |

**Edge case (manual):** with the flag at 50%, repeat step 2 ten times. Each call must be all-or-nothing;
never a `204` with items left behind. Not automated because a percentage assertion needs a sample size
and a tolerance band, and a single-run version of it is a flaky test by construction.

**Quality risk to flag before ship:** two things. First, the flag is misnamed relative to what it does;
anyone reading `demo.flagd.json` will design tests, and incident drills, around a failure mode that does
not exist. Second, `EmptyCart` is called by checkout after the card is charged, and checkout discards its
error, so this flag's real customer-facing effect is the TC-CO-05 bug: paid, confirmed, cart still full.

---

### TC-CT-05 — Cart persistence across a simulated "session expiry" and relogin

**Why this needs care, not an assumption:** this app has no real authentication — there is no login, no
server-side session, and no expiry. "Session identity" is a `uuid.v4()` generated once and stored in
`localStorage`. So "session expires and user re-logs in" doesn't map onto a mechanism that exists in this
codebase today, and asserting "cart persists across relogin" without qualifying which browser behavior we're
actually reproducing risks testing something that isn't a real path. Split the scenario into what the app can
actually be asked to do:

**Preconditions:** Add ≥1 item to the cart in a normal browser session.

| Step | Action | Expected result |
|---|---|---|
| 1 | Close the tab/browser entirely (do **not** clear browsing data) and reopen the app in the same browser | `localStorage['session']` still holds the original `userId` → `GET /api/cart` for that `userId` returns the same items. **Cart persists.** This is the realistic equivalent of "user comes back later" in an app with no login, and it should pass. |
| 2 | Clear `localStorage` for the site (or open the app in a private/incognito window), then reopen the app | A **new** `userId` is generated (per `Session.gateway.ts`'s fallback-to-default-session behavior) → `GET /api/cart` for this new identity returns an **empty** cart. The original cart still exists server-side under the old `userId`, but nothing in the app lets the user get back to it. |
| 3 | Document the result of step 2 as a finding, not a pass/fail against an assumed requirement | If the business requirement behind this test case is "a returning, authenticated customer's cart should survive," that requires an actual account/login system tied to a durable identity (email, account ID), which does not exist in this app today. Flag this gap to the product/engineering owners rather than silently deciding it's a bug or silently deciding it's fine — get an explicit decision on whether cart-across-devices requires an auth feature that isn't built yet. |

---

### TC-CT-06 — Cart consistency across multiple tabs/browsers of the "same" user

**Why this needs two sub-scenarios:** whether the cart is "the same" across two open windows depends entirely
on whether they share the same `localStorage` (and therefore the same `userId`) — same browser profile vs. a
different browser/profile are not the same test.

**Scenario A — two tabs, same browser (same `localStorage`, same `userId`):**

| Step | Action | Expected result |
|---|---|---|
| 1 | Open the cart page in Tab 1 and Tab 2 (same browser, same profile) with an item already in the cart | Both tabs show the same cart contents on initial load (both read from the same `userId` server-side) |
| 2 | In Tab 1, add an item or change a quantity | `GET /api/cart` (server-side, e.g. via API call or Tab 1 itself after its own refetch) reflects the change immediately |
| 3 | Without reloading or navigating, check Tab 2 | **Expected finding, not an assumption of success:** Tab 2's cart view does **not** auto-update — the cart query only refetches on a local mutation or remount, with no cross-tab push/polling mechanism in this codebase. Tab 2 will show stale data until it is reloaded or the user navigates away and back. |
| 4 | Reload or navigate Tab 2 | Tab 2 now shows the updated cart, matching Tab 1 — confirming the data itself is consistent server-side, even though live cross-tab sync doesn't exist |

**Quality risk to flag from Scenario A:** if the product requirement is "an item update in one session should
reflect in all sessions" *live*, that is currently **not** the behavior — it only becomes consistent after a
manual refresh. This is a real gap to report, not something to assume works because the data is technically
correct once you reload.

**Scenario B — two different browsers/profiles (different `localStorage`, different `userId`):**

| Step | Action | Expected result |
|---|---|---|
| 1 | Add an item to the cart in Browser A | Cart is stored server-side under Browser A's `userId` |
| 2 | Open the app fresh in Browser B (different browser or a different profile — not just a new tab) | Browser B has its own independently generated `userId` in its own `localStorage` and shows an **empty** cart — it does not and cannot see Browser A's cart, since there is no shared login identity |
| 3 | Document this as expected given the current no-login architecture | Do not report this as a bug; report it (as in TC-CT-05) as a product-requirement question if "same cart across browsers" was ever an actual expectation — it would require an authenticated, cross-device identity that isn't implemented |

---

### TC-CT-07 — Changing currency on the cart page (or any page) updates cart-page figures correctly

**Preconditions:** Cart with ≥2 line items, default currency (e.g., USD).

| Step | Action | Expected result |
|---|---|---|
| 1 | Note the unit price, line total, shipping, and cart total for each item in the current currency | Baseline values recorded |
| 2 | Change the currency selector to a different supported currency (e.g., EUR), either from the cart page or from another page (e.g., product listing), then navigate to/stay on the cart page | The currency change triggers a **real server refetch** of the cart (`selectedCurrency` is part of the cart's react-query key) — this is not a client-side relabeling of the old numbers |
| 3 | Verify **every mandatory field** from the reference list re-renders in the new currency | Unit price, line total, shipping, and cart total are all shown in the new currency, and the total = sum of line totals + shipping still holds in the new currency |
| 4 | Cross-check the new-currency unit prices against `GET /api/currency` conversion for the same products | Matches within rounding tolerance — confirms the cart isn't doing its own independent (and potentially inconsistent) conversion math from what the currency service reports |
| 5 | Verify quantities themselves are unchanged by the currency switch | Only monetary values change; item counts/quantities must not reset or shift |
| 6 | Switch currency, then immediately update a quantity (compound scenario) | Resulting line total and cart total are correct for the **new** currency and the **new** quantity together — this is the case most likely to expose a stale-currency or stale-quantity calculation bug if the two state changes aren't both accounted for |

**Edge case:** select an unsupported/invalid currency code where possible (e.g., directly via API/URL param
rather than the UI selector, which should only offer supported currencies). Expected: clean rejection, not a
silent fallback to USD or a broken cart display.

---

### TC-CT-08 — Updating item quantity from the cart page recalculates correctly

**Why this needs a dedicated test:** quantity updates are **not** a "set quantity" call — the frontend computes
`delta = newQuantity - oldQuantity` and sends that (possibly negative) delta to the same add-to-cart endpoint
used for adding new items. That's a meaningfully different code path than a naive "PUT quantity=4" would be,
and it's worth verifying the delta math holds at the edges, not just for a simple increase.

**Preconditions:** Cart with one item at quantity 2.

| Step | Action | Expected result |
|---|---|---|
| 1 | Increase quantity via the cart-page dropdown from 2 to 5 | Line total updates to unit price × 5; cart total updates accordingly; `GET /api/cart` shows quantity 5 for this item (delta of +3 was applied correctly, not overwritten to some other value) |
| 2 | Decrease quantity via the dropdown from 5 back down to 1 | Line total updates to unit price × 1; cart total updates accordingly; `GET /api/cart` confirms quantity 1 (a **negative** delta of -4 was applied correctly — this is the case most likely to break if the backend's add-item path assumes quantities are only ever positive) |
| 3 | With 2 distinct items in the cart, change the quantity of only one of them | Only the changed item's line total moves; the other item's quantity and line total are unaffected; cart total reflects the sum correctly |
| 4 | Attempt to reduce quantity below the dropdown's minimum (1) or attempt a rapid double-change (e.g., 2→8 immediately followed by 8→3 before the first update's refetch completes) | No negative/zero quantity line item is ever created; the final displayed state matches the final selected quantity, not an intermediate one lost to a race between the two mutations |

