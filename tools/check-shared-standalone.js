// shared/report-logic.js has to work on its own.
//
// In the browser it is loaded alongside index.html and the two share one
// global scope, so a function left behind in index.html — or a config value
// mutated there after declaration — still resolves and everything looks fine.
// Apps Script evaluates ONLY this file, and there the same gap is a
// ReferenceError at 8 AM on the 1st with nobody watching.
//
// This evaluates the file alone, in a scope with nothing but the JavaScript
// built-ins, and actually runs every report builder over a small fixture. It
// is the check that catches "works in the app, breaks in the email".
//
//   node tools/check-shared-standalone.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'report-logic.js'), 'utf8');

// Deliberately bare: no document, no window, no fetch, no localStorage. If the
// file reaches for any of them this throws, which is the point.
const sandbox = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
                  Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sandbox);

const EXPORTS = ['computeSalaryFromAttendance','computeAttendanceSummary','LEAVE_DETAIL_METRICS',
  'resolvedAttendanceCode_','loansOf','loanBalanceAfter','loanEmiRateAsOf','computeLoanEmiForMonth',
  'loanBalanceAfterMonth','advanceBalanceAfterMonth','salaryAdvanceForMonth','advanceTempForMonth',
  'diwaliBonusFor','monthlyPayFor','financialYearLabel','calculatePfFor','computeEsi','monthlyPtFor',
  'ratePayAsOf','SALARY_HEADINGS','PF_RULES','ESI_RULES','LEAVE_POLICY','leaveWorkingDays',
  'applyAlwaysPresentFill','leaveDetailRowFor','leaveDetailReportRows','leaveDetailCsvHeader',
  'leaveDetailCsvRows','loanLedgerRows','loanLedgerCsvHeader','loanLedgerCsvRows',
  'loanLedgerTotals','loanLedgerCsvTotalRow',
  'employedDuringPeriod_','salarySheetCsv','finalSalarySheetCsv','attendanceSheetCsv',
  'statutoryReportData','pfReturnCsv','esiReturnCsv','statutoryAmountCsv','policyRowsFor','evaluateAttendanceDay','minToHHMM',
  'attCodeText_','SALARY_HEADING_ORDER','consultantReportEmployees','consultantReportRows',
  'consultantSummaryEmployees','consultantSummaryTotals','consultantSummaryCsv',
  'consultantCsvRows','excelIdNumber',
  'WAGE_REGISTER_COLS','wageRegisterRows','wageRegisterCsvRows'];

let box;
try {
  box = vm.runInContext(
    src + '\n;(function(){ var o = {};' +
    EXPORTS.map(n => 'try{ o[' + JSON.stringify(n) + '] = ' + n + '; }catch(e){}').join('') +
    'return o; })();', sandbox, { filename: 'shared/report-logic.js' });
} catch (e) {
  console.error('shared/report-logic.js does not even evaluate on its own:\n  ' + e.message);
  process.exit(1);
}

const problems = [];
EXPORTS.forEach(n => { if (box[n] === undefined) problems.push('missing export: ' + n); });

// A fixture exercising every heading, the codes that change an answer, a loan
// with a mid-loan EMI change, an advance, retention, and an Always-Present
// employee with no attendance at all.
const HEADINGS = ['managerial', 'senior', 'junior', 'apprentices', 'rsit', 'contractors'];
const employees = HEADINGS.map((h, i) => ({
  id: 'T' + i, name: 'T' + i, employmentStatus: 'active',
  employeeType: ['office', 'field', 'wfh', 'resident', 'office', 'field'][i],
  salaryHeading: h, ratePay: 15000 + i * 5000, doj: '2020-01-01',
  uan: 'U' + i, esiNumber: 'E' + i, bankName: 'Bank', accountNumber: '1', ifsc: 'IFSC',
  elOpening: 7, slOpening: 7, leaveOpeningFrom: '2026-04-01',
  conveyance: 100 * i, retentionAmount: 100 * i, retentionFrom: '2026-04',
  diwaliEligible: 'yes', diwaliBonusAmount: 1000 * i,
  advanceHistory: [{ month: '2026-07', advance: 100 * i, advanceTemp: 50 * i }],
  loans: i % 2 ? [{ id: 'L', amount: 30000, instalment: 2500, startMonth: '2026-04', status: 'active',
                    emiHistory: [{ from: '2026-04', instalment: 2500 }, { from: '2026-06', instalment: 1500 }] }] : []
}));
employees.push({ id: 'T9', name: 'Always', employmentStatus: 'active', employeeType: 'office',
  salaryHeading: 'managerial', ratePay: 25000, doj: '2020-01-01', alwaysPresentFrom: '2020-01-01',
  elOpening: 7, slOpening: 7, leaveOpeningFrom: '2026-04-01' });

const dateList = [];
for (let d = 1; d <= 31; d++) dateList.push('2026-07-' + String(d).padStart(2, '0'));
const att = {};
employees.filter(e => e.id !== 'T9').forEach(e => {
  att[e.id] = {};
  dateList.forEach(d => { att[e.id][d] = { code: 'P' }; });
  att[e.id]['2026-07-02'] = { code: 'A' };
  att[e.id]['2026-07-03'] = { code: 'LP' };
  att[e.id]['2026-07-06'] = { code: 'EL' };
  att[e.id]['2026-07-07'] = { code: 'HEL' };
  att[e.id]['2026-07-08'] = { code: 'SL' };
  att[e.id]['2026-07-09'] = { code: 'HSL' };
  att[e.id]['2026-07-10'] = { code: 'SHORT' };
  [13, 14, 15, 16, 17, 20, 21].forEach(d => { att[e.id]['2026-07-' + d] = { code: 'P', lateFlag: true }; });
  // Both punches, so the branches that judge a day actually run. Without these
  // policyRowsFor never reached evaluateAttendanceDay, and a helper that lived
  // only in index.html looked fine here right up until the 1st of the month.
  att[e.id]['2026-07-22'] = { code: 'P', checkinTime: '09:45', checkoutTime: '19:30' };  // late in, overtime
  att[e.id]['2026-07-23'] = { code: 'P', checkinTime: '09:20', checkoutTime: '17:00' };  // early out
  att[e.id]['2026-07-24'] = { code: 'P', checkinTime: '09:30', checkoutTime: '19:00' };  // exactly the shift
});
att['T9'] = {};
const holidayMap = { '2026-07-15': true };

const run = (label, fn) => {
  try {
    const out = fn();
    if (out === undefined || out === null) problems.push(label + ' returned nothing');
  } catch (e) {
    problems.push(label + ' threw: ' + e.message);
  }
};

run('applyAlwaysPresentFill', () => box.applyAlwaysPresentFill(att, employees, holidayMap, null, null, '2026-08-01'));
run('computeSalaryFromAttendance', () => box.computeSalaryFromAttendance(employees[0], att['T0'], dateList, 31, holidayMap));
run('salarySheetCsv', () => box.salarySheetCsv(employees, att, dateList, 31, holidayMap));
run('finalSalarySheetCsv', () => box.finalSalarySheetCsv(employees, att, dateList, 31, holidayMap));
run('attendanceSheetCsv', () => box.attendanceSheetCsv(employees, att, dateList, holidayMap));
run('leaveDetailReportRows', () => box.leaveDetailReportRows(employees, att, dateList, holidayMap));
run('leaveDetailCsvRows', () => box.leaveDetailCsvRows(box.leaveDetailReportRows(employees, att, dateList, holidayMap).rows));
run('loanLedgerRows', () => box.loanLedgerRows(employees, 2026, 7));
run('loanLedgerCsvRows', () => box.loanLedgerCsvRows(box.loanLedgerRows(employees, 2026, 7)));
run('loanLedgerTotals', () => box.loanLedgerTotals(box.loanLedgerRows(employees, 2026, 7)));
run('loanLedgerCsvTotalRow', () => box.loanLedgerCsvTotalRow(box.loanLedgerRows(employees, 2026, 7)));
['pf', 'esi', 'pt'].forEach(k => {
  run('statutoryReportData(' + k + ')', () => box.statutoryReportData(employees, att, dateList, 31, holidayMap, k));
});
run('pfReturnCsv', () => {
  const d = box.statutoryReportData(employees, att, dateList, 31, holidayMap, 'pf');
  return box.pfReturnCsv(d.pfRows, d.pfTot);
});
run('esiReturnCsv', () => {
  const d = box.statutoryReportData(employees, att, dateList, 31, holidayMap, 'esi');
  return box.esiReturnCsv(d.esiRows, d.esiTot);
});
run('statutoryAmountCsv', () => {
  const d = box.statutoryReportData(employees, att, dateList, 31, holidayMap, 'pt');
  return box.statutoryAmountCsv(d.rows, d.grandTotal, 'pt');
});
run('policyRowsFor', () => box.policyRowsFor(employees, att, dateList, holidayMap));
run('evaluateAttendanceDay', () => box.evaluateAttendanceDay({ inMin: 585, outMin: 1170 }));
run('consultantReportRows', () => box.consultantReportRows(
  box.consultantReportEmployees(employees, dateList), att, dateList, 31, holidayMap, 2026, 7));
run('consultantCsvRows', () => box.consultantCsvRows(box.consultantReportRows(
  box.consultantReportEmployees(employees, dateList), att, dateList, 31, holidayMap, 2026, 7).rows));
run('consultantSummaryCsv', () => box.consultantSummaryCsv(box.consultantSummaryTotals(
  box.consultantSummaryEmployees(employees, dateList), att, dateList, 31, holidayMap)));
run('wageRegisterRows', () => box.wageRegisterRows(
  box.consultantReportEmployees(employees, dateList), att, dateList, 31, holidayMap, 2026, 7));
run('wageRegisterCsvRows', () => box.wageRegisterCsvRows(box.wageRegisterRows(
  box.consultantReportEmployees(employees, dateList), att, dateList, 31, holidayMap, 2026, 7).rows));

if (problems.length) {
  console.log(problems.map(p => '  ' + p).join('\n'));
  console.log('\n' + problems.length + ' problem(s) — shared/report-logic.js is NOT standalone.');
  console.log('Anything it needs must live in it, not in index.html: the browser hides this,');
  console.log('Apps Script does not.');
  process.exit(1);
}
console.log('shared/report-logic.js is standalone — ' + EXPORTS.length +
            ' exports present, every report builder runs with no browser.');
