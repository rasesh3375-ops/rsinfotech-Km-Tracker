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
];

let failed = 0;
CHECKS.forEach(([file, what]) => {
  const label = file.replace(/^check-|\.js$/g, '').padEnd(17);
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
