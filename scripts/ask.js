#!/usr/bin/env node
/**
 * Talk to the agent org from a terminal. No hosting, no deploy, no account
 * beyond one free API key.
 *
 *   npm run ask                          interactive
 *   npm run ask -- "what's new?"         one shot
 *   npm run ask -- --team watchdog       health check, no LLM calls
 *   npm run ask -- --team researchers --topic "agent memory"
 *   npm run ask -- --team producers --request "an agent that ..."
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runHub, runProducers, runResearchers, runWatchdog } from '../lib/teams.js';
import { PROVIDER, PROVIDERS, providerConfig } from '../lib/llm.js';

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  amber: s => `\x1b[33m${s}\x1b[0m`
};

// ------------------------------------------------------------------ arg parse
const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const team = flag('team') || 'hub';
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))
).join(' ');

// The watchdog needs no key, so check configuration only for the rest.
if (team !== 'watchdog') {
  try {
    providerConfig();
  } catch (err) {
    console.error(`\n${C.red('Not configured.')} ${err.message}\n`);
    console.error('Free options, none of which need a credit card:\n');
    for (const [name, p] of Object.entries(PROVIDERS)) {
      console.error(`  ${C.cyan(name.padEnd(11))} ${p.signup}`);
    }
    console.error(`\nThen:  export ${PROVIDERS[PROVIDER]?.keyEnv || 'GROQ_API_KEY'}=your-key`);
    console.error(`Or pick another:  export LLM_PROVIDER=gemini\n`);
    process.exit(1);
  }
}

// --------------------------------------------------------------- team runners
async function runOnce(text) {
  const t = Date.now();
  switch (team) {
    case 'watchdog': {
      const r = await runWatchdog({});
      console.log(r.healthy ? C.green('\n● healthy') : C.red('\n● unhealthy'));
      for (const c of r.checks) {
        console.log(`  ${c.ok ? C.green('✓') : C.red('✗')} ${c.check.padEnd(14)} ${C.dim(c.detail)}`);
      }
      console.log(`\n${r.spoken}\n`);
      return;
    }
    case 'producers': {
      const request = flag('request') || text;
      if (!request) return console.error(C.red('Need --request "..."'));
      const r = await runProducers({ request });
      console.log(`\n${C.cyan('── SPEC ──')}\n${r.spec}`);
      console.log(`\n${C.cyan('── DEFINITION ──')}\n${r.definition}`);
      console.log(`\n${C.cyan('── REVIEW ──')}\n${r.review}`);
      console.log(`\n${r.shipIt ? C.green(r.spoken) : C.amber(r.spoken)}`);
      break;
    }
    case 'researchers': {
      const r = await runResearchers({ topic: flag('topic') || text || 'sweep' });
      console.log(`\n${C.cyan('── FINDINGS ──')}\n${r.findings}`);
      console.log(`\n${C.cyan('── ANALYSIS ──')}\n${r.analysis}`);
      console.log(`\n${C.dim('sources used: ' + (r.sourcesUsed.join(', ') || 'none'))}`);
      break;
    }
    default: {
      const r = await runHub({ message: text, sessionId: 'cli' });
      console.log(`\n${r.reply}`);
      if (r.toolsUsed.length) console.log(C.dim(`\n[called: ${r.toolsUsed.join(', ')}]`));
    }
  }
  console.log(C.dim(`\n${((Date.now() - t) / 1000).toFixed(1)}s · ${PROVIDER}\n`));
}

// ---------------------------------------------------------------------- main
if (positional || team !== 'hub') {
  try {
    await runOnce(positional);
  } catch (err) {
    console.error(`\n${C.red('Failed:')} ${err.message}\n`);
    process.exit(1);
  }
} else {
  console.log(`\n${C.cyan('Agent org')} ${C.dim(`· ${PROVIDER} · Ctrl-C to quit`)}\n`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  for (;;) {
    const line = (await rl.question(C.cyan('you › '))).trim();
    if (!line) continue;
    if (/^(exit|quit|bye)$/i.test(line)) break;
    try {
      const r = await runHub({ message: line, sessionId: 'cli' });
      console.log(`\n${r.reply}\n`);
      if (r.toolsUsed.length) console.log(C.dim(`[called: ${r.toolsUsed.join(', ')}]\n`));
    } catch (err) {
      console.error(`${C.red('error:')} ${err.message}\n`);
    }
  }
  rl.close();
}
