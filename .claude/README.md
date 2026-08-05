# The agent org

One person you talk to. Two teams behind them. Everything reports up.

```
                        you
                         │
                personal-assistant          memory: how you work
                 │                │
        ┌────────┘                └────────┐
        │                                  │
    producers                          researchers
        │                                  │
  agent-architect  →  spec           research-scout      →  what's new
  agent-writer     →  file           research-analyst    →  what to build
  agent-critic     →  review
  agent-tester     →  run it
```

You talk to `personal-assistant`. It talks to the teams. The teams never talk to
you directly — that's the point.

## The roster

| Agent | Team | Model | What it does |
|---|---|---|---|
| `personal-assistant` | hub | opus | Gathers from everyone, checks Gmail and Calendar, returns one brief. Remembers how you work. |
| `agent-architect` | producers | opus | Turns a vague ask into a buildable spec |
| `agent-writer` | producers | opus | Writes the `.claude/agents/<name>.md` file |
| `agent-critic` | producers | opus | Reviews it read-only for the flaws that make agents misfire |
| `agent-tester` | producers | sonnet | Actually runs the new agent against its spec |
| `research-scout` | researchers | sonnet | Finds what's new in the agent space, filters the noise |
| `research-analyst` | researchers | opus | Turns findings into ranked proposals and upgrades |

## Using it

**Get a brief** — everything, filtered, in one place:
```
/brief
```
or just ask: *"what's going on?"*, *"brief me"*, *"any updates?"*

**Build a new agent:**
```
/build-agent I want an agent that checks my KM logs for bad entries
```
The architect specs it, you approve the spec, then writer → critic → tester run.

**Ask for ideas:**
```
what should I build next?
```
The assistant answers from memory — what you actually do repeatedly — rather than
from a news feed.

**Talk to one agent directly** (bypasses the hub, sometimes what you want):
```
@research-scout what shipped in MCP this week
```

## Memory

`personal-assistant`, `research-scout`, and `research-analyst` each have a
persistent memory directory under `.claude/agent-memory/<name>/`, committed to
git. They read it before working and update it after.

The assistant's memory is the important one — it holds how you work, what you're
building, what you've already rejected, and any standing orders you've given
("stop mentioning X", "always lead with Y"). It's a plain Markdown file. Read it,
edit it, correct it whenever it's wrong:

```
.claude/agent-memory/personal-assistant/MEMORY.md
```

It was seeded from the session that built this org, so it already knows about
Km-Tracker, your connectors, and your working style. Some of that is inference —
fix what's wrong and it stops being wrong.

## Running it on a schedule

For a brief that arrives without you asking, use a **Routine**, not `CronCreate`:

> create a Routine that runs /brief every weekday at 8:55am

Routines survive across sessions. `CronCreate` jobs are session-only and die when
the session ends — they're for "check back in 20 minutes", not for daily briefs.

## What it can't do

- **No always-on execution.** This container is ephemeral. Agents run when a
  session runs or when a Routine fires. Nothing is watching your inbox in real
  time between those.
- **No sending.** The assistant drafts email; you send it. No calendar invites to
  other people, no external posts.
- **"Messages" needs a connector.** Slack, Notion, Linear, and Telegram aren't
  authorized yet. Composio can reach all of them — connect one and the assistant
  picks it up.
- **Depth limit.** Assistant → team → tester → agent-under-test is four levels,
  and the default limit is three below the main conversation. Run `/brief` and
  `/build-agent` from the main conversation, not from inside another agent.

## Changing an agent

Edit the file — changes load within seconds, no restart. Adding an agent to a
`.claude/agents/` subfolder that didn't exist at session start needs a restart
before it's picked up.

Names must be unique across the whole tree; the folders (`producers/`,
`researchers/`) are organization only and don't affect how an agent is invoked.
