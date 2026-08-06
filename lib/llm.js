/**
 * Provider-agnostic LLM layer.
 *
 * Every provider here speaks the OpenAI chat-completions wire format, so there
 * is exactly one code path. Switching provider is one environment variable.
 *
 * All four options below are free. Groq and Gemini need no credit card; Ollama
 * needs no account at all.
 */

export const PROVIDERS = {
  // Local MIT gateway (github.com/diegosouzapw/OmniRoute) that fans one endpoint
  // out to 290+ providers, 90+ of them free. The `auto` model routes to keyless
  // free providers, so this is the only option here needing no signup at all.
  //
  //   npm install -g omniroute && omniroute
  //
  // A key is optional: set OMNIROUTE_API_KEY only if you generated one in its
  // dashboard. Without it, `auto` still works.
  omniroute: {
    baseUrl: process.env.OMNIROUTE_URL || 'http://localhost:20128/v1',
    keyEnv: null,
    optionalKeyEnv: 'OMNIROUTE_API_KEY',
    local: true,
    fast: 'auto',
    smart: 'auto',
    signup: 'https://github.com/diegosouzapw/OmniRoute'
  },

  // 30 req/min, 14,400 req/day, every model, no card. Fast enough that a
  // three-agent chain finishes inside a serverless timeout.
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    fast: 'llama-3.1-8b-instant',
    smart: 'llama-3.3-70b-versatile',
    signup: 'https://console.groq.com/keys'
  },

  // Google's OpenAI-compatibility shim. Generous free tier, no card.
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    fast: 'gemini-2.0-flash',
    smart: 'gemini-2.0-flash',
    signup: 'https://aistudio.google.com/apikey'
  },

  // Fully local, fully private, genuinely unlimited. Needs your machine on.
  // Use a model with real tool-calling support or the agents misbehave in ways
  // that look like prompt bugs.
  ollama: {
    baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434/v1',
    keyEnv: null,
    fast: 'llama3.1:8b',
    smart: 'qwen2.5:14b',
    signup: 'https://ollama.com/download'
  },

  // Aggregator. Models suffixed :free cost nothing.
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    fast: 'meta-llama/llama-3.3-70b-instruct:free',
    smart: 'meta-llama/llama-3.3-70b-instruct:free',
    signup: 'https://openrouter.ai/keys'
  }
};

export const PROVIDER = process.env.LLM_PROVIDER || 'groq';

export function providerConfig() {
  const p = PROVIDERS[PROVIDER];
  if (!p) {
    throw new Error(
      `Unknown LLM_PROVIDER "${PROVIDER}". Valid: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  if (p.keyEnv && !process.env[p.keyEnv]) {
    throw new Error(
      `${p.keyEnv} is not set. Get a free key at ${p.signup}, then add it as an ` +
      `environment variable.`
    );
  }
  return p;
}

/** One chat-completions call. Retries on rate limit, since free tiers hit it. */
export async function chat({ messages, tools, model, temperature = 0.4, signal }) {
  const p = providerConfig();
  const url = `${p.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  const key = p.keyEnv ? process.env[p.keyEnv]
            : p.optionalKeyEnv ? process.env[p.optionalKeyEnv]
            : null;
  if (key) headers.Authorization = `Bearer ${key}`;

  // Asked for explicitly: some gateways stream by default, and this client wants
  // one complete message. Not every gateway honours it, which is why the
  // response parser below copes with a stream anyway.
  const body = { model: model || p.smart, messages, temperature, stream: false };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
      // A refused connection to a local gateway means it simply isn't running.
      // Say that, rather than surfacing "fetch failed" and sending the user hunting.
      if (p.local) {
        throw new Error(
          `Cannot reach ${PROVIDER} at ${p.baseUrl}. Start it first — ` +
          `\`npm install -g omniroute && omniroute\` — or set OMNIROUTE_URL if ` +
          `it runs elsewhere. (${err.message})`
        );
      }
      throw err;
    }

    if (res.status === 429 || res.status >= 500) {
      // Free tiers rate-limit aggressively. Back off rather than failing the turn.
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1200 * (attempt + 1);
      lastErr = new Error(`${PROVIDER} returned ${res.status}`);
      if (attempt < 2) { await sleep(Math.min(wait, 8000)); continue; }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${PROVIDER} ${res.status}: ${text.slice(0, 300)}`);
    }

    return parseCompletion(await res.text(), res.headers.get('content-type') || '');
  }
  throw lastErr || new Error(`${PROVIDER} failed after retries`);
}

/**
 * Reads a completion that may arrive as plain JSON or as an SSE stream.
 *
 * OmniRoute answers with text/event-stream even when the request sets
 * stream:false, so assuming JSON made every call fail with
 * `Unexpected token 'd'` — the 'd' of "data:". Reassembling the frames is
 * cheap and makes this work against both shapes rather than betting on one.
 */
function parseCompletion(raw, contentType) {
  const isStream = contentType.includes('text/event-stream') || /^\s*data:/.test(raw);

  if (!isStream) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`${PROVIDER} returned a body that is neither JSON nor SSE: ${raw.slice(0, 200)}`);
    }
    const choice = json.choices?.[0];
    if (!choice) throw new Error(`${PROVIDER} returned no choices`);
    return choice.message;
  }

  let content = '';
  let role = 'assistant';
  const toolCalls = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let frame;
    try { frame = JSON.parse(payload); } catch { continue; } // ignore keep-alives
    const choice = frame.choices?.[0];
    if (!choice) continue;

    // Some gateways send whole messages inside the stream instead of deltas.
    const part = choice.delta || choice.message;
    if (!part) continue;
    if (part.role) role = part.role;
    if (part.content) content += part.content;
    if (part.tool_calls) part.tool_calls.forEach(tc => mergeToolCall(toolCalls, tc));
  }

  const message = { role, content };
  const merged = toolCalls.filter(Boolean);
  if (merged.length) message.tool_calls = merged;
  return message;
}

/** Tool calls stream in fragments — arguments arrive a few characters at a
 *  time and are keyed by index, so they have to be stitched back together. */
function mergeToolCall(acc, frag) {
  const i = frag.index ?? acc.length;
  if (!acc[i]) acc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
  const slot = acc[i];
  if (frag.id) slot.id = frag.id;
  if (frag.type) slot.type = frag.type;
  if (frag.function?.name) slot.function.name += frag.function.name;
  if (frag.function?.arguments) slot.function.arguments += frag.function.arguments;
}

/**
 * Runs one agent to completion, executing any tools it calls.
 *
 * Returns { text, steps, toolsUsed }. Stops at maxSteps rather than looping
 * forever — an agent that cannot finish in six tool calls is stuck, and letting
 * it spin burns the daily request quota.
 */
export async function runAgent({
  system,
  user,
  tools = [],
  model,
  temperature = 0.4,
  maxSteps = 6,
  signal
}) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
  const schemas = tools.map(t => t.schema);
  const byName = Object.fromEntries(tools.map(t => [t.schema.function.name, t]));
  const toolsUsed = [];

  for (let step = 0; step < maxSteps; step++) {
    const msg = await chat({ messages, tools: schemas, model, temperature, signal });
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { text: msg.content || '', steps: step + 1, toolsUsed };
    }

    // Run this step's tool calls in parallel — they are independent by construction.
    const results = await Promise.all(calls.map(async call => {
      const tool = byName[call.function.name];
      toolsUsed.push(call.function.name);
      if (!tool) {
        return { id: call.id, out: `No such tool: ${call.function.name}` };
      }
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        const out = await tool.run(args, { signal });
        return { id: call.id, out: typeof out === 'string' ? out : JSON.stringify(out) };
      } catch (err) {
        // Hand the failure back to the model rather than throwing. It can often
        // recover by trying different arguments, and a thrown error loses the turn.
        return { id: call.id, out: `Tool failed: ${err.message}` };
      }
    }));

    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.out.slice(0, 12000) });
    }
  }

  return {
    text: '(stopped after the maximum number of tool calls without finishing)',
    steps: maxSteps,
    toolsUsed
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
