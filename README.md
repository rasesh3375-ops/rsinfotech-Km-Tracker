# Jarvis — an agent org that costs nothing to run

A voice dashboard and four agent teams, running on free-tier LLM APIs. No
subscription, no credit card, no orchestration platform.

```
        browser (voice + dashboard)
                  │  POST /api/agent
                  ▼
             ┌─────────┐
             │   HUB   │  the assistant — routes and answers
             └────┬────┘
       ┌──────────┼──────────┐
       ▼          ▼          ▼
  PRODUCERS  RESEARCHERS  WATCHDOG
  architect   scout        health checks,
  writer      analyst      no model calls
  critic
```

Open the dashboard and you watch the teams work — live status, elapsed timers,
and the assistant lighting up whichever team it delegates to.

## What it costs

Nothing. Not a trial, not a credit — actually nothing.

| Piece | Free tier |
|---|---|
| **OmniRoute** (local gateway) | 290+ providers, 90+ free, **no signup at all** |
| **Groq** (default LLM) | 30 req/min, 14,400 req/day, every model, **no card** |
| **Gemini** (alternative) | generous daily quota, **no card** |
| **Ollama** (alternative) | unlimited, fully local and private |
| **Vercel Hobby** | serverless functions, already hosting this repo |
| **GitHub Actions** | free on public repos; ~2 min/day here on private |
| **Search sources** | Hacker News + Reddit JSON — free, keyless |

You can also skip hosting entirely and run it from your terminal.

## Three ways to run it

### 1. Terminal — no hosting at all

```bash
export GROQ_API_KEY=your-free-key      # console.groq.com/keys
npm run ask                            # interactive
npm run ask -- "what should I build?"  # one shot
npm run ask -- --team watchdog         # health, uses no quota
npm run ask -- --team researchers --topic "agent memory"
npm run ask -- --team producers --request "an agent that watches my deploy logs"
```

No install step — the code has zero dependencies. Node 20+ is all you need.

### 2. Voice, deployed

Add `GROQ_API_KEY` in **Vercel → Settings → Environment Variables**, push, then
open `your-domain.com/jarvis`. The interface defaults to `/api/agent` on the same
origin, so there is nothing to configure and no CORS to get wrong.

### 3. Scheduled

Add `GROQ_API_KEY` as a repository secret (**Settings → Secrets and variables →
Actions**). The workflow then runs health checks every 30 minutes and a research
sweep on weekday mornings.

Alerting comes free: when a job fails, GitHub emails you. Nothing to configure.
Sweep output lands in the run summary and as a 30-day artifact.

## Switching provider

One environment variable.

```bash
export LLM_PROVIDER=omniroute                               # no signup at all
export LLM_PROVIDER=gemini   && export GEMINI_API_KEY=...   # aistudio.google.com/apikey
export LLM_PROVIDER=ollama                                  # local, no key, no limits
export LLM_PROVIDER=openrouter && export OPENROUTER_API_KEY=...
```

On **Windows PowerShell**, `export` does not exist — use `$env:`:

```powershell
$env:LLM_PROVIDER = "omniroute"
$env:GROQ_API_KEY = "your-key"
npm run ask
```

Those last for the current window only. To persist across terminals:

```powershell
[Environment]::SetEnvironmentVariable("GROQ_API_KEY", "your-key", "User")
```

The `npm run` commands are identical on every platform.

All five speak the OpenAI chat-completions format, so there is exactly one code
path in `lib/llm.js`. Adding a provider is four lines in the `PROVIDERS` map.

For Ollama, use a model with real tool-calling support — `qwen2.5:14b` or
`llama3.1:8b`. Smaller models call tools incoherently and the agents misbehave in
ways that look like prompt bugs.

### OmniRoute

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is an MIT-licensed local
gateway that fans one OpenAI-compatible endpoint out to 290+ providers, 90+ of
them free. Because `lib/llm.js` already speaks that format, it slotted in as a
provider entry — no adapter, no SDK.

```bash
npm install -g omniroute
omniroute                       # dashboard and API on port 20128 — leave it running
```

Then in a **second** terminal, since the first is now a running server:

```bash
export LLM_PROVIDER=omniroute   # PowerShell: $env:LLM_PROVIDER = "omniroute"
npm run ask                     # model "auto" routes to keyless free providers
```

**PowerShell script-execution error?** A global npm install creates a `.ps1`
shim, and Windows blocks unsigned scripts by default:

> omniroute.ps1 cannot be loaded because running scripts is disabled on this system

Either allow local scripts once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

or skip the shim entirely by calling `omniroute.cmd` instead.

It's the only option here needing **no account, no key, and no signup** — the
`auto` model ships pre-wired to keyless providers. Set `OMNIROUTE_API_KEY` only
if you generate a key in its dashboard; without one, `auto` still works. Point
`OMNIROUTE_URL` elsewhere if it isn't on the default port.

**It only works where it's running.** OmniRoute is a local process, so it covers
the terminal path and a locally-run function. A deployed Vercel function cannot
reach your laptop — keep Groq or Gemini configured for the hosted path. The
watchdog checks the gateway is actually up when this provider is selected, since
"configured but not started" is the failure you'd otherwise only discover
mid-conversation.

One thing worth knowing: routing through any gateway means whichever upstream
provider it picks sees your prompts. OmniRoute runs locally with no telemetry by
default, so the gateway itself isn't the concern — the free upstream providers
behind it are. Fine for building agents; think twice before piping anything
confidential through the free tier.

### Pointing Claude Code itself at OmniRoute

Separate from the agent org: OmniRoute also exposes an **Anthropic-compatible**
`/v1/messages`, so Claude Code can run against it instead of Anthropic.

```bash
npm run claude:status      # what is Claude Code using right now?
npm run claude:omniroute   # switch this project to the gateway
npm run claude:anthropic   # switch back
```

Then restart Claude Code — it reads env vars once at startup.

Pass a model to pin one: `node scripts/claude-omniroute.js on glm/glm-5.2`.
Default is `auto`. Set `OMNIROUTE_API_KEY` first if you generated a key in the
dashboard; otherwise a placeholder token is written, which is fine locally.

OmniRoute's own `omniroute launch` does the same thing for a single session. The
script here differs by persisting the choice for this project and giving you a
clean way to undo it.

**Why a toggle rather than committed settings.** These env vars point Claude Code
at `localhost:20128`. Written into `.claude/settings.json`, which is committed,
they would break Claude Code for every clone of this repo and in every
environment where the gateway isn't running — including cloud sessions, which
have no localhost to reach. So the script writes `.claude/settings.local.json`
instead: gitignored, machine-local, reversible.

It merges rather than overwrites, so unrelated settings in that file survive both
directions. It refuses to touch the file if it isn't valid JSON, because a
malformed settings file silently disables every setting in it. And it warns when
you switch on while the gateway is down, since that combination leaves Claude
Code unable to make any request at all.

Worth being clear about the tradeoff: this makes Claude Code run on whatever
model the gateway routes to, not on Claude. That's the point of doing it, but it
does change what you're talking to.

## Files

| Path | What |
|---|---|
| `lib/llm.js` | Provider config, chat call with rate-limit backoff, the tool loop |
| `lib/tools.js` | Free keyless tools: HN search, Reddit search, page fetch |
| `lib/teams.js` | All six agent prompts and the four team runners |
| `api/agent.js` | One serverless endpoint, routed by `?team=` |
| `scripts/ask.js` | Terminal client |
| `scripts/selftest.js` | `npm run check` |
| `.github/workflows/agent-org.yml` | Free scheduling and alerting |
| `jarvis/index.html` | Voice interface |

## Design notes

**The watchdog makes no LLM calls.** It verifies configuration and that the
upstream sources answer. Asking "is everything working" should be instant and
should never burn quota — the free tier is a daily request budget, and a monitor
that eats it is worse than no monitor.

**`?team=ping` touches nothing.** No model, no network. Poll it as often as you
like; it is the honest liveness signal.

**The hub calls teams in-process**, not over HTTP. In a serverless runtime a
self-call means a second cold start and a second timeout budget for no benefit.

**Everything heading for the voice layer goes through `speakable()`.** Error
messages carry URLs and `SCREAMING_SNAKE` identifiers; a speech synthesiser reads
those literally and the sentence becomes noise. This was a real bug the self-test
caught.

**Tool failures are handed back to the model, not thrown.** It can usually
recover by trying different arguments, and throwing loses the whole turn.

**`maxSteps` caps the tool loop.** An agent that cannot finish in six calls is
stuck, and letting it spin burns the daily quota.

## Limits worth knowing

- **Conversation memory is per warm instance.** Serverless containers recycle, so
  the hub forgets. For durable memory, add Vercel KV or Upstash Redis — both have
  free tiers — and replace the `sessions` Map in `lib/teams.js`.
- **60-second function ceiling on Vercel Hobby.** The producers chain is three
  sequential model calls; Groq is fast enough that this fits comfortably, slower
  providers may not.
- **Free tiers rate-limit.** `lib/llm.js` backs off and retries on 429, but 30
  req/min is a real ceiling if you hammer it.
- **No general web index.** HN and Reddit cover the technical space these agents
  research, but there is no Google. Adding Tavily or Brave later is one entry in
  `lib/tools.js`.
- **GitHub's scheduler drifts** under load. The 30-minute health check is "about
  every half hour", not exact.

## Test status

`npm run check` passes here: watchdog, speech sanitisation, tool schemas, and the
URL-scheme guard. The network-dependent tests and both LLM tests **skip** in this
sandbox — outbound HTTPS to `hn.algolia.com`, `reddit.com` and `example.com` is
blocked by policy, and no API key is set. Run it on your own machine with a key
to exercise those paths; they have not been executed.
