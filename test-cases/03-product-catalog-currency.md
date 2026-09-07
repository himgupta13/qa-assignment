# Test Cases — Product Catalog & Currency Conversion

**Risk rationale:** every page (home, product detail, cart, checkout confirmation) independently re-fetches
product data and re-converts currency. A rounding or stale-price bug here doesn't fail loudly — it shows a
different number in two places at once. `productCatalogFailure` is targeted at a *specific* product ID
(`OLJCESPC7Z`), which signals the maintainers know per-product failure handling is a gap. See
`test-strategy.md` §1.

**System under test:** frontend REST BFF `GET /api/products`, `GET /api/products/{id}`,
`GET /api/currency` → `product-catalog` + `currency` (gRPC).

---

### TC-PC-01 — Price consistency across currencies for the same product

**Preconditions:** App running, all flags off.

| Step | Action | Expected result |
|---|---|---|
| 1 | `GET /api/products/{id}?currencyCode=USD` | Returns `price_usd` equivalent — record `units`/`nanos` |
| 2 | `GET /api/products/{id}?currencyCode=EUR` | Returns a converted price |
| 3 | `GET /api/products/{id}?currencyCode=JPY` (a currency with **no minor unit** — `nanos` should be 0/insignificant) | Price is a whole-yen amount; verify the conversion logic doesn't produce a fractional JPY value that then gets silently truncated or rounded inconsistently vs. how EUR/USD round |
| 4 | Cross-check step 2's EUR value against `POST` to `currency`'s convert logic independently (e.g., compute USD→EUR manually using the same rate source if exposed, or at minimum verify EUR ≈ USD × plausible rate) | Values are consistent — no drift between what `product-catalog` returns pre-converted vs. what a separate `currency.Convert` call would produce for the same input |

**Quality risk to flag before ship:** JPY (zero-decimal currency) is the classic case where naive
cents-based rounding logic breaks. I would explicitly ask engineering which currencies are zero-decimal in
their conversion table and add those as permanent regression cases, not just JPY as a one-off — this is a
class of bug, not an instance.

---

### TC-PC-02 — Fault injection targeted at a specific product (`productCatalogFailure`)

**Preconditions:** Enable `productCatalogFailure` (targets product `OLJCESPC7Z` per
`src/flagd/demo.flagd.json`'s targeting rule).

| Step | Action | Expected result |
|---|---|---|
| 1 | `GET /api/products/OLJCESPC7Z` | Fails cleanly (`5xx`) — this is the one product the flag targets |
| 2 | `GET /api/products/{any other id}` | **Succeeds normally** — the failure must not bleed into unrelated products |
| 3 | `GET /api/products` (list all) | Verify whether the failing product is omitted from the list or the whole list call fails — either is defensible, but it must be **consistent** and match what the product detail page does when a user navigates directly to `OLJCESPC7Z`'s page from a list that still showed it |

**Quality risk to flag before ship:** step 3 is the important one. If the list endpoint silently drops the
failing product but a cached/bookmarked link to its detail page 500s, that's a broken-link experience that
only appears under this specific fault condition — easy to miss if you only test the list or only test the
detail page, not both together.

---

### TC-PC-03 — Search with no results, empty query, and special characters

**Preconditions:** App running, flags off.

| Step | Action | Expected result |
|---|---|---|
| 1 | Search for a term with zero matches (e.g., `"zzz-nonexistent-zzz"`) | Empty result set, `200`, not an error |
| 2 | Search with an empty string | Either "all products" or a clean empty result — **not** a `5xx` (empty-string handling in search is a classic unguarded-input bug) |
| 3 | Search with SQL/NoSQL-injection-shaped input (e.g., `"' OR 1=1 --"`) and a very long string (~10k chars) | Treated as a literal search term with no results and no error — confirms the search path isn't naively concatenating input, and doesn't choke on length |

**Edge case:** unicode/emoji in the search query — the catalog descriptions include product names that may
not be ASCII-only depending on locale data; verify search doesn't throw on non-ASCII input.
