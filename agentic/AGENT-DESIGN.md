# Agent Design — OpenAPI-Driven Test Generation

## Which option, and why

**Test generation.** I chose this over CI triage or self-healing because it's the one where "the agent does
real work with real autonomy" is falsifiable in a way I can actually build and check in a single session:
generate a test suite from a contract, then mechanically prove whether the suite is worth anything. CI
triage and self-healing both need a running system with a real failure history to be more than a toy; test
generation from a static spec doesn't, which made it the right fit for the time available here.

## The workflow

```
 ┌─────────────────────────┐
 │ agentic/openapi/         │  hand-written OpenAPI spec for the frontend BFF's
 │  frontend-api.yaml       │  checkout/cart/product-catalog surface (the app itself
 └───────────┬──────────────┘  ships no OpenAPI — only .proto — so this file is itself
             │                 a translation step a human did once, up front)
             ▼
 ┌─────────────────────────┐
 │ agentic/prompts/         │  reusable prompt: what to generate per operation, what
 │  generate-tests.md       │  NOT to invent, where output goes, and "don't stop until
 └───────────┬──────────────┘  the eval passes"
             │
             ▼  (agent reads spec + prompt + existing test-cases/ and fixtures/)
 ┌─────────────────────────┐
 │  AGENT                    │  Claude Code, this session, operating on this repo
 │  (Claude Code CLI)        │  directly — reads files, writes files, runs commands.
 └───────────┬──────────────┘  See transcripts/ for the literal record of this.
             │
             ▼
 ┌─────────────────────────┐
 │ agentic/generated/        │  the output: products.spec.ts, cart.spec.ts,
 │  *.spec.ts                │  checkout.spec.ts (Playwright/TS)
 └───────────┬──────────────┘
             │
             ▼
 ┌───────────────────────────────────────────────────────────────┐
 │ EVAL LAYER (agentic/eval/run-eval.js) — three gates, in order   │
 │                                                                  │
 │ 1. Spec conformance (static) — every HTTP call in the generated │
 │    suite must match a path+method that actually exists in the   │
 │    OpenAPI spec. Catches hallucinated endpoints before we ever  │
 │    execute anything.                                            │
 │                                                                  │
 │ 2. TypeScript compile — catches invalid/unsafe generated code.  │
 │                                                                  │
 │ 3. Mutation kill rate — run the SAME generated suite against    │
 │    two versions of a mock server implementing the spec:         │
 │      - FAITHFUL: correct implementation → suite must ALL PASS   │
 │      - MUTATED: 2 deliberately injected bugs → suite must FAIL  │
 │        at least one test, or it isn't testing anything real     │
 └───────────┬──────────────────────────────────────────────────────┘
             │
             ▼  eval report (pass/fail per gate, which mutations were/weren't caught)
 ┌─────────────────────────┐
 │  HUMAN REVIEW GATE        │  merges into automation/, revises the spec/prompt, or
 │  (QA engineer)             │  sends the agent back with the eval failure as new input
 └─────────────────────────┘
```

## How do you know the output is correct? (the eval layer, in detail)

"Correct" for a generated test doesn't mean "looks like a test" — it means "fails when the thing it's
testing is actually broken." That's what Gate 3 checks, and I built it as two intentionally-broken variants
of the same mock server (`agentic/eval/mock-server.js`, `MODE=mutated`):

1. **JPY (zero-decimal currency) rounding bug** — mutated mode returns a non-zero `nanos` for JPY, which is
   ISO-4217-invalid. This mirrors the exact risk called out in `test-cases/03-product-catalog-currency.md`
   TC-PC-01, found independently before I built the mock — the eval's injected bug and the manual test
   case's risk both trace back to the same real property of the system.
2. **Cart-not-cleared-after-checkout bug** — mutated mode's `/checkout` succeeds but never empties the
   cart. This is the property TC-CO-01 in `test-cases/01-checkout-flow.md` calls out as required.
3. **Quantity-overwrite-instead-of-accumulate bug** — mutated mode's `POST /cart` overwrites quantity on a
   repeated add instead of accumulating it (the TC-CT-01 ambiguity).

**Running the eval (`node agentic/eval/run-eval.js`) against what I actually generated this session:**
- Gate 1 (conformance): **passed** — 13 generated tests, all calls trace to a spec'd operation.
- Gate 2 (typecheck): **passed**.
- Gate 3a (faithful mock): **passed** — 12/13 passed, 1 skipped (the 422-payment-decline test is `test.skip`
  by design, since the mock has no flagd equivalent — see the comment in `checkout.spec.ts`).
- Gate 3b (mutated mock): **1 of 13 tests failed** — the cart-clearing test (`after a successful order, the
  cart for that user is empty`) caught bug #2.

**Bug #3 (quantity overwrite) was NOT caught, and I'm reporting that rather than quietly fixing the test
until it passed.** The generated test for repeated-add only asserts `lineItems).toHaveLength(1)` — true
whether the server overwrites or accumulates quantity. It doesn't assert the resulting *quantity value*,
because the prompt explicitly told the agent not to assert undocumented behavior, and neither the OpenAPI
spec nor the proto documents whether repeated `AddItem` accumulates. That instruction produced a *correct*
but *incomplete* test — exactly the tradeoff a human reviewer needs to see and decide on, not something an
eval script should silently paper over by loosening the prompt until everything passes. Bug #1 (JPY
rounding) also went uncaught in this run, for the same root cause: `products.spec.ts`'s nanos boundary test
checks the field stays in-range, not that it's specifically zero for a zero-decimal currency, again because
the spec doesn't state which currencies are zero-decimal. **Real mutation-kill rate this run: 1 of 3 injected
bugs caught by 1 of 13 tests.** That's the honest number, and it's the strongest evidence in this repo for
why "generate tests from a spec" still needs a human in the loop — a spec that's silent on a behavior
produces an agent that's silent on it too.

## Update: run against the real app (not the mock) caught a real bug

Docker finished installing partway through this assignment, so once `docker compose up` was live I re-ran
the exact same generated suite with `BASE_URL=http://localhost:8080` instead of the mock. 11 of 13 passed
— and the one real failure is the single most convincing result in this repo:

```
GET /products/{productId} › a nonexistent productId returns the documented 404
Expected: 404
Received: 500
```

I traced this independently by reading source, not from the test failure — `product-catalog`'s `GetProduct`
(`main.go`) correctly returns gRPC `codes.NotFound` for a missing ID, but the frontend BFF route
(`pages/api/products/[productId]/index.ts`) has no error handling around that call at all, so the rejection
becomes an unhandled exception and Next.js's default 500. **The agent-generated test caught this on its own,
against the real app, with no human pointing it at this specific case** — it's exactly the kind of contract
violation this whole pipeline exists to catch: the spec (written from reading the intended backend contract)
says 404, the real system says 500, and the generated suite is the thing that noticed. This is now also
pinned as a regression test in `automation/tests/api/product-catalog.spec.ts` (asserting the *current*, buggy
500, with a comment pointing at the real fix location) — see that file and `test-strategy.md` for how a
manual/automated pair handles a confirmed bug versus an open question.

## What the agent decides vs. what stays with a human

**The agent decides:**
- Which operations/fields in the spec need a test, and what the boundary values are (derived mechanically
  from `minimum`/`maximum`/`required`/`enum` in the schema).
- How to phrase and structure each test, and which existing conventions (`fixtures/testData.ts`, the
  `request` fixture pattern) to reuse instead of reinventing.
- When to flag a gap instead of guessing — e.g. both cases above, and the payment-decline test it correctly
  marked `.skip` rather than either fabricating a flagd equivalent in the mock or silently dropping the test.

**A human decides:**
- Whether the OpenAPI spec itself is right and complete — I wrote `frontend-api.yaml` by hand from reading
  the frontend's source, and it's the single biggest point of failure in this whole pipeline: an agent
  generating a large, confident-looking test suite from an incomplete spec is worse than no suite, because
  it looks like coverage. This is why the spec lives in version control and gets reviewed like any other
  contract, not regenerated implicitly.
- Whether an eval failure (or an eval *pass* with a gap like bug #3 above) means "fix the prompt," "fix the
  spec," "fix the test by hand," or "this behavior genuinely needs a human decision before any test can be
  written" — the eval tells you something is incomplete, not what to do about it.
- The merge decision into `automation/`. Nothing in `agentic/generated/` is wired into CI; it's a prototype
  output sitting next to its own eval report specifically so a reviewer can see the suite and the evidence
  for it side by side before deciding to promote it.
- Any assertion the eval layer itself can't check — e.g., whether the *values* returned are business-correct
  (I can check a currency conversion is internally consistent; I can't check it matches the actual bank rate
  the team intends without an external oracle, same limitation called out in `automation-strategy.md`).

## Honest limitations

- The mock server is a hand-written stand-in for the real backend, not the real backend. Gate 3's mutation
  tests prove the generated suite can detect *the specific bugs I injected into the mock*, not that it would
  catch every real regression in the actual Go/gRPC checkout service. Running `agentic/generated/*.spec.ts`
  against the real `docker compose up` stack (`BASE_URL=http://localhost:8080`) is the real validation, and
  is exactly why the prompt template targets `BASE_URL` as an env var instead of hardcoding the mock.
- One spec, three files, ~13 generated tests. I did not try to scale this to all 20 services in the time
  available — the honest scope here is "does this pipeline work at all, end to end, provably," not
  "here is a complete generated regression suite."
