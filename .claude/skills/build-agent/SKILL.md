---
name: build-agent
description: Build a new Claude Code subagent from a plain-English description, using the four-stage factory pipeline (architect, writer, critic, tester). Use when someone says they want a new agent, describes an agent they need, or invokes /build-agent.
---

# Build an agent

Someone described an agent they want. Run it through the factory and hand back a
working, tested `.claude/agents/<name>.md`.

The four stages each catch a different class of failure, so run all four. Skipping
the critic produces agents that load but misfire; skipping the tester produces
agents that look right and don't work.

## Stage 1 — Spec

Spawn `agent-architect` with the user's request verbatim, plus any context you
already have about the repository.

It returns a spec: name, description, purpose, tools, model, boundaries, output
contract, test scenarios.

**Show the spec to the user before building.** This is the one checkpoint that
matters — a wrong spec wastes all three later stages, and the user can spot a
wrong spec in ten seconds. Ask for a yes or corrections. If the architect proposed
splitting the request into several agents, that decision is the user's to make.

## Stage 2 — Write

Spawn `agent-writer` with the approved spec. It writes the file and reports the
path plus its frontmatter choices.

If the writer reports a name collision, stop and ask the user whether to replace
the existing agent or pick a new name. Never overwrite silently.

## Stage 3 — Review

Spawn `agent-critic` with the file path and the spec.

- Blockers and majors: fix them, then re-run the critic on the fixed file.
- Minors: fix the cheap ones, mention the rest.
- Two rounds is the limit. If blockers survive two rounds, the spec is probably
  wrong, not the file — go back to the user with what's stuck rather than
  grinding.

## Stage 4 — Test

Spawn `agent-tester` with the file path and the spec's test scenarios.

Fix failures and re-test. If a failure is genuinely a spec problem rather than an
implementation problem, say so instead of patching the prompt until the test
passes — an agent bent to pass its own tests is worse than one that fails them
honestly.

## Reporting back

Give the user:

- The path to the new agent and its `description` field, since that's what
  controls when it fires
- What it can and can't touch — tools and boundaries in one line each
- The test verdict, including anything that failed or was skipped
- How to run it: `Use the <name> agent to ...`, or `@<name>` in a prompt

Then ask whether to commit it.

## Notes

- New agents in a `.claude/agents/` directory that didn't exist when the session
  started need a restart before Claude Code sees them. If this is the first agent
  in the repo, tell the user that. Edits to existing agent files are picked up
  within a few seconds, no restart needed.
- Keep the spec in the conversation. All four stages need it, and the critic and
  tester are much weaker without it.
- The factory agents are themselves subagents, so anything they spawn nests one
  level deeper. The default depth limit is three below the main conversation,
  which the tester needs — don't run this pipeline from inside another subagent.
- For a trivial agent the user has already specced precisely themselves, going
  straight to `agent-writer` and then `agent-critic` is reasonable. Say that you
  skipped the architect and why.
