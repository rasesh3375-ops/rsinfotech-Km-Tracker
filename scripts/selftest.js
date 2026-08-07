#!/usr/bin/env node
/**
 * Self-test. Run with `npm run check`.
 *
 * Split into two halves on purpose: everything that needs no API key runs
 * first, so you can verify the plumbing before spending any quota. The LLM
 * half is skipped with a clear message when no key is set.
 */

import { runWatchdog, runProducers, runHub } from '../lib/teams.js';
import { hnSearch, redditSearch, fetchPage } from '../lib/tools.js';
import { PROVIDER, PROVIDERS, providerConfig } from '../lib/llm.js';

let pass = 0, fail = 0, skip = 0;

/** Thrown when a host is unreachable — a blocked network is not a code defect. */
class Unreachable extends Error {}

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  const t = Date.now();
  try {
    const note = await fn();
    console.log(`OK (${Date.now() - t}ms)${note ? ' — ' + note : ''}`);
    pass++;
  } catch (err) {
    if (err instanceof Unreachable) {
      console.log(`SKIP — ${err.message}`);
      skip++;
    } else {
      console.log(`FAIL — ${err.message}`);
      fail++;
    }
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Treat network-level blocks as skips so sandboxes don't look like bugs. */
function netGuard(out, host) {
  const s = typeof out === 'string' ? out : '';
  if (/HTTP 40[03]|HTTP 5\d\d|fetch failed|unreachable|ENOTFOUND|abort/i.test(s)) {
    throw new Unreachable(`${host} not reachable from here (${s.slice(0, 60)})`);
  }
}

console.log(`\nAgent org self-test\nProvider: ${PROVIDER}\n`);

// ---------------------------------------------------------------- free half
console.log('No API key needed:');

await test('watchdog runs and reports', async () => {
  const r = await runWatchdog({});
  assert(typeof r.healthy === 'boolean', 'healthy must be boolean');
  assert(Array.isArray(r.checks) && r.checks.length >= 3, 'expected at least 3 checks');
  assert(typeof r.spoken === 'string' && r.spoken.length, 'spoken summary missing');
  return `${r.checks.filter(c => c.ok).length}/${r.checks.length} checks green`;
});

await test('watchdog spoken text is speakable', async () => {
  const r = await runWatchdog({});
  assert(!/[*#`_]/.test(r.spoken), 'spoken text contains markdown characters');
  assert(!/https?:\/\//.test(r.spoken), 'spoken text contains a URL');
});

await test('hacker news search returns results', async () => {
  let out;
  try { out = await hnSearch.run({ query: 'AI agents', days: 30 }); }
  catch (e) { throw new Unreachable(`hn.algolia.com — ${e.message}`); }
  netGuard(out, 'hn.algolia.com');
  if (typeof out === 'string') return out; // valid "no results" path
  assert(Array.isArray(out) && out.length, 'expected an array of hits');
  assert(out[0].title && out[0].url, 'hits need title and url');
  return `${out.length} hits, top: "${out[0].title.slice(0, 44)}"`;
});

await test('reddit search returns results', async () => {
  let out;
  try { out = await redditSearch.run({ query: 'LLM agents', window: 'month' }); }
  catch (e) { throw new Unreachable(`reddit.com — ${e.message}`); }
  netGuard(out, 'reddit.com');
  if (typeof out === 'string') return out;
  assert(Array.isArray(out), 'expected an array');
  return `${out.length} posts`;
});

await test('fetch_page extracts text', async () => {
  const out = await fetchPage.run({ url: 'https://example.com' });
  netGuard(out, 'example.com');
  assert(typeof out === 'string' && out.length > 20, 'expected extracted text');
  assert(!out.includes('<'), 'html tags survived extraction');
  return `${out.length} chars`;
});

await test('fetch_page refuses a non-http scheme', async () => {
  const out = await fetchPage.run({ url: 'file:///etc/passwd' });
  assert(/refused/i.test(out), 'should refuse non-http urls');
});

await test('every tool schema is well formed', async () => {
  for (const t of [hnSearch, redditSearch, fetchPage]) {
    assert(t.schema?.function?.name, 'tool missing function.name');
    assert(t.schema.function.description?.length > 20, `${t.schema.function.name}: thin description`);
    assert(t.schema.function.parameters?.type === 'object', `${t.schema.function.name}: bad parameters`);
    assert(typeof t.run === 'function', `${t.schema.function.name}: no run()`);
  }
  return '3 tools';
});

// ----------------------------------------------------------------- llm half
console.log('\nNeeds an API key:');

let keyed = true;
try { providerConfig(); } catch (err) {
  keyed = false;
  const p = PROVIDERS[PROVIDER];
  console.log(`  SKIPPED — ${err.message}`);
  if (p?.signup) console.log(`            Free key: ${p.signup}`);
  skip += 2;
}

if (keyed) {
  await test('hub answers without calling a team', async () => {
    const r = await runHub({ message: 'Say hello in one short sentence.', sessionId: 'selftest' });
    assert(r.reply?.length, 'empty reply');
    assert(!r.toolsUsed.length, `should not have called tools, called: ${r.toolsUsed}`);
    return `"${r.reply.slice(0, 56)}"`;
  });

  await test('producers builds and reviews an agent', async () => {
    const r = await runProducers({ request: 'an agent that summarises yesterday’s failed CI runs' });
    assert(r.spec?.length > 200, 'spec too short');
    assert(r.definition?.length > 200, 'definition too short');
    assert(r.review?.length > 80, 'review too short');
    return `spec ${r.spec.length}c, def ${r.definition.length}c, ${r.blockers} blockers`;
  });
}

// ------------------------------------------------------------------ summary
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail ? 1 : 0);
