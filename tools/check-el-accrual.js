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

// A Sunday or a holiday only earns when the employee was actually working
// around it. Judged in isolation, with no attendance either side, it is
// bracketed by two unmarked past days — which computeAttendanceSummary,
// sandwichDaysFor and the Consultant Report all read as absence, and payroll
// charges as unpaid. So it earns nothing, and that is right rather than a gap:
// what is not paid for does not accrue leave.
const around = (day, holiday) => {
  const a = mark({}, '2025-06-02', '2025-06-30', 'P');   // a full working month
  delete a[day];                                          // the day itself unmarked
  return L.qualifyingPresentDays(emp, a, '2025-06-01', '2025-06-30',
                                 holiday ? { [day]: true } : {});
};
const baseline = L.qualifyingPresentDays(emp, mark({}, '2025-06-02', '2025-06-30', 'P'),
                                         '2025-06-01', '2025-06-30', {});
// 2025-06-08 is a Sunday; 2025-06-18 is a working Wednesday.
check('a Sunday in a month that was worked counts', around('2025-06-08', false), baseline);
check('so does a declared holiday in one', around('2025-06-18', true), baseline);
check('a Sunday with nobody working around it does not',
      L.qualifyingPresentDays(emp, {}, '2025-06-08', '2025-06-08', {}), 0);

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
check('April is the whole month, Sundays included', apr, 30);
check('two months accumulate rather than starting again', may, 61);
check('and the remainder is not lost at the month boundary',
      L.elDisplay(L.elEarnedFrom(may)), L.elDisplay(61 / PER));
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
