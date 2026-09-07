# QA Engineering Manager Assignment — OpenTelemetry Astronomy Shop

Submission for the ArmorCode QA Engineering Manager AI Assignment, against the
[OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo) ("Astro Shop").

## Approach, in short

I focused depth over breadth on the three flows that carry the most real quality risk in this system —
**Checkout/Place Order, Cart, and Product Catalog & Currency Conversion** — rather than spreading thin
manual-test effort across all 20 services. The reasoning for that call is in [`test-strategy.md`](test-strategy.md)
§1. Everywhere I made a judgment call on ambiguous or undocumented behavior (does repeated add-to-cart
accumulate quantity? what should an empty-cart checkout do?), I documented the reasoning inline rather than
silently picking an answer — see the "Quality risk to flag before ship" callouts in
[`test-cases/`](test-cases/) and the "Honest limitations" section of [`agentic/AGENT-DESIGN.md`](agentic/AGENT-DESIGN.md).

The six required sections:

| Section | What's in it |
|---|---|
| [`test-strategy.md`](test-strategy.md) | Risk analysis, test pyramid, QA ownership model, CI gates, metrics |
| [`test-cases/`](test-cases/) | 11 detailed manual test cases across the 3 highest-risk flows |
| [`automation/`](automation/) | Playwright/TypeScript suite automating 10 of those 11 cases (91%) + one E2E golden path |
| [`automation-strategy.md`](automation-strategy.md) | Tool choice, team structure, CI wiring, flakiness handling |
| [`agentic/`](agentic/) | An OpenAPI-driven test-generation agent, with a real eval layer (spec conformance + mutation testing against faithful vs. deliberately-broken mock implementations) |
| [`REFLECTION.md`](REFLECTION.md) | Escalation risks, 4-engineer ownership model, week-1 vs. month-3 |

## Setup — running the app

```bash
git clone --depth=1 https://github.com/open-telemetry/opentelemetry-demo
cd opentelemetry-demo
docker compose up --wait
```

Frontend at `http://localhost:8080`. Feature-flag / fault-injection UI at `http://localhost:8080/feature`.

This repo assumes `opentelemetry-demo/` is cloned as a **sibling directory inside this repo** (i.e.
`qa-em-assignment/opentelemetry-demo/`) — that's the path the automation and agentic fixtures reference. It
is not committed here (it's a large, separately-maintained CNCF project); clone it fresh with the command
above from the repo root.

## Running the automation

```bash
cd automation
npm install
npx playwright install --with-deps chromium
npm test
```

See [`automation/README.md`](automation/README.md) for what's automated, what isn't, and why, plus the
gRPC-specific setup step for the one test that needs it.

## Running the agentic eval

```bash
cd agentic
npm install
npm run eval
```

This runs entirely against a self-contained mock server (`agentic/eval/mock-server.js`) — no Docker
required — and reports whether the AI-generated test suite in `agentic/generated/` actually catches
deliberately injected bugs, not just whether it runs. See `agentic/AGENT-DESIGN.md` for the full pipeline
and an honest accounting of what it did and didn't catch.

## The agent transcript

Per the assignment's submission requirements, the full transcript of the coding agent session used to build
this repo (Claude Code, run against this local codebase — not a web interface) is included at
[`agentic/transcripts/`](agentic/transcripts/), exported as the raw session JSONL.

## A note on tooling

Every file in this repo — the strategy docs, the test cases, the automation, the agentic pipeline and its
generated output — was produced in one continuous Claude Code CLI session operating directly on this
codebase and on a local clone of the demo app: reading source files (protos, frontend API routes, seed
data, an existing Cypress suite discovered along the way), running commands (`npm install`, `tsc`,
`playwright test`, the eval harness), and iterating based on real output (see `agentic/AGENT-DESIGN.md` for
a concrete example — an eval run that caught one injected bug and missed another, reported as-is). The
transcript in `agentic/transcripts/` is that session, unedited.
