// Every column the Leave Detail reports promise must be a figure something
// actually produces.
//
// LEAVE_DETAIL_METRICS is the config both Leave Detail reports render from —
// the Monthly one and the Yearly one. Full Day Leave is in that list, but it
// is not a key computeAttendanceSummary returns: it is absent + lpDays, a
// definition that exists in exactly one place, leaveDetailRowFor.
//
// The Monthly report went through leaveDetailRowFor and was right. The Yearly
// report read computeAttendanceSummary directly, which looks equivalent and
// is not, so `s['fullDayLeave'] || 0` came out 0 for every employee in every
// month — a column of zeroes that reads as a clean year rather than a broken
// report. HR found it, not a test, because nothing here asserted that a column
// in the config corresponds to anything.
//
// So this checks the contract rather than one caller: whatever
// LEAVE_DETAIL_METRICS lists, leaveDetailRowFor produces, and it produces real
// figures rather than the zeroes an absent key silently yields.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({LEAVE_DETAIL_METRICS, leaveDetailRowFor, computeAttendanceSummary,' +
  ' datesBetween_})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const emp = { id: '1', seqNo: 1, name: 'Test Member', salaryHeading: 'junior',
              ratePay: 24000, employeeType: 'office', doj: '2020-01-01',
              employmentStatus: 'active' };
const dateList = L.datesBetween_('2026-08-01', '2026-08-31');
const holidayMap = { '2026-08-15': true };
const att = {};
dateList.forEach(d => { att[d] = { code: 'P', checkinTime: '09:20', checkoutTime: '18:30' }; });
// One of everything the six metrics count, each a different number, so a
// column reading another column's figure is caught as well as one reading nil.
att['2026-08-03'] = { code: 'A' };                       // full day leave
att['2026-08-04'] = { code: 'A' };                       // full day leave
att['2026-08-05'] = { code: 'LP' };                      // full day leave
att['2026-08-06'] = { code: 'EL' };                      // EL
att['2026-08-07'] = { code: 'SL' };                      // SL
att['2026-08-10'] = { code: 'HEL' };                     // half day
att['2026-08-11'] = { code: 'SHORT' };                   // short leave
att['2026-08-12'] = { code: 'P', lateFlag: true, checkinTime: '09:50', checkoutTime: '18:30' };
att['2026-08-13'] = { code: 'P', lateFlag: true, checkinTime: '09:50', checkoutTime: '18:30' };

const row = L.leaveDetailRowFor(emp, att, dateList, holidayMap);
const summary = L.computeAttendanceSummary(att, emp, dateList, holidayMap);

console.log('every column the reports promise is actually produced\n');
L.LEAVE_DETAIL_METRICS.forEach(m => {
  check('"' + m.label + '" (' + m.key + ') exists', row[m.key] !== undefined, true);
});

console.log('\nand none of them is silently nil on a month that has all six\n');
L.LEAVE_DETAIL_METRICS.forEach(m => {
  check('"' + m.label + '" is a real figure', Number(row[m.key]) > 0, true);
});

console.log('\nFull Day Leave is absence plus leave without pay, and nothing else\n');
console.log('       absent ' + summary.absent + ' + LP ' + summary.lpDays +
            ' = ' + row.fullDayLeave);
check('fullDayLeave is absent + lpDays', row.fullDayLeave, summary.absent + summary.lpDays);
check('it is 3 here — two absences and one unpaid day', row.fullDayLeave, 3);
// The bug shipped because this key is missing from the summary. If it is ever
// added there, the two definitions must not be allowed to drift apart
// silently — this says so out loud.
check('and computeAttendanceSummary still does not define it on its own,\n' +
      '       so leaveDetailRowFor stays the only place that knows',
      summary.fullDayLeave, undefined);

console.log('\nthe other five carry their own figure, not a neighbour\'s\n');
// 1.5, not 1: the HEL day is half a day of EL as well as a half day, so it is
// counted in both columns. That is the policy, not a double count — the half
// worked is attendance and the half taken is leave.
check('EL / PL', row.elUsed, 1.5);
check('SL', row.slUsed, 1);
check('Half Day', row.halfDays, 1);
check('Short Leave', row.shortCount, 1);
check('Late Coming', row.lateCount, 2);

console.log('\nreading the summary directly — what the Yearly report used to do\n');
const naive = L.LEAVE_DETAIL_METRICS.map(m => summary[m.key] || 0);
console.log('       ' + JSON.stringify(naive));
check('would have lost Full Day Leave to a zero',
      naive[L.LEAVE_DETAIL_METRICS.findIndex(m => m.key === 'fullDayLeave')], 0);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
