# Reflection

## Which risks I would escalate to engineering leadership, and why those

**1. Checkout charges the card before it finishes the order, and cannot be retried safely.** In
`src/checkout/main.go`, `PlaceOrder` charges, then quotes shipping, then empties the cart and discards
that error. Two consequences, both verified against the live stack: with the cart service failing, the
customer is charged and confirmed but their cart stays full (TC-CO-05), and two concurrent submissions
of the same cart both succeed with two order IDs (TC-CO-04). There is no idempotency key in
`PlaceOrderRequest`. I escalate this above every flagd scenario because it is direct financial exposure,
it is architectural (checkout, payment and frontend retry logic all move together), and it is cheap to
raise now and expensive to discover through chargebacks.

**2. Error handling in the BFF is absent where it matters.** A missing product returns 500 instead of the
404 the backend signals; an empty-cart checkout returns 500 instead of a 4xx; an `AddItem` without a
quantity returns 500. None of these is a backend bug. Each is a Next.js route with no `try/catch` around
a gRPC call. I raise it to leadership rather than filing three tickets because it is a pattern, and
patterns need an owner and a convention, not three fixes.

**3. Behavioural contracts between services are undocumented.** Whether a repeated `AddItem` accumulates,
what a negative delta does, which currencies are zero-decimal, what `cartFailure` actually fails: none of
it is in the proto. I hit this four times in one assignment. In eight languages "read the other service"
does not scale. This is a process escalation: message shapes are versioned, behaviour is not.

I would not escalate the flagd fault scenarios themselves. They are known, named and instrumented by the
team that built them.

## Four QA engineers across 20 services

Not five services each. Three engineers own a flow: Checkout and payments; Cart and catalog; Everything
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
