// The PF Return and the Consultant Final Summary must state ONE figure for
// each PF account head.
//
// They did not. Both are emailed each month, and HR read them side by side:
// Account 2, Account 10, Account 21 and the PF grand total each differed by a
// rupee or two. Neither had a bug in its arithmetic — they rounded in
// different places. The PF Return accumulated at full precision and rounded
// its total once; the Consultant Final Summary rounded every member first and
// added the rounded amounts, which is what a challan is. Both defensible, both
// on the same statutory filing, differing.
//
// HR chose the PF Return's figure, so the Consultant Final Summary now
// accumulates the same way. This asserts they land on the same number for
// every account, and — separately — that each sheet still adds up to its own
// printed totals, because the first attempt at this fix bought agreement
// between the reports at the cost of the Consultant Final Summary no longer
// summing to itself.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({statutoryReportData, pfReturnCsv, consultantSummaryEmployees,' +
  ' consultantSummaryTotals, consultantSummaryCsv, employeesInSequence, datesBetween_})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

// Basics chosen to land on awkward paise — half the point is the rounding, so
// a fixture of round numbers would prove nothing. Several sit above the
// ₹15,000 EPS ceiling and several below it, so both branches of the EPS and
// EDLI caps are exercised.
const RATES = [39215, 44090, 42330, 29165, 27200, 31400, 28766, 34258, 26810,
               28980, 27827, 29328, 18710, 16728, 24000, 24400, 23100, 20000];
const employees = RATES.map((r, i) => ({
  id: String(i + 1), seqNo: i + 1, name: 'Member ' + (i + 1),
  salaryHeading: i < 5 ? 'managerial' : i < 9 ? 'senior' : 'junior',
  ratePay: r, employeeType: 'office', doj: '2022-04-01',
  employmentStatus: 'active', pfEligible: 'yes', pfContributionType: 'percent'
}));
const dateList = L.datesBetween_('2026-08-01', '2026-08-31');
const holidayMap = { '2026-08-15': true };
const att = {};
employees.forEach(e => {
  att[e.id] = {};
  dateList.forEach(d => { att[e.id][d] = { code: 'P', checkinTime: '09:20', checkoutTime: '18:30' }; });
});
// A couple of unpaid days on one member, so at least one PF wage is not a
// whole month and its contributions carry paise.
att['4']['2026-08-06'] = { code: 'LP' };
att['7']['2026-08-11'] = { code: 'HLP' };

const monthDays = dateList.length;
const d = L.statutoryReportData(employees, att, dateList, monthDays, holidayMap, 'pf');
const pfCsv = L.pfReturnCsv(d.pfRows, d.pfTot);
const T = L.consultantSummaryTotals(
  L.consultantSummaryEmployees(L.employeesInSequence(employees), dateList),
  att, dateList, monthDays, holidayMap);
const sumCsv = L.consultantSummaryCsv(T);

const n = v => Number(String(v).replace(/[^0-9.\-]/g, '')) || 0;
const summaryAmt = item => {
  const r = sumCsv.rows.find(x => x[1] === item);
  return r ? n(r[2]) : null;
};
const grand = pfCsv.rows.find(r => r[1] === 'GRAND TOTAL');
const pfAt = heading => n(grand[pfCsv.header.indexOf(heading)]);

console.log(d.pfRows.filter(r => r.applicable).length + ' contributing members\n');
console.log('the two emailed reports state the same figure for every account\n');
[['Employee + Employer EPF (PF Account 1)', 'P.F. Account No 1'],
 ['Employer EPS (PF Account 10)',           'P.F. Account No 10'],
 ['EDLI (PF Account 21)',                   'P.F. Account No 21'],
 ['Admin Charges (PF Account 2)',           'P.F. Account No 2']].forEach(([pfHead, sumHead]) => {
  const a = pfAt(pfHead), b = summaryAmt(sumHead);
  console.log('       ' + sumHead.padEnd(20) + 'PF Return ' + String(a).padStart(8) +
              '   Summary ' + String(b).padStart(8));
  check(sumHead + ' agrees', b, a);
});

console.log('\nand so do the wage lines the contributions rest on\n');
check('Total Wages agrees', summaryAmt('Total Wages'), pfAt('Final Payable Basic'));

console.log('\neach sheet still adds up to its own printed totals\n');
// The Consultant Final Summary: Total P.F. is the five account lines above it.
const five = ['P.F. Account No 1', 'P.F. Account No 2', 'P.F. Account No 10',
              'P.F. Account No 21', 'P.F. Account No 22'].reduce((t, h) => t + summaryAmt(h), 0);
check('Summary: Total P.F. is its five accounts', five, summaryAmt('Total P.F.'));
check('Summary: Account 1 is the employee and employer shares',
      summaryAmt('P.F. Account No 1 — Employee share') +
      summaryAmt('P.F. Account No 1 — Employer EPF share'),
      summaryAmt('P.F. Account No 1'));

// The PF Return: its GRAND TOTAL row against its own account columns.
const returnFive = pfAt('Employee + Employer EPF (PF Account 1)') +
  pfAt('Employer EPS (PF Account 10)') + pfAt('EDLI (PF Account 21)') +
  pfAt('Admin Charges (PF Account 2)');
console.log('       PF Return: its four accounts add to ' + returnFive +
            ', its Grand Total prints ' + pfAt('Grand Total'));
check('PF Return: Grand Total is its own accounts', returnFive, pfAt('Grand Total'));

console.log('\nthe grand totals on the two reports match\n');
check('grand total agrees', summaryAmt('Total P.F.'), pfAt('Grand Total'));

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
