# QA Engineering Manager Assignment: OpenTelemetry Astronomy Shop

Submission for the ArmorCode QA Engineering Manager AI Assignment, against the
[OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo) ("Astro Shop").

## Approach

Depth over breadth. I picked the three flows that carry real risk in this system, **Checkout, Cart, and
Catalog/Currency**, wrote detailed manual cases for them, automated what was automatable against the live
stack, and used the rest of the time on an agentic test-generation pipeline with an eval layer that can
tell a useful generated suite from a useless one.

Running everything against the real app, not just writing it, is what produced the findings that matter:
five confirmed application bugs, including a checkout that charges the card and then leaves the cart full
when the cart service fails, and two concurrent checkouts that both succeed. Where behaviour was
undocumented I wrote the ambiguity down instead of guessing; see the "Quality risk to flag" notes in
`test-cases/` and the limitations section of `agentic/AGENT-DESIGN.md`.

| Section | Contents |
|---|---|
| [`test-strategy.md`](test-strategy.md) | Risk analysis, pyramid, ownership model, CI gates, metrics |
| [`test-cases/`](test-cases/) | 18 manual cases across the 3 flows, each with preconditions, steps, edge cases, risks to flag |
| [`automation/`](automation/) | Playwright/TypeScript suite: 14 of 18 cases automated, 5 confirmed bugs pinned, one E2E golden path |
| [`automation-strategy.md`](automation-strategy.md) | Tool choice, team structure, CI wiring, flakiness, test data |
| [`agentic/`](agentic/) | OpenAPI-driven test generation with a three-gate eval (spec conformance, typecheck, mutation kill against faithful vs. mutated mocks), plus both generation-run transcripts |
| [`REFLECTION.md`](REFLECTION.md) | Escalations, 4-engineer ownership, week 1 vs. month 3 |

## Running the app

```bash
# from this repo's root
git clone --depth=1 https://github.com/open-telemetry/opentelemetry-demo
cd opentelemetry-demo
docker compose up --wait
```

Frontend at `http://localhost:8080`. Feature flags at `http://localhost:8080/feature`.

The demo is cloned into `qa-em-assignment/opentelemetry-demo/` and is gitignored. The automation suite does
**not** depend on that clone being present or on its location — it talks to the app only over the REST BFF
at `BASE_URL`.

## Running the automation

```bash
cd automation
npm install
npx playwright install --with-deps chromium
npm test              # API + E2E against http://localhost:8080
```

Override the target with `BASE_URL=...` if the frontend isn't on the default port.

See [`automation/README.md`](automation/README.md) for what is automated, what is not and why, and the
live findings.

## Running the agentic eval

```bash
cd agentic
npm install
npm run eval          # no Docker needed; runs against the bundled mock server
```

Reports whether the generated suite catches deliberately injected bugs, not just whether it runs. Point
the same suite at the live app with `BASE_URL=http://localhost:8080 npx playwright test` to reproduce the
two real bugs it found. Pipeline, prompts, eval design and results are in
[`agentic/AGENT-DESIGN.md`](agentic/AGENT-DESIGN.md).

## Agent transcripts

Both Claude Code sessions that built and ran the agentic pipeline are in
[`agentic/transcripts/`](agentic/transcripts/) as raw, unedited JSONL exports. The README there says
which session did what, and names the one step (a manual `mv`) that is not in either.

## Tooling note

Claude Code (the CLI) was the coding agent throughout: it cloned and ran the demo, read the frontend and
service source, ran the suites, and iterated on real output. The judgement calls in the strategy, test
cases and reflection are mine; the transcripts show where the agent's first attempt was wrong (a flag
that did not do what its name said, a selector that did not exist, an assumed call order in checkout that
was backwards) and how each was corrected by reading the source and running the code.
