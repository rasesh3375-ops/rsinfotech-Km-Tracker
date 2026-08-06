#!/usr/bin/env node
/**
 * Toggle Claude Code between Anthropic and a local OmniRoute gateway.
 *
 *   node scripts/claude-omniroute.js status
 *   node scripts/claude-omniroute.js on [model]
 *   node scripts/claude-omniroute.js off
 *
 * Writes to .claude/settings.local.json, which is gitignored and machine-local.
 * Deliberately NOT .claude/settings.json — that file is committed, and pointing
 * it at localhost:20128 would break Claude Code for every clone of this repo and
 * in every environment where the gateway isn't running.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = resolve(ROOT, '.claude/settings.local.json');

// Claude Code appends /v1/messages itself, so the base URL must NOT carry /v1.
const DEFAULT_BASE = process.env.OMNIROUTE_BASE || 'http://localhost:20128';
const DEFAULT_MODEL = 'auto';
const KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'
];

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  amber: s => `\x1b[33m${s}\x1b[0m`
};

function load() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    console.error(`${C.red('Refusing to touch')} ${SETTINGS}\nIt is not valid JSON: ${err.message}`);
    console.error('A malformed settings file silently disables every setting in it. Fix it first.');
    process.exit(1);
  }
}

function save(obj) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}

async function gatewayUp(base) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(`${base}/v1/models`, { signal: ctl.signal });
    return res.ok || res.status === 401; // 401 still proves it answered
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const settings = load();
const env = settings.env || {};
const active = Boolean(env.ANTHROPIC_BASE_URL);

if (cmd === 'on') {
  const model = process.argv[3] || DEFAULT_MODEL;
  const token = process.env.OMNIROUTE_API_KEY || 'omniroute-local';

  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: DEFAULT_BASE,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1'
  };
  save(settings);

  console.log(`\n${C.green('ON')} — Claude Code will use OmniRoute in this project.`);
  console.log(`  base   ${DEFAULT_BASE}   ${C.dim('(no /v1 — Claude Code appends /v1/messages)')}`);
  console.log(`  model  ${model}`);
  console.log(`  token  ${token === 'omniroute-local' ? C.dim('placeholder (set OMNIROUTE_API_KEY for a real one)') : C.dim('from OMNIROUTE_API_KEY')}`);
  console.log(`  file   ${C.dim(SETTINGS)}`);

  if (!(await gatewayUp(DEFAULT_BASE))) {
    console.log(`\n${C.red('The gateway is not answering.')} Start it before restarting Claude Code:`);
    console.log(`  ${C.cyan('npm install -g omniroute && omniroute')}`);
    console.log(`Otherwise every request will fail. Undo with: ${C.cyan('npm run claude:anthropic')}`);
  }
  console.log(`\n${C.amber('Restart Claude Code.')} Env vars are read once at startup.\n`);

} else if (cmd === 'off') {
  if (!active) {
    console.log(`\n${C.dim('Already off — no OmniRoute settings present.')}\n`);
    process.exit(0);
  }
  for (const k of KEYS) delete env[k];
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  save(settings);

  console.log(`\n${C.green('OFF')} — Claude Code is back on Anthropic.`);
  console.log(`Other settings in the file were left alone.`);
  console.log(`\n${C.amber('Restart Claude Code.')}\n`);

} else if (cmd === 'status') {
  const up = await gatewayUp(DEFAULT_BASE);
  console.log(`\n  routing   ${active ? C.cyan('OmniRoute') : C.green('Anthropic (default)')}`);
  if (active) {
    console.log(`  base      ${env.ANTHROPIC_BASE_URL}`);
    console.log(`  model     ${env.ANTHROPIC_MODEL || C.dim('(unset)')}`);
  }
  console.log(`  gateway   ${up ? C.green('running') : C.red('not running')} ${C.dim(`at ${DEFAULT_BASE}`)}`);
  console.log(`  settings  ${existsSync(SETTINGS) ? SETTINGS : C.dim('none yet')}`);

  if (active && !up) {
    console.log(`\n${C.red('Broken combination.')} Claude Code is pointed at a gateway that is not running.`);
    console.log(`Start it with ${C.cyan('omniroute')}, or run ${C.cyan('npm run claude:anthropic')} to switch back.`);
  }
  console.log();

} else {
  console.log(`\nUsage:\n  node scripts/claude-omniroute.js status\n  node scripts/claude-omniroute.js on [model]\n  node scripts/claude-omniroute.js off\n`);
  process.exit(1);
}
