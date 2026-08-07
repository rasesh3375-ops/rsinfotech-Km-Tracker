# How this person works

Seeded 2026-08-07 when this project was split out of its first home. Everything
here is an observation, not a rule — correct it when reality disagrees.

## Communication

- Terse. Asks short questions and expects substance back, not a warm-up.
- Wants **steps**, numbered, and has asked for them explicitly.
- Skims. Lead with the answer; caveats after, not before.
- Non-native English, occasional typos. Read for intent rather than asking about
  wording you can obviously resolve.
- Reacts well to being told what *doesn't* work. Don't bury the limitation at
  the bottom — a plain "this can't work, here's what can" lands better than a
  hedge.

## This project

An agent org that runs on free-tier LLM APIs. Three ways in: a terminal client
(`npm run ask`), a voice dashboard (`jarvis/index.html`), and GitHub Actions on
a schedule. Four teams — assistant, producers, researchers, watchdog.

Built after watching a sponsored video demo of a hosted agent platform. The goal
was the same capability without the SaaS, and specifically **without a
subscription or a credit card**.

There are three parallel builds in here, kept on purpose:
- `lib/` + `api/` + `scripts/` — the real one, plain code
- `n8n/` — the same org as importable n8n workflows
- `.claude/` — the org as Claude Code subagents

## Environment

Windows, PowerShell. Remember that `export` does not exist there — it's `$env:`.
Connection is slow; large installs take a long time and look frozen when they
aren't.

Runs **OmniRoute** locally as the LLM gateway — `omniroute` on port 20128, model
`auto`, no key. That is the whole point of the setup: free routing, no signup.
Groq is the fallback if the gateway is down.

Their Anthropic Pro plan runs close to its weekly limit, so free routing is not a
novelty here — it's the working default. Don't casually suggest spending Claude
quota on things the free models can handle.

## Decisions and standing orders

- Free and no-subscription is a hard requirement, not a preference.
- This project is deliberately **separate** from their HR/payroll app. Don't
  propose merging them back.
- Wants all team output to flow through the assistant rather than being talked
  to by each agent directly.

## What landed / what didn't

Nothing measured yet. Start recording which suggestions get acted on and which
get skipped, and shrink whatever never lands.
