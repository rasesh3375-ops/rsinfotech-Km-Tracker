// The Pre-Payroll Check: what it flags, and — more important — what it does
// not.
//
// This screen exists to be trusted on the 1st of the month, which means a
// false alarm costs almost as much as a missed one. HR who learn that three of
// the eight flags are always noise stop reading all eight. So every check here
// asserts both directions: the condition fires when it should, and stays
// silent on the ordinary case that looks like it.
//
// It is also the one screen that must never disagree with the Salary Sheet.
// prePayrollChecks is handed the salary objects computeSalaryFromAttendance
// already returned rather than computing anything itself, and the assertions
// below feed it exactly those, so a figure it reports is by construction the
// figure that will be paid.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({prePayrollChecks, computeSalaryFromAttendance, monthDateList_,' +
  ' prevMonthOf_, esiPeriodKey_, ESI_RULES})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const YM = '2026-08', PREV = '2026-07';
const LIST = L.monthDateList_(YM), PLIST = L.monthDateList_(PREV);
const HOLIDAYS = { '2026-08-15': 'Independence Day' };

function emp(over){
  return Object.assign({
    id: 'E1', name: 'Test One', employmentStatus: 'active', employeeType: 'office',
    doj: '2020-01-01', salaryHeading: 'managerial', ratePay: 30000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' }],
    pfEligible: 'yes', pfContributionType: 'percent', hasPriorUan: 'yes', form11Submitted: 'yes',
    esiEligible: 'yes'
  }, over || {});
}
// Both months marked present, so nothing fires by accident. Every check below
// starts from this and changes exactly one thing.
//
// July matters as much as August: the checks compare the two, and an empty
// previous month is not "no data" to computeAttendanceSummary — every past
// unmarked day scores as absent, so a fixture that filled August alone gave
// July a gross of zero and made an ordinary employee look like they had just
// crossed the ESI ceiling and had their pay collapse. That was the fixture
// lying, and it is exactly the shape of a real new joiner, which is why the
// ESI check now compares Rate of Pay rather than the leave-reduced gross.
function fullAttendance(code){
  const att = {};
  PLIST.concat(LIST).forEach(d => {
    if (new Date(d + 'T00:00:00').getDay() === 0) return;   // Sunday, left unmarked
    if (HOLIDAYS[d]) return;                                 // declared holiday, likewise
    att[d] = { code: code || 'P' };
  });
  return att;
}
// Runs the checks the way the screen does: salary for both months from the one
// attendance record, then the check builder over the result.
function run(employees, attByEmp, opts){
  const sal = {}, prevSal = {};
  employees.forEach(e => {
    const att = attByEmp[e.id] || {};
    sal[e.id] = L.computeSalaryFromAttendance(e, att, LIST, LIST.length, HOLIDAYS);
    prevSal[e.id] = L.computeSalaryFromAttendance(e, att, PLIST, PLIST.length, HOLIDAYS);
  });
  return L.prePayrollChecks(employees, attByEmp, YM, HOLIDAYS, sal, prevSal,
    Object.assign({ today: '2026-09-01' }, opts || {}));
}
const keys = res => res.flags.map(f => f.key).sort();
const whoOf = (res, key) => (res.flags.find(f => f.key === key) || { who: [] }).who.map(w => w.id);

// ---------------------------------------------------------------- clean month
console.log('a month with nothing wrong raises nothing\n');
{
  const e = emp();
  const res = run([e], { E1: fullAttendance() });
  check('no flags at all', keys(res), []);
  check('and it counts the employee as clear', [res.counts.clear, res.checked], [1, 1]);
}

// ------------------------------------------------------ attendance incomplete
console.log('\nattendance not complete\n');
{
  const att = fullAttendance();
  delete att['2026-08-11']; delete att['2026-08-12'];
  const res = run([emp()], { E1: att });
  check('two unmarked working days are flagged', whoOf(res, 'attendance-incomplete'), ['E1']);
  check('and it is a must-fix, not a warning',
        res.flags.find(f => f.key === 'attendance-incomplete').level, 'stop');
  check('the count of days is in the wording',
        /2 day\(s\)/.test(res.flags.find(f => f.key === 'attendance-incomplete').detail), true);
}
{
  // The silence that matters: Sundays and declared holidays are unmarked in
  // every real month. Counting those would flag all 42 employees every month
  // and the screen would be abandoned in a week.
  const res = run([emp()], { E1: fullAttendance() });
  check('an unmarked Sunday is not "incomplete"', keys(res).includes('attendance-incomplete'), false);
  check('nor is an unmarked declared holiday (15 August here)',
        Object.keys(fullAttendance()).includes('2026-08-15'), false);
}
{
  // A month still running: days that have not happened are not missing.
  const att = fullAttendance();
  LIST.filter(d => d > '2026-08-10').forEach(d => delete att[d]);
  const res = run([emp()], { E1: att }, { today: '2026-08-10' });
  check('days later this month are not counted as unmarked',
        keys(res).includes('attendance-incomplete'), false);
}

// -------------------------------------------------------------- no rate of pay
console.log('\nnothing to pay them from\n');
{
  const e = emp({ ratePay: 0, salaryHistory: [{ from: '2020-01-01', ratePay: 0, salaryHeading: 'managerial' }] });
  const res = run([e], { E1: fullAttendance() });
  check('a zero Rate of Pay is a must-fix', whoOf(res, 'no-rate'), ['E1']);
}

// ------------------------------------------------------------ shared identifier
console.log('\nthe same identifier on two people\n');
{
  const a = emp({ id: 'A', name: 'A', accountNumber: '123456789012' });
  const b = emp({ id: 'B', name: 'B', accountNumber: '1234 5678 9012' });   // same, spaced
  const c = emp({ id: 'C', name: 'C', accountNumber: '999999999999' });
  const att = { A: fullAttendance(), B: fullAttendance(), C: fullAttendance() };
  const res = run([a, b, c], att);
  check('both holders of the shared account are named',
        whoOf(res, 'duplicate-accountNumber').sort(), ['A', 'B']);
  check('the one with their own account is not', whoOf(res, 'duplicate-accountNumber').includes('C'), false);
  check('spacing does not hide it', res.flags.some(f => f.key === 'duplicate-accountNumber'), true);
}
{
  // Blank is not a duplicate. Most records have no UAN until PF is registered,
  // and flagging every one of them as sharing an identifier is the classic way
  // to make a check useless.
  const a = emp({ id: 'A', name: 'A', uan: '' }), b = emp({ id: 'B', name: 'B', uan: '' });
  const res = run([a, b], { A: fullAttendance(), B: fullAttendance() });
  check('two blank UANs are not a duplicate', keys(res).includes('duplicate-uan'), false);
}

// ------------------------------------------------------------ ESI ceiling cross
console.log('\ncrossing the ESI ceiling — the rule HR gets wrong\n');
{
  // Under the ceiling in July, over it in August, both inside the same
  // April–September contribution period. Once covered, always covered.
  const e = emp({
    ratePay: 22000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 20000, salaryHeading: 'managerial' },
                    { from: '2026-08-01', ratePay: 22000, salaryHeading: 'managerial' }]
  });
  const res = run([e], { E1: fullAttendance() });
  check('the crossing is flagged', whoOf(res, 'esi-crossed'), ['E1']);
  const f = res.flags.find(f => f.key === 'esi-crossed');
  check('and it says to keep deducting to the end of the period',
        /keep deducting to 30 September/.test(f.detail), true);
  check('as a warning, not a blocker — payroll can still run', f.level, 'warn');
}
{
  // Above the ceiling in both months: nothing crossed, nothing to say.
  const e = emp({ ratePay: 40000, salaryHistory: [{ from: '2020-01-01', ratePay: 40000, salaryHeading: 'managerial' }] });
  const res = run([e], { E1: fullAttendance() });
  check('someone already above the ceiling is silent', keys(res).includes('esi-crossed'), false);
}
{
  check('the period key splits April–September from October–March',
        [L.esiPeriodKey_('2026-08-01'), L.esiPeriodKey_('2026-09-30'),
         L.esiPeriodKey_('2026-10-01'), L.esiPeriodKey_('2027-03-31')],
        ['2026-AS', '2026-AS', '2026-OM', '2026-OM']);
}

// ----------------------------------------------------------- present on a holiday
console.log('\nmarked present on a day nobody worked\n');
{
  const att = fullAttendance();
  att['2026-08-15'] = { code: 'P' };     // the declared holiday
  const res = run([emp()], { E1: att });
  check('present on a declared holiday is flagged', whoOf(res, 'present-on-holiday'), ['E1']);
}
{
  const att = fullAttendance();
  att['2026-08-02'] = { code: 'P' };     // a Sunday
  const res = run([emp()], { E1: att });
  check('present on a Sunday too', whoOf(res, 'present-on-holiday'), ['E1']);
}

// ------------------------------------------------------------- increment overdue
console.log('\nan increment that has come and gone\n');
{
  const e = emp({ nextIncrement: '2026-04-01' });
  const res = run([e], { E1: fullAttendance() });
  check('an increment date passed with no salary history entry', whoOf(res, 'increment-due'), ['E1']);
}
{
  const e = emp({ nextIncrement: '2026-04-01',
    salaryHistory: [{ from: '2020-01-01', ratePay: 28000, salaryHeading: 'managerial' },
                    { from: '2026-04-01', ratePay: 30000, salaryHeading: 'managerial' }] });
  const res = run([e], { E1: fullAttendance() });
  check('but not once the increment is actually recorded',
        keys(res).includes('increment-due'), false);
}

// -------------------------------------------------------------- pay that moved
console.log('\npay that moved, and what moved it\n');
{
  // Same Rate of Pay both months; August is half absent. The move is real and
  // worth seeing — but it is leave, not a fault, and the flag must say so.
  const att = fullAttendance();
  LIST.slice(0, 14).forEach(d => { if (att[d]) att[d] = { code: 'A' }; });
  const res = run([emp()], { E1: att });
  const f = res.flags.find(f => f.key === 'pay-moved');
  check('the move is reported', !!f, true);
  check('as something to look at, not something to fix — its cause is ordinary',
        f.level, 'warn');
  check('and the reason is named against the person, not left to be guessed',
        /leave day/.test((f.who[0] || {}).note || ''), true);
  check('with the direction and size', /^down \d+%/.test((f.who[0] || {}).note || ''), true);
}
{
  // A recorded increment explains itself on the salary history and is the one
  // thing HR does not need telling about.
  const e = emp({
    ratePay: 45000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' },
                    { from: '2026-08-01', ratePay: 45000, salaryHeading: 'managerial' }]
  });
  const res = run([e], { E1: fullAttendance() });
  check('a recorded increment is not reported at all', keys(res).includes('pay-moved'), false);
}
{
  // Recoveries, not leave: an advance recovered this month and not last. The
  // cause named must be the recovery, or the flag sends HR to the attendance
  // sheet for something that is not there.
  const e = emp({ advanceHistory: [{ month: '2026-08', advance: 9000 }] });
  const res = run([e], { E1: fullAttendance() });
  const f = res.flags.find(f => f.key === 'pay-moved');
  check('a recovery is picked out as the cause, not leave',
        /recovered/.test(((f || {}).who || [{}])[0].note || ''), true);
}

// ------------------------------------------------------------ month in progress
console.log('\na month that has not finished yet\n');
{
  // The 6th of the month, nothing marked yet. Every one of those unmarked days
  // is correct and none of them needs doing — the screen opened on exactly this
  // and flagged 32 of 40 people over nothing.
  const att = fullAttendance();
  LIST.forEach(d => delete att[d]);
  const res = L.prePayrollChecks([emp()], { E1: att }, YM, HOLIDAYS,
    { E1: L.computeSalaryFromAttendance(emp(), att, LIST, LIST.length, HOLIDAYS) },
    { E1: L.computeSalaryFromAttendance(emp(), att, PLIST, PLIST.length, HOLIDAYS) },
    { today: '2026-08-06' });
  const f = res.flags.find(f => f.key === 'attendance-incomplete');
  check('unmarked days in a running month are still reported', !!f, true);
  check('but not as a must-fix', f.level, 'warn');
  check('and the wording says the month is still running',
        /still running/.test(f.detail), true);
  check('nothing is a must-fix in a month nobody has finished working',
        res.counts.stop, 0);
}
{
  // The same month, finished. Now it is a blocker.
  const att = fullAttendance();
  delete att['2026-08-11'];
  const res = run([emp()], { E1: att });
  check('the same gap in a finished month IS a must-fix',
        res.flags.find(f => f.key === 'attendance-incomplete').level, 'stop');
}

// ------------------------------------------------------------------- the counts
console.log('\nthe counts across a mixed roster\n');
{
  const clean = emp({ id: 'OK', name: 'Clean' });
  const broken = emp({ id: 'BAD', name: 'Broken' });
  const attBad = fullAttendance(); delete attBad['2026-08-11'];
  const res = run([clean, broken], { OK: fullAttendance(), BAD: attBad });
  check('one flagged, one clear, two checked',
        [res.counts.stop >= 1, res.counts.clear, res.checked], [true, 1, 2]);
  check('must-fix flags sort above warnings',
        res.flags.length ? res.flags[0].level : 'stop', 'stop');
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
