# Agent Design: OpenAPI-driven test generation

## Which option, and why

Test generation. Of the three options it is the one where "did the agent do real work" can be
checked mechanically: generate a suite from a contract, then prove whether the suite catches
anything. CI triage and self-healing both need a failure history to be more than a toy.

## The workflow

```
 ┌──────────────────────────┐
 │ openapi/frontend-api.yaml │  hand-written OpenAPI for the frontend BFF's cart/checkout/
 └────────────┬─────────────┘  catalog surface (the app ships .proto only, no OpenAPI)
              │
              ▼
 ┌──────────────────────────┐
 │ prompts/generate-tests.md │  what to generate per operation, what NOT to invent,
 └────────────┬─────────────┘  where output goes, "run the eval, don't stop until it passes"
              │
              ▼  agent reads spec + prompt + test-cases/ + automation/fixtures/
 ┌──────────────────────────┐
 │  AGENT (Claude Code CLI)  │  reads files, writes files, runs commands in this repo
 └────────────┬─────────────┘  transcripts/ is the literal record
              │
              ▼
 ┌──────────────────────────┐
 │ generated/*.spec.ts       │  products, cart, checkout (Playwright/TS)
 └────────────┬─────────────┘
              │
              ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ EVAL (eval/run-eval.js), three gates, cheapest first              │
 │ 1. Spec conformance: every request.<method>('<path>') in the     │
 │    generated code must match a path+method in the spec.          │
 │ 2. TypeScript compile.                                            │
 │ 3. Mutation kill: run the suite against eval/mock-server.js in   │
 │    MODE=faithful (must all pass) then MODE=mutated, which has 3  │
 │    injected bugs (must fail somewhere, or the suite tests        │
 │    nothing).                                                      │
 └────────────┬────────────────────────────────────────────────────┘
              │
              ▼  eval report
 ┌──────────────────────────┐
 │  HUMAN REVIEW             │  promote into automation/, fix the spec, fix the prompt,
 └──────────────────────────┘  or send the agent back with the eval output as input
```

## The three injected bugs

1. **JPY rounding.** Mutated mode returns non-zero `nanos` for JPY, a zero-decimal currency.
2. **Cart not cleared after checkout.** Mutated `/checkout` succeeds but leaves the cart populated.
3. **Quantity overwrite.** Mutated `POST /cart` overwrites quantity on a repeated add instead of accumulating.

Each maps to a risk in `test-cases/`: TC-PC-01, TC-CO-01, TC-CT-02.

## What actually happened: two runs

**Run 1** (7 Sep, session `ca468bbc`, the same session that built the harness). 13 tests.
Faithful mock: 12 pass, 1 skipped. Mutated mock: 1 failure, the cart-clearing test. Bugs 1 and 3 were
not caught. The repeated-add test asserted only that one line item existed, which is true whether the
server overwrites or accumulates. The prompt told the agent not to assert undocumented behaviour, and
the spec is silent on accumulation, so the agent was silent too.

**Run 2** (13 Sep, session `f4cf2bd9`). A fresh session was given the prompt file verbatim and nothing
else. The agent read the spec, fixtures and existing suite, wrote 23 tests to `generated-test/`, changed
the eval config to scan any `generated*/` directory, ran the eval itself, and reported. Results from the
files as they are now (`npm run eval`, 13 Sep):

| Gate | Result |
|---|---|
| 1 Conformance | pass, 3 files |
| 2 Typecheck | pass |
| 3a Faithful mock | 21 pass, 2 skipped, 0 fail |
| 3b Mutated mock | 2 fail: cart-not-cleared, quantity-overwrite |

Kill rate 2 of 3. Run 2 asserted the accumulated value (1 + 2 = 3) explicitly and flagged it in a comment
as a cross-operation inference a human should confirm. Bug 1 (JPY) is still not caught: the spec never
says which currencies are zero-decimal, so the agent wrote an observation with an annotation rather than a
hard assertion. That is the correct reading of the prompt, and it is also a gap. Fixing it means fixing the
spec, not loosening the prompt.

After run 2, the first run's `generated/` was replaced with the second run's output by hand (`mv`), outside
any agent session. The transcripts README says so, and the file headers carry a provenance note.

## Run against the real app

Same files, `BASE_URL=http://localhost:8080` against `docker compose up` (13 Sep): 19 pass, 2 skipped,
2 fail. Both failures are real bugs, not test defects.

- `GET /products/{id}` for a nonexistent ID returns 500, not the documented 404. `product-catalog`
  returns gRPC `NotFound`; the BFF route in `pages/api/products/[productId]/index.ts` has no error
  handling and converts it to an unhandled 500. Pinned in `automation/tests/api/product-catalog.spec.ts`.
- `POST /cart` with the required `quantity` field omitted returns 500 instead of a 4xx. New finding from
  this run, not yet pinned in `automation/`.

Neither was pointed at by a human. The spec said 404 and "quantity required"; the generated tests checked
those; the live system disagreed.

## What the agent decides vs. what a human decides

**Agent:**
- Which operations and fields get a test, and the boundary values, derived from `required`, `minimum`,
  `maximum`, `enum` in the schema.
- Test structure and which existing fixtures to reuse.
- When to flag instead of guess: the payment-decline 422 it marked `test.skip` because the mock has no
  fault path, the empty-cart 500 it declined to treat as spec-derived, the JPY observation.

**Human:**
- Whether the spec is right. `frontend-api.yaml` was written by hand from the BFF source and is the
  single biggest point of failure. A confident suite from an incomplete spec looks like coverage and is not.
- What an eval result means: fix the prompt, fix the spec, fix the test, or "this behaviour needs a
  product decision first."
- Promotion into `automation/`. Nothing in `generated/` is wired to CI.
- Anything the eval cannot check, such as whether a conversion rate is the one the business intends.

## Limitations I would fix next

- **The agent edited its own eval harness** in run 2 (test match, tsconfig, conformance check) to
  accommodate its output directory. The result was benign and it reported the change, but a production
  pipeline should make `eval/` read-only to the agent.
- **Gate 3b passes on a single failure.** A 1 of 3 kill rate passes. It should report a per-mutation kill
  matrix, one mutation per pass, with a threshold.
- **7 of the 23 tests cannot kill a mutation.** Five assert only "not a 5xx" and annotate; two are skipped.
  An extra gate should reject tests with no hard assertion.
- **Conformance is a regex** over source text. It misses URLs built from variables and never validates the
  response body against the schema. A JSON-schema check of responses is the obvious next gate.
- **The mock is hand-written from the same spec by the same agent.** Generating the faithful mock from the
  spec with Prism, and injecting mutations via a proxy, would take the author out of the oracle.
- **No orchestrator.** The loop "generate, eval, feed failures back" is a person re-prompting. A script
  wrapping `claude -p` with a retry budget would make the pipeline reproducible for someone who is not me.
- One spec, three files, one service. The point was to prove the loop end to end, not to cover 20 services.
