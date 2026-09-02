// A printed sheet has to add up as printed.
//
// Totals used to be the rounded sum of full-precision figures, so a column
// could total something other than the numbers above it. Ten columns did on the
// August 2026 Salary Sheet, and Hastrak Dave's wage-register row printed
// 25,080 − 1,705 = 23,376 — a row contradicting itself in front of the
// consultant, whose own register has never had a row that does not add up.
//
// It is not cosmetic. A statutory challan has to equal the sum of the
// per-member amounts filed, so a total that is a rupee off its own column is a
// return that will not reconcile. This asserts the rule everywhere it applies:
// every subtotal is the sum of the rows above it, and every row adds up.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({salarySheetCsv, SALARY_SHEET_COLS, wageRegisterRows,' +
  ' WAGE_REGISTER_COLS, consultantReportEmployees, consultantSummaryTotals,' +
  ' consultantSummaryEmployees, consultantSummaryCsv, employeesInSequence, computeEsi})', sb);

const monthDays = 31;
const dateList = [];
for (let d = 1; d <= monthDays; d++) dateList.push('2026-08-' + String(d).padStart(2, '0'));
const holidayMap = { '2026-08-28': true };
const workDates = dateList.filter(d => new Date(d + 'T00:00:00').getDay() !== 0 && !holidayMap[d]);

// Wages picked to land on awkward halves — a 65/35 split of 42,330 is
// 27,514.50 and 14,815.50, and a month's proration of 29,165 over 30 of 31
// days is 28,224.19. Those are the cases a rounded-total sheet gets wrong.
const mk = (id, name, heading, pay, extra) => Object.assign({
  id, name, designation: 'Engineer', employmentStatus: 'active', employeeType: 'office',
  salaryHeading: heading, ratePay: pay, doj: '2020-01-01', dob: '1990-01-01',
  uan: '10205761276' + id, esiNumber: '381301310' + id, bankName: 'HDFC',
  accountNumber: '00' + id + '9876', ifsc: 'HDFC0001', pfEligible: 'yes', esiEligible: 'yes',
  pfContributionType: 'percent', elOpening: 7, slOpening: 7, leaveOpeningFrom: '2026-04-01'
}, extra || {});
const EMPS = [
  mk('1', 'Half Rupee Split', 'managerial', 42330),
  mk('2', 'Awkward Proration', 'senior', 29165),
  mk('3', 'ESI Covered', 'junior', 18408),
  mk('4', 'ESI Covered Two', 'junior', 16728),
  mk('5', 'Conveyance', 'junior', 28980, { conveyance: 2878 }),
  mk('6', 'Loan And Advance', 'senior', 26810, {
    loans: [{ id: 'L1', amount: 60000, instalment: 6000, startMonth: '2026-04', status: 'active' }],
    advances: [{ id: 'A1', month: '2026-08', amount: 200, type: 'temp' }] }),
];
const ATT = {};
EMPS.forEach(e => { ATT[e.id] = {}; workDates.forEach(d => { ATT[e.id][d] = { code: 'P' }; }); });
// One absent day, so the proration lands on a fraction.
ATT['2']['2026-08-12'] = { code: 'A' };

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};
const n = v => Number(v) || 0;

console.log('the Salary Sheet: every subtotal is the sum of its own rows\n');
const sheet = L.salarySheetCsv(L.employeesInSequence(EMPS), ATT, dateList, monthDays, holidayMap);
const S = {}; L.SALARY_SHEET_COLS.forEach((h, i) => { S[h] = i; });
const MONEY = ['Rate of Pay','Leave Amount','Basic','HRA','LTA','Gross','PF','ESI','PT',
  'Advance Temp','Advance','Loan EMI','Retention','Total Deduction','Consultant Salary',
  'Conveyance','Paid Directly','Net Salary','PEN','Employer PF','PF Admin','EDLI',
  'ESI Employer','Employer Cont.','CTC'];
let acc = null, mismatched = [];
sheet.rows.forEach(row => {
  const isEmp = row.length === L.SALARY_SHEET_COLS.length && typeof row[S['SR NO']] === 'number';
  const isTot = row.length === L.SALARY_SHEET_COLS.length && row[S['SR NO']] === '' &&
                /Subtotal|Total/.test(String(row[S['Name']]));
  if (row.length === 1) { acc = {}; MONEY.forEach(k => { acc[k] = 0; }); return; }
  if (isEmp && acc) MONEY.forEach(k => { acc[k] += n(row[S[k]]); });
  if (isTot && acc && String(row[S['Name']]) === 'Subtotal') {
    MONEY.forEach(k => {
      if (Math.abs(acc[k] - n(row[S[k]])) > 0.001) {
        mismatched.push(k + ': rows ' + acc[k] + ', subtotal ' + n(row[S[k]]));
      }
    });
    acc = null;
  }
});
check('no subtotal column differs from the rows above it', mismatched, []);

console.log('\nthe Salary Sheet: every row adds up as printed\n');
const rowBad = [];
sheet.rows.forEach(row => {
  if (row.length !== L.SALARY_SHEET_COLS.length || typeof row[S['SR NO']] !== 'number') return;
  const name = row[S['Name']];
  const dedu = ['PF','ESI','PT','Advance Temp','Advance','Loan EMI','Retention']
    .reduce((t, k) => t + n(row[S[k]]), 0);
  if (dedu !== n(row[S['Total Deduction']]))
    rowBad.push(name + ' deductions ' + dedu + ' vs ' + n(row[S['Total Deduction']]));
  if (n(row[S['Gross']]) - n(row[S['Total Deduction']]) !== n(row[S['Consultant Salary']]))
    rowBad.push(name + ' gross less deductions is not Consultant Salary');
  if (n(row[S['Consultant Salary']]) + n(row[S['Conveyance']]) - n(row[S['Paid Directly']])
      !== n(row[S['Net Salary']]))
    rowBad.push(name + ' Net Salary does not follow from the row');
});
check('no row contradicts itself', rowBad, []);

console.log('\nthe wage register: same rule, and its grand total\n');
const reg = L.wageRegisterRows(L.consultantReportEmployees(L.employeesInSequence(EMPS), dateList),
                               ATT, dateList, monthDays, holidayMap, 2026, 8);
const C = {}; L.WAGE_REGISTER_COLS.forEach((h, i) => { C[h] = i; });
const regBad = [];
reg.rows.forEach(r => {
  if (n(r[C['Gross Earni.']]) - n(r[C['Gross Dedu.']]) !== n(r[C['Net Salary']])) {
    regBad.push(r[C['Emp Name']]);
  }
});
check('every register row adds up', regBad, []);
const totBad = [];
['Basic','HRA','LTA','P.F.','P.T.','Loan','Adv','E.S.I.','Gross Earni.','Gross Dedu.','Net Salary']
  .forEach(k => {
    const sum = reg.rows.reduce((t, r) => t + n(r[C[k]]), 0);
    if (sum !== n(reg.total[C[k]])) totBad.push(k + ': rows ' + sum + ', total ' + n(reg.total[C[k]]));
  });
check('every register total is the sum of its rows', totBad, []);

console.log('\nESI is raised to the next rupee, per member, the way ESIC files it\n');
const esiCases = [[18408, 139, 599], [16728, 126, 544], [20000, 150, 650]];
esiCases.forEach(([gross, wantEmp, wantEr]) => {
  const r = L.computeEsi(gross, { eligible: true, asOf: '2026-08-01' });
  check('gross ' + gross + ' → employee', r.employee, wantEmp);
  check('gross ' + gross + ' → employer', r.employer, wantEr);
});

console.log('\nthe Consultant Final Summary: its lines add up to its own totals\n');
const T = L.consultantSummaryTotals(L.consultantSummaryEmployees(L.employeesInSequence(EMPS), dateList),
                                    ATT, dateList, monthDays, holidayMap);
const csv = L.consultantSummaryCsv(T);
const amt = item => { const r = csv.rows.find(x => x[1] === item); return r ? n(r[2]) : null; };
check('Account No 1 is employee share plus employer EPF share',
      amt('P.F. Account No 1 — Employee share') + amt('P.F. Account No 1 — Employer EPF share'),
      amt('P.F. Account No 1'));
check('Total P.F. is the five accounts',
      amt('P.F. Account No 1') + amt('P.F. Account No 2') + amt('P.F. Account No 10') +
      amt('P.F. Account No 21') + amt('P.F. Account No 22'),
      amt('Total P.F.'));
check('the ESI total is employee plus employer',
      amt('Employee Contribution') + amt('Employer Contribution'),
      csv.rows.find(r => r[0] === 'ESI Summary' && r[1] === 'Total')[2]);
const alw = csv.rows.filter(r => r[0] === 'Allowance' && r[1] !== 'Total');
check('the Allowance total is its own heads',
      alw.reduce((t, r) => t + n(r[2]), 0),
      csv.rows.find(r => r[0] === 'Allowance' && r[1] === 'Total')[2]);
const ded = csv.rows.filter(r => r[0] === 'Deduction' && r[1] !== 'Total Deduction');
check('the Deduction total is its own heads',
      ded.reduce((t, r) => t + n(r[2]), 0), amt('Total Deduction'));
// The line that started this: our Total Wages was everyone's Basic, sitting
// directly above a contribution charged on the capped wage, so 12% of the
// printed wage was 23,716 against the 22,160 actually filed. Both lines are
// printed now, and this asserts the PF rests on the right one.
console.log('\nthe PF lines follow from the wage line printed above them\n');
const empShare = amt('P.F. Account No 1 — Employee share');
const epfWage = amt('EPF Wages (what PF is charged on)');
const totalWage = amt('Total Wages');
console.log('  Total Wages ' + totalWage + ' (Basic earned) · EPF Wages ' + epfWage +
            ' (charged on) · employee share ' + empShare);
check('EPF Wages is never above Basic earned', epfWage <= totalWage, true);
check('the employee share is 12% of EPF Wages, to the rupee',
      Math.abs(empShare - epfWage * 0.12) <= 2, true);
// Somebody above the ceiling has to be in the fixture, or the two wage lines
// would be equal and this would prove nothing.
check('and the two lines genuinely differ, so the check has something to catch',
      epfWage < totalWage, true);

check('Net is the Allowance total less the Deduction total',
      csv.rows.find(r => r[0] === 'Allowance' && r[1] === 'Total')[2] - amt('Total Deduction'),
      csv.rows.find(r => r[0] === 'Net')[2]);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
