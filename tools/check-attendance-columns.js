// The Attendance Sheet CSV: every column carries a figure, and no figure is
// carried twice.
//
// The emailed sheet used to print Late, Short, Half and SL in its summary
// block and then Late Count, Short Leaves, Half Days and Sick Used in its
// policy block — the same four numbers again, a few columns to the right. HR
// spotted it on the emailed copy.
//
// The duplication was worse than untidy. The two blocks count in two separate
// loops, computeAttendanceSummary and policyRowsFor, so a change to either one
// alone would have had a row reporting one figure two different ways in the
// same line — the exact failure the "one function per domain concept" rule
// exists to stop, and the one that made the Attendance Sheet and the
// Encashment Report disagree about EL before this.
//
// So this asserts both halves: the four are gone, and every column that
// remains still lines up with its heading.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({attendanceSheetCsv, computeAttendanceSummary, policyRowsFor,' +
  ' datesBetween_, resolvedAttendanceCode_})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

// A month with one of everything, so the four figures are non-zero and a
// duplicate would actually be visible rather than 0 == 0.
const employees = [
  { id: '1', seqNo: 1, name: 'Sanjeev Srivastav', salaryHeading: 'junior', ratePay: 18710,
    employeeType: 'office', doj: '2022-04-01', employmentStatus: 'active', pfEligible: 'yes' },
  { id: '2', seqNo: 2, name: 'Malti Shinde', salaryHeading: 'apprentice', ratePay: 19000,
    employeeType: 'office', doj: '2023-07-01', employmentStatus: 'active', pfEligible: 'no' }
];
const dateList = L.datesBetween_('2026-08-01', '2026-08-31');
const holidayMap = { '2026-08-15': true };
const att = { '1': {}, '2': {} };
dateList.forEach(d => {
  att['1'][d] = { code: 'P', checkinTime: '09:20', checkoutTime: '18:30' };
  att['2'][d] = { code: 'P', checkinTime: '09:20', checkoutTime: '18:30' };
});
// Sanjeev: 3 late arrivals, 2 short leaves, a sick day, a half sick day,
// a half EL and a half unpaid day — every counter above zero, and two of them
// at .5 so a whole-number-only bug would show.
['2026-08-04', '2026-08-05', '2026-08-06'].forEach(d => { att['1'][d].lateFlag = true; });
att['1']['2026-08-07'] = { code: 'SHORT' };
att['1']['2026-08-10'] = { code: 'SHORT' };
att['1']['2026-08-11'] = { code: 'SL' };
att['1']['2026-08-12'] = { code: 'HSL' };
att['1']['2026-08-13'] = { code: 'HEL' };
att['1']['2026-08-14'] = { code: 'HLP' };
att['2']['2026-08-18'] = { code: 'SL' };

const built = L.attendanceSheetCsv(employees, att, dateList, holidayMap);

console.log('the four repeated columns are gone from the emailed sheet\n');
['Late Count', 'Short Leaves', 'Half Days', 'Sick Used'].forEach(h => {
  check('no "' + h + '" column', built.header.indexOf(h), -1);
});

console.log('\nbut what they repeated is still reported, once\n');
['Late', 'Short', 'Half', 'SL'].forEach(h => {
  check('"' + h + '" is still there', built.header.indexOf(h) >= 0, true);
  check('  and appears exactly once', built.header.filter(c => c === h).length, 1);
});
check('Sick Balance survives — it is not a duplicate of anything',
      built.header.indexOf('Sick Balance') >= 0, true);

console.log('\nno heading is repeated anywhere in the row\n');
const dupes = built.header.filter((h, i) => typeof h === 'string' && built.header.indexOf(h) !== i);
check('duplicate headings', dupes, []);

console.log('\nevery row is exactly as wide as the header\n');
check('header width', built.rows.every(r => r.length === built.header.length), true);
console.log('       ' + built.header.length + ' columns, ' + built.rows.length + ' rows');

console.log('\nthe figures that remain are the ones the screen shows\n');
// The on-screen table renders computeAttendanceSummary directly, so the CSV's
// summary block has to agree with it or the emailed sheet and the screen
// disagree about the same month.
const at = h => built.header.indexOf(h);
employees.forEach((emp, i) => {
  const s = L.computeAttendanceSummary(att[emp.id], emp, dateList, holidayMap);
  const row = built.rows[i];
  [['Present', s.present], ['Absent', s.absent], ['EL', s.elUsed], ['SL', s.slUsed],
   ['LP', s.lpDays], ['Half', s.halfDays], ['Short', s.shortCount], ['Late', s.lateCount],
   ['Policy Cut', s.policyCut]].forEach(([h, v]) => {
    check(emp.name + ' — ' + h, row[at(h)], v);
  });
});

console.log('\nand the policy block still lines up with its own headings\n');
const p = L.policyRowsFor(employees, att, dateList, holidayMap)[0];
const row0 = built.rows[0];
check('Employee Type', row0[at('Employee Type')], 'Full-time');
check('Sick Balance', row0[at('Sick Balance')], p.bal.sickLeft);
check('PL Used', row0[at('PL Used')], p.plUsed);
check('LWP', row0[at('LWP')], p.lwp);
check('Attendance Days', row0[at('Attendance Days')], p.attendanceDays);
check('Sandwich Days', row0[at('Sandwich Days')], p.sandwichDays || 0);
check('Early Leaving Days', row0[at('Early Leaving Days')], p.earlyDays || 0);
check('Violation Reason is the last column',
      at('Violation Reason'), built.header.length - 1);
check('  and it is filled in', typeof row0[at('Violation Reason')] === 'string' &&
      row0[at('Violation Reason')].length > 0, true);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
