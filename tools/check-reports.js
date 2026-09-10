// Runs every report check in one go, and stays quiet unless something breaks.
//
// These started as throwaway jsdom/vm harnesses written per change and deleted
// after. That was the convention, and it cost us: the same fixtures were
// rewritten from scratch each time, and — worse — a harness that has been
// deleted cannot catch the regression it was written to prevent. The central
// sequence shipped with every SR NO column on every report printing the word
// "Infinity", and what found it was a consultant's emailed summary, not a
// test. Re-running a check is nearly free; re-deriving one is not.
//
// So the durable ones live here. Every check in this list is pure: it loads
// shared/report-logic.js into a bare vm context and asserts on what the report
// builders return. No jsdom, no npm install, no network — `node
// tools/check-reports.js` works on a clean clone.
//
// Screen-level harnesses (the ones that drive index.html in jsdom) stay
// throwaway on purpose. They need `npm install jsdom`, they take seconds
// rather than milliseconds, and they break for reasons that have nothing to do
// with payroll being wrong.
const { execFileSync } = require('child_process');
const path = require('path');

const CHECKS = [
  ['check-sequence.js',         'the central sequence engine — shifting, moving, duplicates, 60 moves'],
  ['check-sequence-reports.js', 'every report follows the sequence, and no figure moves when it does'],
  ['check-srno.js',             'what SR NO actually prints, numbered and unnumbered'],
  ['check-wage-register.js',    'the wage register adds up the way the consultant\'s does'],
  ['check-tie-out.js',          'every printed sheet adds up as printed, and ESI rounds up'],
  ['check-el-accrual.js',       'EL accrues cumulatively at 1 per 25 days, not floored monthly'],
  ['check-attendance-columns.js', 'the emailed attendance sheet reports each figure once, not twice'],
  ['check-pf-agreement.js',     'the PF Return and Consultant Summary state one figure per PF account'],
  ['check-leave-detail-metrics.js', 'every Leave Detail column is a figure something actually produces'],
  ['check-sequence-writes.js',   'a sequence change either happens or says plainly that it did not'],
  ['check-session-purge.js',     'the session purge never evicts the login that just happened'],
  ['check-challan.js',           'a PF challan is compared with the month, and never agrees with a figure it could not read'],
  ['check-briefing.js',          'the monthly briefing says what the figures say, and nothing it cannot'],
  ['check-prepay.js',            'the pre-payroll check fires on a real fault and stays quiet otherwise'],
  ['check-tracking.js',          'an engineer is paid for driving, not walking, and never short-changed by traffic'],
  ['check-tracker-health.js',    'HR is told what is actually wrong with a phone, and who never checked in'],
  ['check-email-triggers.js',    'a monthly email goes out monthly, not on every firing of its daily trigger'],
  ['check-appraisal.js',         'an increment already recorded is reported, never applied a second time'],
  // The one screen-level check kept rather than thrown away. The convention
  // below says jsdom harnesses stay throwaway, and it holds for screens; this
  // one guards months of salary already paid — stopping a recurring recovery
  // used to restate every month it had ever applied to — and the code it
  // covers only exists as DOM-reading collect functions in index.html, so
  // there is nowhere else to test it from. It skips cleanly, without failing,
  // when jsdom is not installed.
  ['check-recovery-history.js',  'stopping or changing a recovery never restates a month already paid'],
  ['check-payroll-lock.js',      'a finalised month does not move, whatever is edited afterwards'],
  // Kept for the same reason as check-recovery-history.js: it guards data
  // already recorded, and the code it covers only exists as browser functions.
  ['check-attendance-save.js',   'saving attendance never deletes the days it was not asked to change'],
];

let failed = 0;
CHECKS.forEach(([file, what]) => {
  const label = file.replace(/^check-|\.js$/g, '').padEnd(22);
  try {
    execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'pipe' });
    console.log('  ok    ' + label + what);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + label + what);
    // Only a failing check prints its output. A passing run is four lines,
    // which is what makes running this every time cheap enough to actually do.
    const out = String(e.stdout || '') + String(e.stderr || '');
    console.log(out.split('\n').map(l => '        ' + l).join('\n'));
  }
});

if (failed) {
  console.log('\n' + failed + ' of ' + CHECKS.length + ' report check(s) failed.');
  process.exit(1);
}
console.log('\nAll ' + CHECKS.length + ' report checks pass.');
