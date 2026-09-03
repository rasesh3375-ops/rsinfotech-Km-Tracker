// Earned Leave: one day per 25 qualifying present days, cumulative, not floored.
//
// EL used to be worked out twice from two different rules. policyRowsFor
// counted P, SHORT, EL and SL and gave a half day nothing; elFyRows counted
// P, EL and SL, gave a half day 0.5 and ignored SHORT — so the Attendance
// Sheet and the Leave Encashment Report could report different EL for the same
// person in the same year. Both also floored inside their own window, so the
// days past a multiple of 25 were thrown away rather than carrying on
// accruing.
//
// This asserts the rule as HR stated it: a running total across the financial
// year, decimals kept, Sundays and declared holidays counted, and unpaid days
// earning nothing.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({qualifyingPresentDays, elEarnedFrom, elDisplay, leaveBalances,' +
  ' policyRowsFor, LEAVE_POLICY, datesBetween_, financialYearStart})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const PER = L.LEAVE_POLICY.privilegeLeave.earnedPerAttendanceDays;
const emp = { id: '1', name: 'Test', employeeType: 'office', doj: '2020-01-01',
              employmentStatus: 'active', salaryHeading: 'junior', ratePay: 25000 };
// Every date here is in the past, so nothing is trimmed by the "never count
// past today" rule and the fixture means the same thing whenever it is run.
const mark = (att, from, to, code) => {
  L.datesBetween_(from, to).forEach(d => { att[d] = { code }; });
  return att;
};

console.log('HR\'s rule: 25 qualifying days is one day of leave, and it is not floored\n');
check('25 qualifying days', L.elEarnedFrom(25), 1);
check('28 qualifying days is the worked example', L.elDisplay(L.elEarnedFrom(28)), 1.12);
check('24 earns something, not nothing', L.elDisplay(L.elEarnedFrom(24)), 0.96);
check('50 earns two', L.elEarnedFrom(50), 2);
check('the divisor comes from config, not a literal', PER, 25);

console.log('\nwhat counts as a qualifying day\n');
const one = (code, holiday) => {
  const att = {};
  if (code) att['2025-06-10'] = { code };
  return L.qualifyingPresentDays(emp, att, '2025-06-10', '2025-06-10',
                                 holiday ? { '2025-06-10': true } : {});
};
[['P', 1], ['SHORT', 1], ['EL', 1], ['SL', 1],
 ['HEL', 0.5], ['HSL', 0.5], ['HLP', 0.5],
 ['A', 0], ['LP', 0]].forEach(([c, want]) => check('a day marked ' + c, one(c), want));
check('an unmarked ordinary day earns nothing', one(null, false), 0);

// The weekly off does not earn leave. A declared holiday still does.
//
// Both resolve to the same stored code, 'H' — only what it READS differs — so
// nothing told them apart and a Sunday counted like any other paid day off.
// HR asked for that to stop: 25 qualifying days makes one day of EL carried
// into next year, and a day nobody was expected to work should not be a
// quarter of one.
const around = (day, holiday) => {
  const a = mark({}, '2025-06-02', '2025-06-30', 'P');   // a full working month
  delete a[day];                                          // the day itself unmarked
  return L.qualifyingPresentDays(emp, a, '2025-06-01', '2025-06-30',
                                 holiday ? { [day]: true } : {});
};
const baseline = L.qualifyingPresentDays(emp, mark({}, '2025-06-02', '2025-06-30', 'P'),
                                         '2025-06-01', '2025-06-30', {});
// 2025-06-08 is a Sunday; 2025-06-18 is a working Wednesday.
check('an unworked Sunday earns nothing', around('2025-06-08', false), baseline - 1);
check('a declared holiday still earns', around('2025-06-18', true), baseline);
check('a Sunday on its own earns nothing either',
      L.qualifyingPresentDays(emp, {}, '2025-06-08', '2025-06-08', {}), 0);
// Somebody who genuinely worked a Sunday has it marked P, which is a present
// day like any other — the rule takes away the OFF day, not the worked one.
// Measured inside a worked fortnight, not in isolation: a lone Sunday with
// nothing marked either side is sandwiched between two absences and the
// sandwich rule takes it off again, which would make this prove nothing.
{
  const worked = mark({}, '2025-06-02', '2025-06-14', 'P');   // Sunday the 8th marked P
  const off = mark({}, '2025-06-02', '2025-06-14', 'P');
  delete off['2025-06-08'];                                    // the same Sunday left as the weekly off
  check('but a Sunday actually worked and marked present does earn',
        L.qualifyingPresentDays(emp, worked, '2025-06-02', '2025-06-14', {}) -
        L.qualifyingPresentDays(emp, off,    '2025-06-02', '2025-06-14', {}), 1);
}
// A Sunday with a holiday declared on it is still the weekly off. Crediting it
// because a holiday landed there would pay for the day this rule removes.
check('a Sunday that is also a declared holiday still earns nothing',
      L.qualifyingPresentDays(emp, {}, '2025-06-08', '2025-06-08',
                              { '2025-06-08': true }), 0);

console.log('\nthe total runs across months and does not reset\n');
// A full April, then a full May: every weekday present, Sundays left to resolve
// on their own.
const att = {};
L.datesBetween_('2025-04-01', '2025-05-31').forEach(d => {
  if (new Date(d + 'T00:00:00').getDay() !== 0) att[d] = { code: 'P' };
});
const apr = L.qualifyingPresentDays(emp, att, '2025-04-01', '2025-04-30', {});
const may = L.qualifyingPresentDays(emp, att, '2025-04-01', '2025-05-31', {});
console.log('  April alone: ' + apr + ' qualifying days → ' + L.elDisplay(L.elEarnedFrom(apr)) + ' EL');
console.log('  April + May: ' + may + ' qualifying days → ' + L.elDisplay(L.elEarnedFrom(may)) + ' EL');
// Derived from the calendar rather than typed in, so the day these months are
// re-counted the expectation moves with them instead of going stale.
const sundaysIn = (from, to) => L.datesBetween_(from, to)
  .filter(d => new Date(d + 'T00:00:00').getDay() === 0).length;
check('April is the month less its Sundays', apr, 30 - sundaysIn('2025-04-01', '2025-04-30'));
check('two months accumulate rather than starting again',
      may, 61 - sundaysIn('2025-04-01', '2025-05-31'));
check('  and that is 8 Sundays gone across the two', 61 - may, 8);
check('and the remainder is not lost at the month boundary',
      L.elDisplay(L.elEarnedFrom(may)), L.elDisplay(may / PER));
check('which is more than flooring each month separately would give',
      L.elEarnedFrom(may) > Math.floor(30 / PER) + Math.floor(31 / PER), true);

console.log('\nunpaid days earn nothing\n');
const absent = mark({}, '2025-06-02', '2025-06-30', 'P');
absent['2025-06-10'] = { code: 'A' };
absent['2025-06-11'] = { code: 'LP' };
const withAbs = L.qualifyingPresentDays(emp, absent, '2025-06-01', '2025-06-30', {});
const allP = L.qualifyingPresentDays(emp, mark({}, '2025-06-02', '2025-06-30', 'P'),
                                     '2025-06-01', '2025-06-30', {});
check('two unpaid days cost two qualifying days', allP - withAbs, 2);

// A Sunday sandwiched between two unpaid days is charged as unpaid by payroll,
// so it must not earn leave either. 2025-06-15 is a Sunday.
const sand = mark({}, '2025-06-02', '2025-06-30', 'P');
sand['2025-06-14'] = { code: 'A' };
sand['2025-06-16'] = { code: 'A' };
const sandDays = L.qualifyingPresentDays(emp, sand, '2025-06-01', '2025-06-30', {});
check('a sandwiched Sunday earns nothing, the way payroll does not pay for it',
      allP - sandDays, 3);
// And it is charged exactly once. The sandwich subtraction takes a date off at
// whatever it was credited, not a flat 1 — a sandwiched Sunday is already
// worth nothing now, so a flat subtraction would charge it a second time and
// quietly cost leave that was genuinely worked. The two absences either side
// account for the whole difference; the Sunday between them adds nothing more.
check('  and only once — not credited nil and then charged again',
      allP - sandDays, 2 /* the two absences */ + 1 /* the Sunday, once */);
{
  // The same month with the Sunday left alone: the two absences on their own
  // cost exactly two, which pins the figure above to 2 + 1 rather than 2 + 2.
  const twoAbs = mark({}, '2025-06-02', '2025-06-30', 'P');
  twoAbs['2025-06-16'] = { code: 'A' };
  twoAbs['2025-06-17'] = { code: 'A' };
  check('  two absences that sandwich nothing cost two, no more',
        allP - L.qualifyingPresentDays(emp, twoAbs, '2025-06-01', '2025-06-30', {}), 2);
}

console.log('\nsomebody who joined part way through earns only from their joining date\n');
const joiner = Object.assign({}, emp, { doj: '2025-06-16' });
const joinerDays = L.qualifyingPresentDays(joiner, mark({}, '2025-06-02', '2025-06-30', 'P'),
                                           '2025-06-01', '2025-06-30', {});
check('nothing is earned before the date of joining', joinerDays < allP, true);
check('and it is the days from the 16th on', joinerDays, 15);

console.log('\nnothing is earned for days that have not happened yet\n');
const future = L.qualifyingPresentDays(emp, {}, '2099-01-01', '2099-01-31', {});
check('a future month earns nothing', future, 0);

console.log('\nthe Attendance Sheet now reports the year to date, not the month\n');
const dateList = L.datesBetween_('2025-05-01', '2025-05-31');
const rows = L.policyRowsFor([emp], { '1': att }, dateList, {});
console.log('  May\'s row: ' + rows[0].attendanceDays + ' qualifying days, ' +
            L.elDisplay(rows[0].bal.plEarned) + ' EL earned');
check('the qualifying days on May\'s row are April + May',
      rows[0].attendanceDays, may);
check('so the EL on it is the year to date', L.elDisplay(rows[0].bal.plEarned),
      L.elDisplay(may / PER));
check('and it is not the month on its own',
      rows[0].attendanceDays === 31, false);

console.log('\nthe balance keeps its decimals\n');
const bal = L.leaveBalances({ employeeType: 'office' }, { sick: 0, pl: 1, attendanceDays: 28 });
check('earned', L.elDisplay(bal.plEarned), 1.12);
check('left, after one day taken', L.elDisplay(bal.plLeft), 0.12);
check('and it never goes below nil',
      L.leaveBalances({ employeeType: 'office' }, { pl: 5, attendanceDays: 28 }).plLeft, 0);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
