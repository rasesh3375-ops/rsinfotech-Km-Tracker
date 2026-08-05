# The agent org, on n8n

Four workflows and a voice interface. No Claude — the agents run on OpenAI by
default, and the model is one field you can swap.

```
   browser (voice)
        │  POST /webhook/jarvis
        ▼
  ┌───────────────┐
  │ 1 JARVIS HUB  │  gpt-4o + conversation memory
  │  the assistant│  decides which team to call
  └───┬───┬───┬───┘
      │   │   └──────────────┐
      │   └──────┐           │
      ▼          ▼           ▼
  ┌────────┐ ┌─────────┐ ┌──────────┐
  │2 PROD- │ │3 RESEAR-│ │4 WATCH-  │
  │ UCERS  │ │ CHERS   │ │  DOG     │
  ├────────┤ ├─────────┤ ├──────────┤
  │architect│ │ scout  │ │every 15m │
  │writer   │ │ analyst│ │health    │
  │critic   │ │        │ │daily deep│
  └────────┘ └─────────┘ └──────────┘
                  ▲            │
              daily 07:37   emails you
                            when broken
```

Teams are wired to the hub over **HTTP webhooks**, not sub-workflow nodes. That
costs one hop, and buys three things: each team is independently testable with
`curl`, the watchdog can probe the same endpoints the hub uses, and teams can
later move to a different n8n instance without touching the hub.

## Files

| File | What it is |
|---|---|
| `1-jarvis-hub.json` | The assistant. Webhook in, three team tools, spoken reply out. |
| `2-producers.json` | Architect → writer → critic. Builds new agents. |
| `3-researchers.json` | Scout → analyst. Scheduled daily plus on demand. |
| `4-watchdog.json` | Health team. 15-minute shallow check, daily deep probe. |
| `../jarvis/index.html` | The voice interface. Static, no build step, no dependencies. |

---

## Setup

### 1. Get n8n running

Cloud (`n8n.io`, free trial) or self-hosted:

```bash
docker run -d --name n8n -p 5678:5678 \
  -e N8N_HOST=your-domain.com \
  -e WEBHOOK_URL=https://your-domain.com/ \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

Self-hosting needs **HTTPS with a real certificate**. The browser will not grant
microphone access to an insecure origin, and the Jarvis page calls your webhook
from that origin. Put it behind Caddy, Traefik, or a Cloudflare tunnel.

### 2. Add credentials

In **Credentials → Add**:

- **OpenAI** — your API key. Used by all six agents.
- **Header Auth**, name it `n8n API key` — header name `X-N8N-API-KEY`, value from
  Settings → n8n API → Create an API key. The watchdog needs this.
- **Gmail OAuth2** — optional, only for watchdog alert emails.

### 3. Import the workflows

**Workflows → Import from File**, one at a time, in order: 4, 3, 2, 1. Import the
watchdog first so the endpoints exist before anything points at them.

### 4. Replace the placeholders

Search each imported workflow for these and fix them:

| Placeholder | Where | Replace with |
|---|---|---|
| `YOUR-N8N-HOST` | workflows 1 and 4 | your n8n hostname, no trailing slash |
| `REPLACE_WITH_YOUR_CREDENTIAL_ID` | every OpenAI node | pick your OpenAI credential from the dropdown |
| `REPLACE_WITH_N8N_API_CREDENTIAL_ID` | workflow 4, two HTTP nodes | your Header Auth credential |
| `REPLACE_WITH_GMAIL_CREDENTIAL_ID` | workflow 4, Email Me | your Gmail credential |
| `REPLACE_WITH_YOUR_EMAIL` | workflow 4, Email Me | your address |

The credential IDs are easier to fix in the UI than in the JSON — open each node
and choose from the dropdown.

### 5. Turn on CORS

The browser calls n8n from a different origin, so without this every request
fails with an opaque "Failed to fetch" while the n8n execution log shows success.

In workflow 1, open the **Voice In** node → **Options** → **Add Option** →
**Allowed Origins (CORS)**. Set it to your Vercel domain, or `*` while testing.

### 6. Activate

Toggle **Active** on all four. Then copy the **Production URL** from the Voice In
node of workflow 1 — that's what the interface needs.

The Test URL is not the same thing. It accepts exactly one call after you press
"Execute workflow", then stops. Almost every "it worked once and then died" report
is this.

### 7. Deploy the interface

It's already in this repo at `jarvis/index.html` and `vercel.json` routes
`/jarvis` to it. Push, and it's live at `your-vercel-domain.com/jarvis`.

Open it, press **CONFIG**, paste the production webhook URL, save.

### 8. Verify

```bash
# each team, independently
curl -X POST https://YOUR-N8N-HOST/webhook/producers \
  -H 'Content-Type: application/json' \
  -d '{"request":"an agent that flags KM log entries with impossible distances"}'

curl -X POST https://YOUR-N8N-HOST/webhook/researchers \
  -H 'Content-Type: application/json' -d '{"topic":"sweep"}'

curl https://YOUR-N8N-HOST/webhook/watchdog-status

# the hub, which should route to one of them
curl -X POST https://YOUR-N8N-HOST/webhook/jarvis \
  -H 'Content-Type: application/json' \
  -d '{"message":"is everything working?","sessionId":"test"}'
```

Then open `/jarvis` and say *"is everything working?"* out loud. If the orb goes
cyan → amber → green and you hear a reply, the whole chain is up.

---

## The watchdog, and why it has two speeds

You asked for a team that continuously checks everything works. It does, but not
by brute force.

**Shallow, every 15 minutes.** Asks the n8n API which workflows are active and
whether anything errored since the last check. Zero LLM calls, so it costs
nothing to run constantly.

**Deep, once a day at 06:23.** Actually calls all three teams with a canary
message and checks they return real content.

The split is deliberate. A deep probe every 15 minutes would fire three GPT-4o
agents 96 times a day just to confirm they still answer — the monitoring would
cost more than the work. It also treats an HTTP 200 with an empty body as a
failure, because that's the way these break most often.

Alerts stop after three consecutive failures so a broken weekend doesn't produce
200 emails.

Asking Jarvis *"is everything working?"* reads the stored verdict rather than
probing live, so it answers instantly and free. If the stored verdict is stale it
says so instead of pretending it's current.

---

## Swapping the model

Every agent has its own LLM node, so you can mix providers.

**Gemini:** delete the OpenAI node, add **Google Gemini Chat Model**
(`lmChatGoogleGemini`), connect it to the agent's **Chat Model** input.

**Local / free — Ollama:** add **Ollama Chat Model**, base URL
`http://host.docker.internal:11434` if n8n is in Docker. Use a model with real
tool-calling support — `qwen2.5:14b` or `llama3.1:8b`. Smaller models will call
tools incoherently and the agents will misbehave in ways that look like prompt
bugs.

Cheapest sensible mix: `gpt-4o-mini` for scout and the watchdog paths, `gpt-4o`
for architect, writer, critic, and the hub. Judgment quality matters in those
four and nowhere else.

---

## Browser support for voice

| Browser | Speech in | Speech out |
|---|---|---|
| Chrome desktop | yes | yes |
| Edge desktop | yes | yes |
| Chrome Android | yes | yes |
| Safari macOS / iOS | partial, unreliable | yes |
| Firefox | **no** | yes |

Firefox has no `SpeechRecognition`. The page detects this, says so, and falls back
to the text box. Chrome's recognition is a cloud service — audio goes to Google's
servers for transcription. Speech synthesis is local.

`auto-listen` re-arms the mic after each reply. It deliberately will not restart
while Jarvis is speaking, or it transcribes its own voice and talks to itself.

---

## When it doesn't work

| Symptom | Cause |
|---|---|
| "Failed to fetch", but n8n shows success | CORS. Step 5. |
| Worked once, then 404 | You used the Test URL, not the Production URL. |
| 404 on every call | Workflow isn't Active. |
| Mic button does nothing | Not HTTPS, or permission denied. Check the address bar. |
| Agent replies with markdown asterisks read aloud | Its system message got edited — the no-markdown rule is what keeps output speakable. |
| Watchdog says it can't reach the API | `YOUR-N8N-HOST` still unreplaced, or the API key credential is wrong. |
| Everything times out after 2 minutes | A team is genuinely slow. Raise the `timeout` in the tool nodes; researchers can take 90s+ on a real sweep. |

---

## Cost

Rough, at gpt-4o pricing, assuming a handful of conversational turns a day:

- Hub turn with no tool call: a fraction of a cent
- Hub turn that calls a team: 2–6 cents
- Full producers build: 5–15 cents
- Daily research sweep: 10–30 cents depending on how much the scout fetches
- Watchdog shallow checks: free
- Watchdog daily deep probe: ~5 cents

The daily sweep is the recurring floor — call it a few dollars a month. If that's
too much, move the scout to `gpt-4o-mini` and change the schedule from weekdays
to Mondays.
