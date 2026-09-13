# Prompt: Generate an API test suite from an OpenAPI spec

You are a QA automation engineer. Generate a Playwright (TypeScript) test suite for the API
described in `agentic/openapi/frontend-api.yaml`.

## Inputs available to you (read them before generating anything)

1. `agentic/openapi/frontend-api.yaml` — the contract. Every test you generate must trace back
   to something actually stated in this spec: a path, a required field, a type constraint,
   an enum, a min/max, or a documented response code. Do not invent behavior the spec doesn't
   state.
2. `test-strategy.md` and `test-cases/*.md` in the repo root — the existing human-written risk
   analysis. If the spec and the test cases disagree, or the test cases cover something the
   spec doesn't model, say so explicitly in a comment rather than silently picking one.
3. `automation/fixtures/testData.ts` — reuse the real product IDs defined there instead of
   inventing synthetic ones, so generated tests exercise real seeded data.

## What to generate, per path + operation in the spec

For each operation, generate:
- **One test for the documented success response** — assert the response status matches the
  spec, and that the response body satisfies every `required` field and type in the operation's
  response schema (presence + type, not exact values you can't know in advance).
- **One test per explicitly documented error response** (e.g. `404`, `422`) — construct the
  input that the spec's parameter/schema constraints imply should trigger it (e.g. a
  non-existent `productId` for a 404; omit a `required` field for a 4xx if the spec marks it
  required).
- **One boundary test per constrained field** you find in the schema — `minimum`/`maximum`,
  `minLength`/`maxLength`, `enum`. Example: `CreditCardInfo.creditCardExpirationMonth` has
  `minimum: 1, maximum: 12` — generate a test with `13` and one with `0`.

## What NOT to do

- Do not assert on exact prices, IDs, or generated values the spec doesn't fix (e.g. don't
  hardcode an expected `orderId` string — the spec doesn't constrain its format beyond "a
  string").
- Do not generate a test for behavior not in the spec, even if you can guess at it from the
  test-cases/ files — flag the gap in a comment instead (this is what a human reviewer checks).
- Do not generate more than one test per boundary condition — a full pairwise combinatorial
  matrix across every field is not the goal; targeted boundary + happy-path + documented-error
  coverage is.

## Output

Write the suite to `agentic/generated/<operation-group>.spec.ts` (the eval harness picks up any
`agentic/generated*/` directory, so a differently named output directory is still evaluated),
using the same Playwright
`request` fixture pattern as `automation/tests/api/*.spec.ts` (for consistency with the
human-written suite this is meant to sit alongside). Target `BASE_URL` via
`process.env.BASE_URL`, defaulting to `http://localhost:4000` (the eval mock server), so the
same generated file can run against either the mock (during eval) or the real docker-compose
stack (`BASE_URL=http://localhost:8080`).

After generating, run `agentic/eval/run-eval.js` yourself and report the result. Do not
consider the task done until the eval passes — a suite that fails the mutation-kill check is
not a finished suite.
