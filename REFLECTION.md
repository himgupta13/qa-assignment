# Reflection

## Which quality risks here would I escalate to engineering leadership, and why those specifically?

**1. Checkout has no visible idempotency mechanism.** `PlaceOrderRequest` (see `pb/demo.proto`) carries no
idempotency key or client-generated request ID. A double-click, a client retry after a slow response, or a
network blip during payment could plausibly double-charge a customer. I'd escalate this specifically —
not the flakier flagd fault-injection scenarios — because it's the one risk in this system with direct
financial and legal exposure, it can't be fully verified black-box (I can observe the API contract has no
idempotency field, but I can't prove from outside whether the payment service itself deduplicates), and it's
architectural: fixing it after the fact touches checkout, payment, and probably the frontend's retry logic
all at once. This is exactly the kind of risk that's cheap to raise now and expensive to discover in
production.

**2. Silent reconciliation gap between "what was charged" and "what's displayed."** `checkout.ts` reconstructs
the order-confirmation view by calling `ProductCatalogService.getProduct` per line item *after* the charge
has already happened, rather than persisting the price actually charged. If catalog pricing changes between
add-to-cart and place-order, the confirmation screen can show a different number than what was billed. I'd
escalate this over, say, the cart's `cartFailure` fault-injection risk because it's not a failure mode at
all — it's the *correct-looking, everyday* code path producing a customer-facing pricing discrepancy, which
is a trust and dispute-rate problem, not a bug ticket.

**3. Undocumented behavior contracts across service boundaries in a polyglot system.** Whether repeated
`AddItem` accumulates or overwrites, what happens on an empty-cart checkout, which currencies get zero-decimal
treatment — none of this is stated in the proto. In a single-language monolith this kind of thing gets
discovered by reading the one implementation. Across 8 languages and 20 services, "read the code" doesn't
scale as a way to resolve ambiguity, and I'd escalate this as a process risk, not a code risk: without a
convention for documenting cross-service behavioral contracts (not just message shapes), every new service
added to this system reintroduces the same category of ambiguity I hit three separate times in this
assignment alone.

I would **not** escalate the flagd fault-injection scenarios (`paymentFailure`, `cartFailure`, etc.) to
leadership — those are already known, named, and instrumented by the team that built this demo. Escalating
already-tracked risks dilutes attention from the ones that aren't on anyone's radar yet.

## With 4 QA engineers, how do you structure ownership across 20 services?

Not one QA engineer per ~5 services — that's organizing around the org chart, not the risk. As laid out in
`test-strategy.md` §3: **3 engineers own a flow** (Checkout & Payments; Cart & Catalog; everything else —
ads/recommendations/observability/chatbot, which is real but lower-stakes surface), and **1 rotates as
automation-platform owner** (CI health, flakiness, test data, the agentic tooling). Flow ownership means a
QA engineer is accountable for outcomes across however many services that flow touches, and reviews
automation changes to it, without owning unit tests inside any individual service — that stays with the
service's engineering team. The platform-owner role rotates quarterly specifically so the CI pipeline and
shared fixtures don't become one person's tribal knowledge, which is its own risk in a 4-person team (a
single point of failure is still a point of failure at n=4). Cross-flow contract changes (a proto field that
several flows depend on) require sign-off from every pod that touches it, enforced by the contract-test gate
described in `test-strategy.md` §4 — I'd rather that be a CI gate than a "please remember to loop in the
other pod" norm, because norms don't survive someone being on vacation.

## What do you build in week 1 vs. month 3?

**Week 1:** Get the deterministic, fast signal in place first — the integration/API suite against the three
highest-risk flows (this repo's `automation/`), wired into CI as a blocking PR gate, running against a real
`docker compose up` stack with no mocks. I would *not* start with E2E or a broad unit-test coverage push:
E2E is slow to get stable and unit tests are owned by service teams, not QA, on day one. I'd also spend part
of week 1 just cataloguing the undocumented behavior gaps (like the three above) and getting explicit
answers from engineering — cheap to do early, expensive to discover mid-quarter when a "regression" turns
out to be a test asserting the wrong assumption.

**Month 3:** By now the fast gate should be trusted enough that people don't route around it, so the
investment shifts to (a) the contract-test layer catching cross-service proto breakage before it reaches
integration tests at all, (b) a working flakiness-quarantine process with real data behind it (which tests
actually flake, not which ones we assume might), and (c) the agentic tooling in `agentic/` graduated from
prototype to something the automation-platform owner actually runs against new specs as services evolve —
not because "use AI" is a month-3 goal in itself, but because by month 3 the team should know precisely
where hand-written test generation is the bottleneck (which flows, which kinds of tests) and can point the
agent at that specific gap instead of everything at once. I would explicitly *not* aim for "full automation
coverage of all 20 services" as a month-3 deliverable — per `test-strategy.md` §1, several of those services
don't carry enough risk to justify the investment, and chasing coverage-as-a-number is the metric mistake
called out in `test-strategy.md` §5.
