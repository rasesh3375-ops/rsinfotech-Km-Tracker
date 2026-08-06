# The agent org — free build

Same org, no orchestration platform and no subscription. Runs on free-tier LLM
APIs that need no credit card, with GitHub Actions doing the scheduling.

```
  voice UI  ──►  /api/agent  ──►  hub  ──┬──► producers   architect→writer→critic
  (browser)      (serverless)            ├──► researchers scout→analyst
                                         └──► watchdog    health, no LLM calls
                     ▲
        GitHub Actions cron (free)
        every 30 min: health · weekday 06:23: research sweep
```

## What it costs

Nothing. Not a trial, not a credit — actually nothing.

| Piece | Free tier |
|---|---|
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
npm run ask -- --team producers --request "an agent that checks my KM logs"
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
export LLM_PROVIDER=gemini   && export GEMINI_API_KEY=...   # aistudio.google.com/apikey
export LLM_PROVIDER=ollama                                  # local, no key, no limits
export LLM_PROVIDER=openrouter && export OPENROUTER_API_KEY=...
```

All four speak the OpenAI chat-completions format, so there is exactly one code
path in `lib/llm.js`. Adding a provider is four lines in the `PROVIDERS` map.

For Ollama, use a model with real tool-calling support — `qwen2.5:14b` or
`llama3.1:8b`. Smaller models call tools incoherently and the agents misbehave in
ways that look like prompt bugs.

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
