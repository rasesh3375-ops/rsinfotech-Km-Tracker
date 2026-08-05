# How this person works

Seeded 2026-08-05 from the session that built this org. Everything here is an
observation, not a rule — correct it when reality disagrees.

## Communication

- Terse. Asks short questions and expects substance back, not a warm-up.
- Wants **steps**. Has asked for them explicitly. Number them.
- Skims. Lead with the answer; put caveats after, not before.
- Non-native English, occasional typos. Read for intent, don't ask for
  clarification on wording you can obviously resolve.
- Reacts well to being told what *doesn't* work. Doesn't want the limitation
  buried at the bottom.

## Current projects

**Km-Tracker** (`rsinfotech-Km-Tracker`) — a static PWA: `index.html`, manifest,
icons, `vercel.json` with `/hr` rewrites. Deployed on Vercel. Backend is Google
Apps Script (`apps-script/Code 2.js`) that almost certainly reads and writes a
Google Sheet. **The sheet has never been inspected** — the Apps Script contract
has not been verified against real data. This is the most likely place bugs live.

**The agent org** — built 2026-08-05 on branch
`claude/connectors-new-capabilities-9q6ioo`. Producers team first, then this
hub-and-spoke structure. Motivated by a sponsored YouTube video demoing
Hyperagent, a hosted agent platform; they wanted the same capability without the
SaaS.

**YouTube channel** — "Moksh doshi" (`@crazygamer-vv3ts`,
`UC08ZON-YFWLhMz-SAgFDcmg`). 236 subs, 62k views, 117 uploads, all Free Fire,
all 2021. Dormant ~5 years. Known issues never acted on: ~20 near-duplicate
"Attitude status para Samsung" titles competing with each other, and five
zero-view livestream stubs. Don't re-raise unless asked — it was noted once.

## Connected tools

Gmail, Google Calendar, Google Drive, Vercel, GitHub, and Composio (which reaches
~500 more apps on demand). YouTube is authorized through Composio.

**Not connected:** Slack, Notion, Linear, Telegram, WhatsApp. They mentioned
wanting "messages" alongside Gmail in the brief — that needs one of these
authorized first. Ask once, then drop it.

## Decisions and standing orders

- Agents live in this repo's `.claude/`, version-controlled — chose this over
  `~/.claude` global scope.
- All work goes to `claude/connectors-new-capabilities-9q6ioo`. Never push
  elsewhere without asking.
- Wants the org's communication to flow teams → personal-assistant → them. They
  do not want to be talked to by every agent.

## Open threads

- The Google Sheet behind Km-Tracker has never been read. Offer once more when
  relevant; it's the highest-value unblocked task available.
- The producers pipeline has been validated statically but has never been run
  end to end on a real agent.

## What landed / what didn't

Nothing measured yet. Start recording which brief sections get acted on and
which get skipped, and shrink the ones that never land.
