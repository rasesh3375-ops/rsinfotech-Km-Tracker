/**
 * The whole agent org, one serverless endpoint.
 *
 *   POST /api/agent                       → hub  { message, sessionId }
 *   POST /api/agent?team=producers        → { request }
 *   POST /api/agent?team=researchers      → { topic }
 *   GET  /api/agent?team=watchdog         → health, no LLM calls
 *   GET  /api/agent?team=ping             → liveness, no LLM calls, no network
 *
 * One function rather than four keeps cold starts down and the deploy simple.
 */

import { runHub, runProducers, runResearchers, runWatchdog } from '../lib/teams.js';
import { PROVIDER } from '../lib/llm.js';

// Hobby plan allows up to 60s. The producers chain is three sequential model
// calls, which is why this needs the full budget rather than the 10s default.
export const config = { maxDuration: 60 };

const ALLOWED = process.env.ALLOWED_ORIGIN || '*';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const team = (req.query?.team || 'hub').toString();

  // Liveness. No model, no network, no quota — safe to poll as often as you like.
  if (team === 'ping') {
    return res.status(200).json({ ok: true, provider: PROVIDER, ts: new Date().toISOString() });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    switch (team) {
      case 'watchdog': {
        const out = await runWatchdog({});
        // Non-200 when unhealthy so a monitor can act on the status code alone.
        return res.status(out.healthy ? 200 : 503).json(out);
      }

      case 'producers': {
        if (!body.request) return res.status(400).json({ error: 'Body needs { request }' });
        return res.status(200).json(await runProducers({ request: body.request }));
      }

      case 'researchers': {
        return res.status(200).json(await runResearchers({ topic: body.topic || 'sweep' }));
      }

      case 'hub': {
        if (!body.message) return res.status(400).json({ error: 'Body needs { message }' });
        const out = await runHub({ message: body.message, sessionId: body.sessionId });
        return res.status(200).json({ reply: out.reply, toolsUsed: out.toolsUsed, ts: new Date().toISOString() });
      }

      default:
        return res.status(400).json({ error: `Unknown team "${team}"` });
    }
  } catch (err) {
    // Surface the real message — a misconfigured key is the most likely failure
    // and "internal error" would send the user hunting for nothing.
    return res.status(500).json({
      error: err.message,
      reply: `Something went wrong. ${err.message}`
    });
  }
}
