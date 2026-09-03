// Earned Leave: the Attendance Sheet's Present column, month by month, at one
// day of EL per 25 of them — cumulative across the financial year and not
// floored.
//
// EL used to be counted its own way, from its own table of day codes, and only
// matched the Present column HR reads off the Attendance Sheet on a clean
// month. Any month with approved leave, a declared holiday or a late-coming
// deduction in it drifted, and HR reconciles the Leave Balance Next Year
// Report against exactly that column. qualifyingPresentDays now IS that
// column, summed per month, so the two cannot disagree.
//
// The narrowing that came with it, all asserted below: a day of EL or SL earns
// nothing (Present keeps approved leave out — "a day of Earned Leave is not a
// day the person was at work"), a Sunday or declared holiday earns nothing,
// and the late-coming Policy Cut comes off.
//
// Month by month rather than one call across the year: the late-coming
// allowance is three free instances PER MONTH, and a single call spanning a
// financial year would hand out three for the whole of it.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({qualifyingPresentDays, elEarnedFrom, elDisplay, leaveBalances,' +
  ' policyRowsFor, LEAVE_POLICY, datesBetween_, financialYearStart, computeAttendanceSummary,' +
  ' monthsBetween_})', sb);

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

console.log('25 qualifying days is one day of leave, and it is not floored\n');
check('25 qualifying days', L.elEarnedFrom(25), 1);
check('28 qualifying days is the worked example', L.elDisplay(L.elEarnedFrom(28)), 1.12);
check('24 earns something, not nothing', L.elDisplay(L.elEarnedFrom(24)), 0.96);
check('50 earns two', L.elEarnedFrom(50), 2);
check('the divisor comes from config, not a literal', PER, 25);

console.log('\nwhat one day is worth — 2025-06-10 is a working Tuesday\n');
const one = (code, holiday) => {
  const att = {};
  if (code) att['2025-06-10'] = { code };
  return L.qualifyingPresentDays(emp, att, '2025-06-10', '2025-06-10',
                                 holiday ? { '2025-06-10': true } : {});
};
[['P', 1], ['SHORT', 1],
 // Approved leave earns NOTHING now. The Present column keeps it out — "a day
 // of Earned Leave is not a day the person was at work" — and EL earning is
 // that column. This is the change HR asked for and the one most worth
 // pinning: it means somebody on sick leave accrues nothing for those days.
 ['EL', 0], ['SL', 0],
 // A half-day code is half a day worked, so half a day earned — the same 0.5
 // Present credits, whichever kind of half day it is.
 ['HEL', 0.5], ['HSL', 0.5], ['HLP', 0.5],
 ['A', 0], ['LP', 0]].forEach(([c, want]) => check('a day marked ' + c, one(c), want));
check('an unmarked ordinary day earns nothing', one(null, false), 0);
check('a declared holiday earns nothing either', one(null, true), 0);

console.log('\nneither the weekly off nor a declared holiday is a day worked\n');
// 2025-06-08 is a Sunday; 2025-06-18 is a working Wednesday.
const around = (day, holiday) => {
  const a = mark({}, '2025-06-02', '2025-06-30', 'P');   // every day marked present
  delete a[day];                                          // the day itself left unmarked
  return L.qualifyingPresentDays(emp, a, '2025-06-01', '2025-06-30',
                                 holiday ? { [day]: true } : {});
};
const baseline = L.qualifyingPresentDays(emp, mark({}, '2025-06-02', '2025-06-30', 'P'),
                                         '2025-06-01', '2025-06-30', {});
check('an unworked Sunday earns nothing', around('2025-06-08', false), baseline - 1);
check('an unmarked declared holiday earns nothing', around('2025-06-18', true), baseline - 1);
check('a Sunday on its own earns nothing', 
      L.qualifyingPresentDays(emp, {}, '2025-06-08', '2025-06-08', {}), 0);
check('a Sunday that is also a declared holiday earns nothing',
      L.qualifyingPresentDays(emp, {}, '2025-06-08', '2025-06-08',
                              { '2025-06-08': true }), 0);
// The rule takes away the day off, not a day somebody actually worked.
check('but a Sunday marked present does earn',
      L.qualifyingPresentDays(emp, { '2025-06-08': { code: 'P' } },
                              '2025-06-08', '2025-06-08', {}), 1);

console.log('\nit IS the Attendance Sheet\'s Present column, month by month\n');
// The whole point of the change: HR reconciles against that column, so any
// month where the two differ is a month their spreadsheet will not match.
const holidayMap = { '2026-08-15': true, '2026-06-18': true };
const att = {};
L.datesBetween_('2026-04-01', '2026-08-31').forEach(d => {
  if (new Date(d + 'T00:00:00').getDay() !== 0) {
    att[d] = { code: 'P', checkinTime: '09:20', checkoutTime: '18:30' };
  }
});
att['2026-05-06'] = { code: 'EL' };  att['2026-05-07'] = { code: 'SL' };
att['2026-06-10'] = { code: 'A' };   att['2026-06-11'] = { code: 'LP' };
att['2026-07-14'] = { code: 'HEL' }; att['2026-07-15'] = { code: 'HSL' };
delete att['2026-06-18'];            // an unmarked declared holiday
// Five late arrivals in one month, so the monthly allowance really bites.
['2026-08-10','2026-08-11','2026-08-12','2026-08-13','2026-08-14'].forEach(d => {
  att[d] = { code: 'P', lateFlag: true, checkinTime: '09:50', checkoutTime: '18:30' };
});
const MONTHS = [['April','2026-04-01','2026-04-30'], ['May','2026-05-01','2026-05-31'],
                ['June','2026-06-01','2026-06-30'],  ['July','2026-07-01','2026-07-31'],
                ['August','2026-08-01','2026-08-31']];
let summed = 0;
MONTHS.forEach(([name, from, to]) => {
  const s = L.computeAttendanceSummary(att, emp, L.datesBetween_(from, to), holidayMap);
  const q = L.qualifyingPresentDays(emp, att, from, to, holidayMap);
  summed += s.present;
  console.log('  ' + name.padEnd(8) + 'Present ' + String(s.present).padStart(6) +
              '   EL days ' + String(q).padStart(6) +
              '   (EL ' + s.elUsed + ', SL ' + s.slUsed + ', cut ' + s.policyCut + ')');
  check('  ' + name + ' ties to its own Present figure', q, s.present);
});
const ytd = L.qualifyingPresentDays(emp, att, '2026-04-01', '2026-08-31', holidayMap);
console.log('  April-August: ' + ytd + ' days → ' + L.elDisplay(L.elEarnedFrom(ytd)) + ' EL');
check('the year to date is those months added up', ytd, summed);

console.log('\nthe late-coming Policy Cut comes off, and monthly\n');
const augS = L.computeAttendanceSummary(att, emp, L.datesBetween_('2026-08-01','2026-08-31'), holidayMap);
check('August carries a policy cut at all, so this proves something', augS.policyCut > 0, true);
check('  and August\'s EL days are net of it', 
      L.qualifyingPresentDays(emp, att, '2026-08-01', '2026-08-31', holidayMap), augS.present);
// Three free late arrivals PER MONTH. Splitting the year into months is what
// keeps that allowance monthly; one call across the whole year would grant
// three for the year and undercharge the rest.
check('the range really is split into months', L.monthsBetween_('2026-04-01','2026-08-31').length, 5);
check('  first month starts at the range start', L.monthsBetween_('2026-04-10','2026-06-20')[0].from, '2026-04-10');
check('  last month ends at the range end', L.monthsBetween_('2026-04-10','2026-06-20')[2].to, '2026-06-20');
check('  and a whole month in between is whole', L.monthsBetween_('2026-04-10','2026-06-20')[1],
      { from: '2026-05-01', to: '2026-05-31' });

console.log('\napproved leave costs earning, which is the point of the change\n');
const worked = {}; Object.keys(att).forEach(k => { worked[k] = att[k]; });
worked['2026-05-06'] = { code: 'P', checkinTime: '09:20', checkoutTime: '18:30' };
worked['2026-05-07'] = { code: 'P', checkinTime: '09:20', checkoutTime: '18:30' };
check('a day of EL and a day of SL earn two days less than working them',
      L.qualifyingPresentDays(emp, worked, '2026-05-01', '2026-05-31', holidayMap) -
      L.qualifyingPresentDays(emp, att,    '2026-05-01', '2026-05-31', holidayMap), 2);

console.log('\nthe total runs across months and does not reset\n');
const clean = {};
L.datesBetween_('2025-04-01', '2025-05-31').forEach(d => {
  if (new Date(d + 'T00:00:00').getDay() !== 0) clean[d] = { code: 'P' };
});
const apr = L.qualifyingPresentDays(emp, clean, '2025-04-01', '2025-04-30', {});
const may = L.qualifyingPresentDays(emp, clean, '2025-04-01', '2025-05-31', {});
console.log('  April alone: ' + apr + ' → ' + L.elDisplay(L.elEarnedFrom(apr)) + ' EL');
console.log('  April + May: ' + may + ' → ' + L.elDisplay(L.elEarnedFrom(may)) + ' EL');
const sundaysIn = (from, to) => L.datesBetween_(from, to)
  .filter(d => new Date(d + 'T00:00:00').getDay() === 0).length;
check('April is the month less its Sundays', apr, 30 - sundaysIn('2025-04-01', '2025-04-30'));
check('two months accumulate rather than starting again',
      may, 61 - sundaysIn('2025-04-01', '2025-05-31'));
check('and the remainder is not lost at the month boundary',
      L.elDisplay(L.elEarnedFrom(may)), L.elDisplay(may / PER));
check('which is more than flooring each month separately would give',
      L.elEarnedFrom(may) > Math.floor(apr / PER) + Math.floor((may - apr) / PER), true);

console.log('\nunpaid days earn nothing\n');
const absent = mark({}, '2025-06-02', '2025-06-30', 'P');
absent['2025-06-10'] = { code: 'A' };
absent['2025-06-11'] = { code: 'LP' };
const allP = L.qualifyingPresentDays(emp, mark({}, '2025-06-02', '2025-06-30', 'P'),
                                     '2025-06-01', '2025-06-30', {});
check('two unpaid days cost two qualifying days',
      allP - L.qualifyingPresentDays(emp, absent, '2025-06-01', '2025-06-30', {}), 2);
// There is no sandwich subtraction any more and there must not be one: a
// sandwiched Sunday is already worth nothing, so taking a further day off
// would charge it twice and cost leave that was actually worked.
const sand = mark({}, '2025-06-02', '2025-06-30', 'P');
sand['2025-06-14'] = { code: 'A' };
sand['2025-06-16'] = { code: 'A' };
delete sand['2025-06-15'];            // the Sunday between them, left as the weekly off
check('a Sunday sandwiched between two absences is charged once, not twice',
      allP - L.qualifyingPresentDays(emp, sand, '2025-06-01', '2025-06-30', {}),
      2 /* the two absences */ + 1 /* the Sunday, which was worth 1 as a marked P */);

console.log('\nsomebody who joined part way through earns only from their joining date\n');
const joiner = Object.assign({}, emp, { doj: '2025-06-16' });
const joinerDays = L.qualifyingPresentDays(joiner, mark({}, '2025-06-02', '2025-06-30', 'P'),
                                           '2025-06-01', '2025-06-30', {});
check('nothing is earned before the date of joining', joinerDays < allP, true);
check('and it is the days from the 16th on', joinerDays, 15);

console.log('\nnothing is earned for days that have not happened yet\n');
check('a future month earns nothing',
      L.qualifyingPresentDays(emp, {}, '2099-01-01', '2099-01-31', {}), 0);

console.log('\nthe Attendance Sheet reports the year to date, not the month\n');
const dateList = L.datesBetween_('2025-05-01', '2025-05-31');
const rows = L.policyRowsFor([emp], { '1': clean }, dateList, {});
console.log('  May\'s row: ' + rows[0].attendanceDays + ' qualifying days, ' +
            L.elDisplay(rows[0].bal.plEarned) + ' EL earned');
check('the qualifying days on May\'s row are April + May', rows[0].attendanceDays, may);
check('so the EL on it is the year to date', L.elDisplay(rows[0].bal.plEarned),
      L.elDisplay(may / PER));

console.log('\nthe balance keeps its decimals\n');
const bal = L.leaveBalances({ employeeType: 'office' }, { sick: 0, pl: 1, attendanceDays: 28 });
check('earned', L.elDisplay(bal.plEarned), 1.12);
check('left, after one day taken', L.elDisplay(bal.plLeft), 0.12);
check('and it never goes below nil',
      L.leaveBalances({ employeeType: 'office' }, { pl: 5, attendanceDays: 28 }).plLeft, 0);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
