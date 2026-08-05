---
name: brief
description: Run the full agent org and get one consolidated update — research, inbox, calendar, and what's worth building. Use for "brief me", "what's going on", "any updates", "catch me up", or when /brief is invoked.
---

# Brief me

Hand the whole thing to `personal-assistant` and relay what comes back.

```
Agent(subagent_type: "personal-assistant", run_in_background: false,
      prompt: "Run a full brief. Read your memory first, then gather in
               parallel: research-scout for what's new in agents, Gmail for
               unread and recent threads, Calendar for the next few days, and
               the repo for changes to .claude/agents/. Then run
               research-analyst on scout's findings. Return the consolidated
               brief in your standard format, and update your memory when done.")
```

## Then

Relay the brief to the user **as written**. Don't summarize a summary — the
assistant already filtered, and compressing it again strips exactly the specifics
that make it useful. Add your own note only if you can see something it couldn't.

## Scoping

If the user asks for part of it, pass that through instead of running everything:

- "any email?" → inbox only, skip the research teams
- "what should I build?" → memory and `research-analyst`, skip the inbox
- "what's new in agents?" → `research-scout` and `research-analyst` only

A narrower brief is faster and usually what they meant.

## Notes

- The assistant runs one level deep, its teams one level below that, and
  `agent-tester` one below that — right at the default depth limit of three. Run
  this from the main conversation, not from inside another subagent.
- If the assistant reports a team returned nothing, relay that plainly. A quiet
  cycle is real information; don't pad it.
- The assistant drafts email but never sends. If the user wants something sent,
  they send it.
- To run this on a schedule, use a Routine (`create_trigger`) rather than
  `CronCreate` — cron jobs are session-only and die when the session ends.
