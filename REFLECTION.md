# Reflection

## Quality risks I'm seeing in this product, and why those


**1. Transactional integrity — money-moving operations with no idempotency or atomicity guarantee.**

Anywhere a request charges a customer or mutates shared state (cart, order, payment) without an
idempotency key or an atomic commit boundary, a retry, a double-click, or a downstream failure mid-flow
can duplicate or partially apply the side effect. Verified live in checkout specifically: `PlaceOrder`
(`src/checkout/main.go`) charges, then quotes shipping, then empties the cart and discards that error —
so with the cart service failing, the customer is charged and confirmed but their cart stays full
(TC-CO-05), and two genuinely concurrent submissions of the same cart both succeed with two different
order IDs (TC-CO-04). There is no idempotency key anywhere in `PlaceOrderRequest`.

**Impact if this leaks to production:** duplicate charges and chargebacks, which land on both the
customer-support queue and finance's reconciliation load at once — this is the one class of defect here
with a direct, hard-to-reverse financial cost, not just a bad experience.

**2. Error handling at service boundaries is absent, not just incomplete.** 
Wherever a frontend/BFF route
calls a downstream service without handling the failure case, a well-formed, intended error from the
backend gets silently flattened into a generic, unhandled 500 — the backend did the right thing and the
boundary threw it away. Seen at least three times: a missing product returns 500 instead of the 404
`product-catalog` actually signals; an empty-cart checkout returns 500 instead of a 4xx; `AddItem` accepts
values (zero, negative) a real client would never intentionally send and returns success anyway. None of
these is a backend bug — each is a route with no `try/catch` (or no validation) around a call.

**Impact if this leaks to production:** every masked error looks identical in logs and alerts, so an
on-call engineer can't tell a recoverable "this product doesn't exist" from a real outage without digging
— on-call noise goes up and mean-time-to-diagnose goes up together, and customers see a generic failure
page for things that should have been a clean, specific message.

**3. Behavioural contracts between services are undocumented — only the wire shape is.** 
Whether a
repeated `AddItem` accumulates or overwrites, what a negative quantity delta does, which currencies are
zero-decimal, what a `cartFailure` fault actually fails: none of this is in the proto, and I hit a version
of this ambiguity four separate times in one assignment. Message shapes are versioned and reviewed;
behaviour is not.

**Impact if this leaks to production:** any owning team can refactor internal behaviour a consumer
silently depends on — nothing fails a build when they do — so the first signal anyone gets is a customer
hitting the edge case in production, not a test in CI. In eight languages, "go read the other team's
source to find out" does not scale as the detection mechanism.

**4. Duplicated, independently-computed business logic across pages.** 
The same value — a converted
price, a shipping estimate — gets recomputed in more than one place (different pages, client vs. server)
instead of computed once and passed through. Seen twice: a sub-cent rounding difference between two
independent price lookups for the same product/currency, and a cart-page shipping estimate computed
against a hardcoded address instead of whatever the customer has actually entered.

**Impact if this leaks to production:** the customer sees two different numbers for the same thing in two
places before they've even paid — a trust hit before checkout even starts — and if the discrepancy is
large enough, a real gap between the price shown and the price charged, which in some jurisdictions is a
consumer-protection problem, not just a QA one.



## Four QA engineers across 20 services

Three engineers own a flow: Checkout and payments; Cart and catalog; Everything
else. One rotates quarterly as platform owner: CI, flakiness, fixtures, test data, the agentic tooling.
Flow ownership means accountability for an outcome across however many services it touches, and review
rights on automation that touches it, without owning unit tests inside any service. Cross-flow proto
changes need every affected flow's sign-off, enforced by the contract gate rather than by remembering to
ask. The rotation exists because at n=4 a single point of failure is still a single point of failure.

## Week 1 vs. month 3

**Week 1.** The fast deterministic gate: the API suite in `automation/` for the three flows, blocking on
PRs against a real `docker compose` stack. Not E2E, not a unit-coverage push. And a written list of the
undocumented behaviours above, with answers from engineering, before anyone builds tests on assumptions.

**Month 3.** The gate is trusted, so the investment moves to: the contract layer (`buf breaking` plus
OpenAPI validation) so proto breakage fails before integration runs; a flakiness quarantine driven by real
per-test data; and the agentic pipeline in `agentic/` run by the platform owner against new specs, pointed
at whichever flow hand-written generation has proven to be the bottleneck. Not "full coverage of 20
services." Several of them do not carry enough risk to justify it.
