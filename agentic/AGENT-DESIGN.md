# Agent Design: OpenAPI-driven test generation

## Which option, and why

Test generation. Of the three options it is the one where "did the agent do real work" can be
checked mechanically: generate a suite from a contract, then prove whether the suite catches
anything. CI triage and self-healing both need a failure history to be more than a toy.

## The workflow

```
 ┌──────────────────────────┐
 │ openapi/frontend-api.yaml│  hand-written OpenAPI for the frontend BFF's cart/checkout/
 └────────────┬─────────────┘  catalog surface (the app ships .proto only, no OpenAPI)
              │
              ▼
 ┌──────────────────────────┐
 │ prompts/generate-tests.md│  what to generate per operation, what NOT to invent,
 └────────────┬─────────────┘  where output goes, "run the eval, don't stop until it passes"
              │
              ▼  agent reads spec + prompt + test-cases/ + automation/fixtures/
 ┌──────────────────────────┐
 │  AGENT (Claude Code CLI) │  reads files, writes files, runs commands in this repo
 └────────────┬─────────────┘  transcripts/ is the literal record
              │
              ▼
 ┌──────────────────────────┐
 │ generated/*.spec.ts      │  products, cart, checkout (Playwright/TS)
 └────────────┬─────────────┘
              │
              ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ EVAL (eval/run-eval.js), three gates, cheapest first            │
 │ 1. Spec conformance: every request.<method>('<path>') in the    │
 │    generated code must match a path+method in the spec.         │
 │ 2. TypeScript compile.                                          │
 │ 3. Mutation kill: run the suite against eval/mock-server.js in  │
 │    MODE=faithful (must all pass) then MODE=mutated, which has 3 │
 │    injected bugs (must fail somewhere, or the suite tests       │
 │    nothing).                                                    │
 └────────────┬────────────────────────────────────────────────────┘
              │
              ▼  eval report
 ┌──────────────────────────┐
 │  HUMAN REVIEW            │  promote into automation/, fix the spec, fix the prompt,
 └──────────────────────────┘  or send the agent back with the eval output as input
```

## The three injected bugs in mock server

1. **JPY rounding.** Mutated mode returns non-zero `nanos` for JPY, a zero-decimal currency.
2. **Cart not cleared after checkout.** Mutated `/checkout` succeeds but leaves the cart populated.
3. **Quantity overwrite.** Mutated `POST /cart` overwrites quantity on a repeated add instead of accumulating.

Each maps to a risk in `test-cases/`: TC-PC-01, TC-CO-01, TC-CT-02.

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