// The central sequence, wired up: does every surface actually follow it, does
// SR NO carry the central number, and is payroll genuinely untouched?
//
// The claim being tested is the strong one HR asked for — that reports follow
// the sequence WITHOUT each one being taught about it. So this changes only the
// seqNo values and then re-runs every report builder, asserting the order moved
// with them and that not one figure did.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const PICK = '(function(){var o={};' +
  'o.inSeq=employeesInSequence;o.reseq=resequenceEmployees;o.seqOf=seqNoOf;' +
  'o.salary=salarySheetCsv;o.finalSal=finalSalarySheetCsv;o.att=attendanceSheetCsv;' +
  'o.stat=statutoryReportData;o.pf=pfReturnCsv;o.esi=esiReturnCsv;' +
  'o.consultEmps=consultantReportEmployees;o.consult=consultantReportRows;' +
  'o.cCols=CONSULTANT_REPORT_COLS;o.sCols=SALARY_SHEET_COLS;o.sal1=computeSalaryFromAttendance;' +
  'return o;})();';
function load() {
  const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
               Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
  return vm.runInContext(PICK, sb);
}
const L = load();

const DAYS = 31;
const dateList = [];
for (let d = 1; d <= DAYS; d++) dateList.push('2026-08-' + String(d).padStart(2, '0'));
const holidayMap = { '2026-08-28': true };
const workDates = dateList.filter(d =>
  new Date(d + 'T00:00:00').getDay() !== 0 && !holidayMap[d]);

const mk = (id, name, heading, seq) => ({
  id, name, designation: 'Engineer', employmentStatus: 'active', employeeType: 'office',
  salaryHeading: heading, ratePay: 30000, doj: '2020-01-01', dob: '1990-01-01',
  uan: '10205761276' + id, esiNumber: '381301310' + id, bankName: 'HDFC',
  accountNumber: '00' + id + '9876', ifsc: 'HDFC0001',
  pfEligible: 'yes', esiEligible: 'yes', pfContributionType: 'percent',
  elOpening: 7, slOpening: 7, leaveOpeningFrom: '2026-04-01', seqNo: seq
});
// Deliberately across headings, and deliberately NOT in sequence order in the
// source array, so any surface that just iterates what it is given would fail.
const EMPS = [
  mk('5', 'Eknath', 'junior', 5),
  mk('1', 'Anil', 'managerial', 1),
  mk('4', 'Devi', 'senior', 4),
  mk('2', 'Bharat', 'managerial', 2),
  mk('3', 'Chetan', 'senior', 3),
];
const ATT = {};
EMPS.forEach(e => { ATT[e.id] = {}; workDates.forEach(d => ATT[e.id][d] = { code: 'P' }); });

const fails = [];
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

// What each report lists, in the order it lists them.
function surfaces(emps) {
  const ordered = L.inSeq(emps);
  const salary = L.salary(ordered, ATT, dateList, DAYS, holidayMap);
  const iName = L.sCols.indexOf('Name'), iSr = L.sCols.indexOf('SR NO');
  const salaryRows = salary.rows.filter(r => r.length === L.sCols.length && typeof r[iSr] === 'number');
  const attCsv = L.att(ordered, ATT, dateList, holidayMap);
  const pfData = L.stat(ordered, ATT, dateList, DAYS, holidayMap, 'pf');
  const pfCsv = L.pf(pfData.pfRows, pfData.pfTot, pfData.pfExcluded);
  const iPfName = pfCsv.header.indexOf('Employee');
  const cBuilt = L.consult(L.consultEmps(ordered, dateList), ATT, dateList, DAYS, holidayMap, 2026, 8);
  const iCName = L.cCols.indexOf('EmpName'), iCSr = L.cCols.indexOf('SR NO');
  const finalSal = L.finalSal(ordered, ATT, dateList, DAYS, holidayMap);
  return {
    salaryNames: salaryRows.map(r => r[iName]),
    salarySr: salaryRows.map(r => r[iSr]),
    attNames: attCsv.rows.map(r => r[1]),
    pfNames: pfCsv.rows.filter(r => r.length > 3 && r[iPfName] && r[iPfName] !== 'GRAND TOTAL').map(r => r[iPfName]),
    pfSr: pfCsv.rows.filter(r => r.length > 3 && r[iPfName] && r[iPfName] !== 'GRAND TOTAL').map(r => r[0]),
    consultNames: cBuilt.rows.map(r => r[iCName]),
    consultSr: cBuilt.rows.map(r => r[iCSr]),
    finalSalSr: finalSal.rows.filter(r => typeof r[0] === 'number').map(r => r[0])
  };
}

console.log('as stored: 1 Anil, 2 Bharat, 3 Chetan, 4 Devi, 5 Eknath\n');
let v = surfaces(EMPS);
console.log('  Salary Sheet    : ' + v.salaryNames.map((n, i) => v.salarySr[i] + '.' + n).join('  '));
console.log('  Attendance Sheet: ' + v.attNames.join(', '));
console.log('  PF Return       : ' + v.pfNames.map((n, i) => v.pfSr[i] + '.' + n).join('  '));
console.log('  Consultant      : ' + v.consultNames.map((n, i) => v.consultSr[i] + '.' + n).join('  '));
console.log('');
// Grouped by heading, and in sequence order inside each group.
eq('Salary Sheet groups by heading, sequence order inside each',
   v.salaryNames, ['Anil', 'Bharat', 'Chetan', 'Devi', 'Eknath']);
eq('and SR NO is the central number, not a running count', v.salarySr, [1, 2, 3, 4, 5]);
eq('the Attendance Sheet follows the sequence', v.attNames, ['Anil','Bharat','Chetan','Devi','Eknath']);
eq('the PF Return does too, with central SR NO', v.pfSr, [1, 2, 3, 4, 5]);
// All five here are on own-payroll headings, so the Consultant Report covers
// all of them; it drops Apprentices, R.S.IT and Contractors, which this fixture
// deliberately has none of.
eq('and the Consultant Report', v.consultSr, [1, 2, 3, 4, 5]);

console.log('\nnow move Eknath from 5 to 1 — nothing else is touched\n');
const moved = L.reseq(EMPS, '5', 1);
console.log('  ' + L.inSeq(moved).map(e => L.seqOf(e) + '.' + e.name).join('  '));
const v2 = surfaces(moved);
console.log('  Salary Sheet    : ' + v2.salaryNames.map((n, i) => v2.salarySr[i] + '.' + n).join('  '));
console.log('  Attendance Sheet: ' + v2.attNames.join(', '));
console.log('  PF Return       : ' + v2.pfNames.map((n, i) => v2.pfSr[i] + '.' + n).join('  '));
console.log('  Consultant      : ' + v2.consultNames.map((n, i) => v2.consultSr[i] + '.' + n).join('  '));
console.log('');
// Eknath is Junior, so inside the Salary Sheet he stays in the Junior group —
// but his NUMBER is now 1 and everyone else's shifted.
eq('Eknath is now number 1', L.seqOf(moved.find(e => e.id === '5')), 1);
eq('everyone else moved down one',
   ['1','2','3','4'].map(id => L.seqOf(moved.find(e => e.id === id))), [2, 3, 4, 5]);
eq('the Attendance Sheet re-ordered on its own', v2.attNames, ['Eknath','Anil','Bharat','Chetan','Devi']);
eq('the Salary Sheet keeps its heading groups', v2.salaryNames, ['Anil','Bharat','Chetan','Devi','Eknath']);
eq('but its SR NO now shows the new numbers', v2.salarySr, [2, 3, 4, 5, 1]);
eq('the PF Return numbers moved with them', v2.pfSr, [2, 3, 4, 5, 1]);
eq('the accountant file carries central numbers too, in bank order',
   v2.finalSalSr.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5]);

console.log('\nnot one figure moves when the order does\n');
const before = {}, after = {};
EMPS.forEach(e => { before[e.id] = L.sal1(e, ATT[e.id], dateList, DAYS, holidayMap); });
moved.forEach(e => { after[e.id] = L.sal1(e, ATT[e.id], dateList, DAYS, holidayMap); });
let drift = 0;
Object.keys(before).forEach(id => {
  const a = JSON.stringify(before[id]), b = JSON.stringify(after[id]);
  if (a !== b) { drift++; console.log('    ' + id + ' changed'); }
});
eq('every employee’s whole salary object is identical', drift, 0);
// And the sheet's totals, which is what anybody would actually notice.
const salBefore = L.salary(L.inSeq(EMPS), ATT, dateList, DAYS, holidayMap);
const salAfter = L.salary(L.inSeq(moved), ATT, dateList, DAYS, holidayMap);
const grandOf = built => built.rows.find(r => r[1] === 'Grand Total');
eq('the Salary Sheet Grand Total is unchanged',
   JSON.stringify(grandOf(salAfter).slice(2)), JSON.stringify(grandOf(salBefore).slice(2)));

console.log('\na roster where nobody has been numbered yet still works\n');
const UNNUMBERED = EMPS.map(e => { const c = Object.assign({}, e); delete c.seqNo; return c; });
const v3 = surfaces(UNNUMBERED);
console.log('  Attendance Sheet: ' + v3.attNames.join(', '));
eq('it falls back to name order, not to nothing', v3.attNames,
   ['Anil','Bharat','Chetan','Devi','Eknath']);
eq('and every report still builds', v3.salaryNames.length, 5);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
