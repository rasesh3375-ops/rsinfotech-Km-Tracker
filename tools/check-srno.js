// What the SR NO column actually PRINTS, on an unnumbered roster.
//
// My earlier end-to-end harness checked that an unnumbered roster still sorted
// by name and that every report still built. Both were true, and both missed
// the bug: seqNoOf returns Infinity for somebody with no number, which sorts
// them last correctly and prints the literal word "Infinity". Nobody had been
// numbered yet, so every SR NO on every report read Infinity. The consultant's
// August summary is what found it — not this file, which is the point.
//
// So this asserts the cell contents, on three rosters: nobody numbered, some
// numbered, everybody numbered.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({employeesInSequence, seqNoLabel, seqNoOf,' +
  ' salarySheetCsv, SALARY_SHEET_COLS, finalSalarySheetCsv, attendanceSheetCsv,' +
  ' statutoryReportData, pfReturnCsv, esiReturnCsv, consultantReportRows,' +
  ' consultantReportEmployees, wageRegisterRows, WAGE_REGISTER_COLS})', sb);

const monthDays = 31;
const dateList = [];
for (let d = 1; d <= monthDays; d++) dateList.push('2026-08-' + String(d).padStart(2, '0'));
const holidayMap = { '2026-08-28': true };
const workDates = dateList.filter(d => new Date(d + 'T00:00:00').getDay() !== 0 && !holidayMap[d]);

const mk = (id, name, heading, seq) => {
  const e = { id, name, designation: 'Engineer', employmentStatus: 'active', employeeType: 'office',
    salaryHeading: heading, ratePay: (name === 'Eknath' ? 18000 : 30000), doj: '2020-01-01', dob: '1990-01-01',
    uan: '10205761276' + id, esiNumber: '381301310' + id, bankName: 'HDFC',
    accountNumber: '00' + id + '9876', ifsc: 'HDFC0001', pfEligible: 'yes', esiEligible: 'yes',
    pfContributionType: 'percent', elOpening: 7, slOpening: 7, leaveOpeningFrom: '2026-04-01' };
  if (seq !== undefined) e.seqNo = seq;
  return e;
};
const BASE = [
  ['1', 'Anil',   'managerial'], ['2', 'Bharat', 'managerial'],
  ['3', 'Chetan', 'senior'],     ['4', 'Devi',   'senior'], ['5', 'Eknath', 'junior'],
];
const ATT = {};
BASE.forEach(([id]) => { ATT[id] = {}; workDates.forEach(d => { ATT[id][d] = { code: 'P' }; }); });

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

// Every SR NO cell every report emits, for one roster.
function srNosOf(emps) {
  const ordered = L.employeesInSequence(emps);
  const out = {};
  const sal = L.salarySheetCsv(ordered, ATT, dateList, monthDays, holidayMap);
  const iSr = L.SALARY_SHEET_COLS.indexOf('SR NO');
  out['Salary Sheet'] = sal.rows
    .filter(r => r.length === L.SALARY_SHEET_COLS.length && r[iSr] !== '')
    .map(r => r[iSr]);
  const pfd = L.statutoryReportData(ordered, ATT, dateList, monthDays, holidayMap, 'pf');
  out['PF Return'] = L.pfReturnCsv(pfd.pfRows, pfd.pfTot, pfd.pfExcluded).rows
    .filter(r => r.length > 3 && r[0] !== '').map(r => r[0]);
  const esd = L.statutoryReportData(ordered, ATT, dateList, monthDays, holidayMap, 'esi');
  out['ESI Return'] = L.esiReturnCsv(esd.esiRows, esd.esiTot).rows
    .filter(r => r.length > 3 && r[0] !== '').map(r => r[0]);
  out['Final Salary Sheet'] = L.finalSalarySheetCsv(ordered, ATT, dateList, monthDays, holidayMap).rows
    .filter(r => r.length > 3 && r[0] !== '').map(r => r[0]);
  out['Consultant Report'] = L.consultantReportRows(
    L.consultantReportEmployees(ordered, dateList), ATT, dateList, monthDays, holidayMap, 2026, 8)
    .rows.map(r => r[0]);
  out['Wage Register'] = L.wageRegisterRows(
    L.consultantReportEmployees(ordered, dateList), ATT, dateList, monthDays, holidayMap, 2026, 8)
    .rows.map(r => r[0]);
  return out;
}

function report(title, emps, expectSet) {
  console.log('\n' + title + '\n');
  const all = srNosOf(emps);
  Object.keys(all).forEach(k => {
    console.log('  ' + k.padEnd(20) + all[k].join(', '));
  });
  console.log('');
  const bad = [];
  Object.keys(all).forEach(k => {
    all[k].forEach(v => {
      if (!isFinite(Number(v)) || String(v) === 'Infinity') bad.push(k + ':' + v);
    });
  });
  check('no SR NO anywhere is Infinity or blank', bad, []);
  if (expectSet) {
    Object.keys(expectSet).forEach(k => check('  ' + k, all[k], expectSet[k]));
  }
  return all;
}

// 1. Nobody numbered — the live state the day the sequence shipped.
report('nobody has been given a number yet (the state that broke)',
  BASE.map(([id, n, h]) => mk(id, n, h)),
  {
    'Salary Sheet': [1, 2, 3, 4, 5],
    'Wage Register': [1, 2, 3, 4, 5],
    'Consultant Report': [1, 2, 3, 4, 5]
  });

// 2. Everybody numbered, deliberately not in name order.
report('HR has numbered the roster — the number wins over position',
  [mk('1','Anil','managerial',5), mk('2','Bharat','managerial',4),
   mk('3','Chetan','senior',3),   mk('4','Devi','senior',2), mk('5','Eknath','junior',1)],
  {
    // Ordered by seqNo: Eknath(1), Devi(2), Chetan(3), Bharat(4), Anil(5).
    // The Salary Sheet groups by heading, so its rows come out
    // Managerial (Bharat 4, Anil 5), Seniors (Devi 2, Chetan 3), Junior (Eknath 1).
    'Salary Sheet': [4, 5, 2, 3, 1],
    'Wage Register': [1, 2, 3, 4, 5],
    'Consultant Report': [1, 2, 3, 4, 5]
  });

// 3. Half numbered — a new joiner before HR gets to them.
report('a half-numbered roster reads sensibly rather than mixing numbers and blanks',
  [mk('1','Anil','managerial',1), mk('2','Bharat','managerial',2),
   mk('3','Chetan','senior'),     mk('4','Devi','senior'), mk('5','Eknath','junior')]);

console.log('\nthe helper itself\n');
check('a numbered employee prints their number', L.seqNoLabel({ seqNo: 7 }, 3), 7);
check('an unnumbered one prints the position given', L.seqNoLabel({}, 3), 3);
check('and 0 is treated as unset, not as a real number', L.seqNoLabel({ seqNo: 0 }, 9), 9);
check('sorting is unchanged — unnumbered still sorts last', L.seqNoOf({}) === Infinity, true);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
