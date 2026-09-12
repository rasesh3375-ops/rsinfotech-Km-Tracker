// Every backend call must be able to use the retries it asks for.
//
// apiFetch takes a total budget and a per-attempt cap, and it refuses to open
// an attempt it has no time to finish:
//
//     if(i > 0 && remaining < 1000) break;
//
// So a budget that is not comfortably larger than the per-attempt cap buys
// exactly ONE attempt, however many `tries` the caller asked for. The retry
// exists because the Apps Script web app intermittently serves a Google Drive
// HTML error page instead of running — measured at roughly half of requests
// during one bad spell — so losing it is not theoretical.
//
// This has now been found FOUR times, by HR, in production, each time as a
// different screen failing:
//
//   1. login          — 9000 budget / 8000 attempt
//   2. single-key reads — same
//   3. writes          — same, reported as "Could not save"
//   4. attendance reads — same, reported as "Fetch is aborted" on the April
//      2026 Salary Sheet, three times running, while HR was mid-payroll
//
// Each fix raised the numbers at one call site and left the others. Nothing
// caught the next one because there is nothing wrong with the code locally —
// it reads perfectly well, and the starvation only shows up when you compare
// two constants that sit far apart in the file.
//
// So it is checked statically here. The rule: for any budget/attempt pair the
// app defines, the budget must leave room for at least two full attempts plus
// backoff, or the second try cannot run.
//
//   node tools/check-fetch-budgets.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// A constant's value, whether it is written as a literal or derived from other
// constants (BACKEND_BUDGET_MS is deliberately BACKEND_ATTEMPT_MS * 3 + ...,
// so that `tries: 3` keeps meaning three if anyone changes the cap). Resolves
// names recursively and evaluates only digits, the four operators, brackets
// and spaces — never arbitrary source.
const seen = new Set();
const num = name => {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*([^;\\n]+);').exec(src);
  if (!m) return null;
  let expr = m[1].trim();
  if (/^\d+$/.test(expr)) return Number(expr);
  if (seen.has(name)) return null;          // a cycle; report as unreadable
  seen.add(name);
  expr = expr.replace(/[A-Z_][A-Z0-9_]*/g, ref => {
    const v = num(ref);
    return v === null ? 'NaN' : String(v);
  });
  seen.delete(name);
  if (!/^[\d+\-*/(). ]+$/.test(expr)) return null;
  const v = Function('"use strict";return (' + expr + ')')();
  return Number.isFinite(v) ? v : null;
};

// Every budget/attempt pair in the app, by the names they are declared under.
// The third entry is how many attempts that pair is actually asked for — the
// budget only has to fit that many. Login deliberately asks for fewer than the
// rest: every login attempt that reaches the backend creates a session row
// whether or not the browser is still listening, so a retry there has a real
// cost the others do not have.
const PAIRS = [
  ['BACKEND_BUDGET_MS',  'BACKEND_ATTEMPT_MS',  3, 'the default every uncustomised backendAction call gets'],
  ['READ_BUDGET_MS',     'READ_ATTEMPT_MS',     2, 'safeGetOrThrow_, one key at a time'],
  ['WRITE_BUDGET_MS',    'WRITE_ATTEMPT_MS',    2, 'every write, including attendance saves'],
  ['LOGIN_BUDGET_MS',    'LOGIN_ATTEMPT_MS',    2, 'signing in — LOGIN_TRIES attempts, each one creates a session'],
  ['ATT_READ_BUDGET_MS', 'ATT_READ_ATTEMPT_MS', 2, 'reading attendance for the whole roster'],
];

// apiFetch's own refusal threshold, and its backoff between attempts. Read out
// of the source rather than hard-coded, so changing either there fails here
// instead of silently moving the goalposts.
const MIN_REMAINING = (/remaining\s*<\s*(\d+)/.exec(src) || [])[1];
const BACKOFF = num('BACKEND_BACKOFF_MS');

let failed = 0;
if (!MIN_REMAINING) {
  console.log('  FAIL  could not find apiFetch\'s "remaining < N" guard — has apiFetch changed?');
  failed++;
}
if (!BACKOFF) {
  console.log('  FAIL  could not find BACKEND_BACKOFF_MS');
  failed++;
}

PAIRS.forEach(([bName, aName, wantAttempts, what]) => {
  const budget = num(bName), attempt = num(aName);
  if (budget === null || attempt === null) {
    console.log('  FAIL  ' + bName + ' / ' + aName + ' — not found. Renamed, or the pair was removed?');
    failed++;
    return;
  }
  // Enough for the attempts this pair is actually asked for, and the backoff
  // between them, with enough left over that apiFetch will open the last one.
  const needed = attempt * wantAttempts + Number(BACKOFF || 0) * (wantAttempts - 1);
  if (budget < needed) {
    console.log('  FAIL  ' + bName + ' (' + budget + 'ms) leaves no room for ' + wantAttempts +
                ' attempts of ' + aName + ' (' + attempt + 'ms)');
    console.log('         ' + what);
    console.log('         needs at least ' + needed + 'ms; apiFetch will not open an attempt ' +
                'with under ' + MIN_REMAINING + 'ms left.');
    console.log('         As written the caller gets fewer tries than it asks for.');
    failed++;
  } else {
    const fits = Math.floor((budget + Number(BACKOFF || 0)) / (attempt + Number(BACKOFF || 0)));
    console.log('  ok    ' + bName.replace('_BUDGET_MS', '').padEnd(9) + ' ' +
                budget + 'ms / ' + attempt + 'ms — ' + fits + ' attempts fit  (' + what + ')');
  }
});

// Login must ask for LOGIN_TRIES, not a hardcoded number. Passing 3 here again
// would silently reinstate the session churn this exists to stop.
if (!/\}, LOGIN_TRIES, LOGIN_BUDGET_MS, LOGIN_ATTEMPT_MS\)/.test(src)) {
  console.log('  FAIL  serverLogin does not pass LOGIN_TRIES — a hardcoded try count there');
  console.log('         means every extra attempt leaves another session row behind.');
  failed++;
} else {
  console.log('  ok    serverLogin asks for LOGIN_TRIES, not a hardcoded count');
}

// Every attendance read goes through backendAction, and backendAction falls
// back to the 9s default when a caller passes no options. These three are the
// heaviest reads in the app and must ask for their own budget by name.
const ATT_CALLS = [
  /backendAction\(\{\s*action:\s*'getAttendanceRange'[^)]*\},\s*ATT_READ_OPTS\)/,
  /backendAction\(\{\s*action:\s*'getAttendanceAll',\s*ids\s*\},\s*ATT_READ_OPTS\)/,
  /backendAction\(\{\s*action:\s*'getAttendanceAll',\s*ids:\s*\[employeeId\]\s*\},\s*ATT_READ_OPTS\)/,
];
ATT_CALLS.forEach((re, i) => {
  if (!re.test(src)) {
    console.log('  FAIL  attendance read #' + (i + 1) +
                ' does not pass ATT_READ_OPTS — it falls back to the 9s default,');
    console.log('         which is what made the April 2026 Salary Sheet fail three times running.');
    failed++;
  }
});
if (!failed) console.log('  ok    all three attendance reads ask for their own budget');

if (failed) {
  console.log('\n' + failed + ' backend call(s) cannot use the retries they ask for. See the top of this file.');
  process.exit(1);
}
console.log('\nPASS');
