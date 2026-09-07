// The scheduled emails, and the one trap that makes them all misfire.
//
// Apps Script calls a time-based trigger's function with an EVENT OBJECT as the
// first argument — {authMode, triggerUid, year, month, day-of-month, hour, ...}
// — and that object is truthy. Every one of these functions takes `force`, so a
// gate written as `!force` is skipped on every firing, and a monthly email goes
// out daily. That is exactly what happened: HR was getting the Monthly Reports,
// Loan and EMI, Leave Detail and Consultant Report packs every single morning.
//
// sendIncrementReminderEmail was the one written as `force !== true`, and it
// was also the one that correctly stayed quiet — a natural experiment that
// named the cause.
//
// This is a static check rather than an execution test because Apps Script
// cannot be run here. It reads the file the way a reviewer would, which is
// enough: the whole bug is one operator.
const fs = require('fs'), path = require('path');
const RAW = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code 2.js'), 'utf8');
// Comments stripped before anything is scanned. The comment explaining this bug
// necessarily contains the words `!force`, and on the first run it failed its
// own check — a test that reads prose is a test that fires on documentation.
// Line numbers are preserved so a failure still points at the right line.
const SRC = RAW.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

// Every function that accepts `force`, and every function name installed on a
// trigger. Read from the file so a new email cannot quietly join without being
// covered here.
const forceFns = (SRC.match(/^function\s+(\w+)\s*\(force\)/gm) || [])
  .map(m => m.replace(/^function\s+/, '').replace(/\s*\(force\)/, ''));
const triggered = [...new Set((SRC.match(/newTrigger\('([^']+)'\)/g) || [])
  .map(m => m.replace(/newTrigger\('/, '').replace(/'\)/, '')))];

console.log('the emails and how they are gated\n');
check('there are functions taking a force argument', forceFns.length > 0, true);
check('and functions installed on triggers', triggered.length > 0, true);

// THE assertion. `!force` is truthy-testing an argument that a trigger fills
// with an object, so it can never mean "nobody forced this".
console.log('\nthe trigger-event trap\n');
{
  const bad = [];
  SRC.split('\n').forEach((line, i) => {
    // A bare truthiness test on `force`, in either direction.
    if (/[^\w.]!force\b/.test(line) || /\bif\s*\(\s*force\s*\)/.test(line)) {
      bad.push((i + 1) + ': ' + line.trim());
    }
  });
  check('no gate truthy-tests `force`, because a trigger passes an object', bad, []);
}
{
  // The positive form: every force-taking function that gates on the day of the
  // month must compare against true explicitly.
  const gated = SRC.split('\n')
    .map((l, i) => ({ n: i + 1, l: l }))
    .filter(x => /MONTHLY_EMAIL_DAY\) return;/.test(x.l));
  check('every month-day gate exists', gated.length > 0, true);
  check('and every one of them compares force against true',
        gated.filter(x => !/force !== true/.test(x.l)).map(x => x.n), []);
}

console.log('\nthe emails that must not fire daily\n');
{
  // Each of these reports a finished month. A daily firing is not a nuisance —
  // it is four large attachments a day and a report whose covering text says
  // "August" landing every morning in September.
  const monthly = ['sendMonthlyReportsEmail', 'sendLoanAdvanceReportEmail',
                   'sendLeaveDetailReportEmail', 'sendConsultantReportEmail',
                   'sendMonthlyAdvanceSummaryEmail', 'sendIncrementReminderEmail'];
  monthly.forEach(fn => {
    check(fn + ' still exists', SRC.indexOf('function ' + fn + '(') >= 0, true);
    // Its body, up to the next top-level function.
    const start = SRC.indexOf('function ' + fn + '(');
    const rest = SRC.slice(start);
    const end = rest.indexOf('\nfunction ');
    const body = end === -1 ? rest : rest.slice(0, end);
    check(fn + ' gates on the day of the month',
          /MONTHLY_EMAIL_DAY/.test(body), true);
    check(fn + ' gates with force !== true, not !force',
          /force !== true/.test(body) && !/[^\w.]!force\b/.test(body), true);
  });
}

console.log('\nthe day itself\n');
{
  const m = /var MONTHLY_EMAIL_DAY = (\d+);/.exec(SRC);
  check('one constant decides the day for all of them', !!m, true);
  // Not a correctness requirement, only a sanity bound: a day above 28 would
  // skip February, which is the whole reason these are daily triggers with an
  // internal gate rather than monthly triggers.
  check('and it is a day that exists in every month',
        m && Number(m[1]) >= 1 && Number(m[1]) <= 28, true);
}

console.log('\ntest entry points stay off triggers\n');
{
  // sendAllEmailsNow forces every email. On a trigger it would do daily what
  // this bug did, and by design rather than by accident.
  check('sendAllEmailsNow is never installed on a trigger',
        triggered.indexOf('sendAllEmailsNow') === -1, true);
  check('every triggered name is a real function in the file',
        triggered.filter(n => SRC.indexOf('function ' + n + '(') === -1), []);
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
