// A finalised month does not move, whatever is edited afterwards.
//
// Eighteen fields on the employee record have no dated history — conveyance,
// other allowances, retention, the direct-paid amount, the advance opening,
// the Diwali bonus, a loan's amount / start month / status / skipped months,
// PF eligibility and contribution type, prior UAN, Form 11, ESI eligibility,
// disability and covered-at-period-start, PT paid this year, the EL and SL
// openings, employee type, always-present-from and employment status. Editing
// any of them restated every month that employee had ever been paid, so a
// Salary Sheet for a month closed six months ago quietly stopped matching what
// had left the bank.
//
// Finalising the month is the one mechanism that covers all of them, and
// covers the nineteenth field somebody adds next year without it being taught
// about locks. This check is what says so: it locks July, then edits every one
// of those fields — and the attendance underneath — and asserts July has not
// moved by a rupee, while August, still open, moves as it should.
//
//   node tools/check-payroll-lock.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({buildPayrollLock,payrollLockPack,payrollLockUnpack,payrollLockKey,' +
  'setPayrollLocks,isPayrollMonthLocked,computeSalaryFromAttendance,salarySheetCsv,' +
  'statutoryReportData,PAYROLL_LOCK_MAX_CHARS,PAYROLL_LOCK_INDEX_KEY})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const EMP = () => ({
  id: '8', name: 'Hardikbhai Parmar', employmentStatus: 'active', employeeType: 'field',
  doj: '2020-01-01', salaryHeading: 'senior', ratePay: 28000,
  pfEligible: 'yes', pfContributionType: 'percent', hasPriorUan: 'yes', form11Submitted: 'yes',
  esiEligible: 'no', elOpening: 7, slOpening: 7, leaveOpeningFrom: '2026-04-01',
  conveyance: 500, otherAllowances: 1000,
  retentionMoney: 24000, retentionMonths: 12, bondStart: '2026-04-01',
  advanceOpening: 5000, diwaliEligible: 'yes', diwaliBonusAmount: 5000,
  loans: [{ id: 'L', amount: 60000, instalment: 2000, startMonth: '2026-04', status: 'active' }]
});
const monthList = ym => {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const out = [];
  for(let d = 1; d <= days; d++) out.push(ym + '-' + String(d).padStart(2, '0'));
  return out;
};
const JUL = monthList('2026-07'), AUG = monthList('2026-08');
const attOf = () => { const a = {}; JUL.concat(AUG).forEach(d => { a[d] = { code: 'P' }; }); return a; };

const salOf = (emp, att, list) => L.computeSalaryFromAttendance(emp, att, list, list.length, {});

console.log('with nothing finalised, nothing changes\n');
{
  L.setPayrollLocks(null);
  const a = salOf(EMP(), attOf(), JUL);
  check('a month nobody has finalised is still computed', a.netSalary > 0, true);
  check('and no month reports itself as locked', L.isPayrollMonthLocked('2026-07'), false);
}

console.log('\nfinalising July, then editing every undated field\n');
let locked = null, julBefore = null;
{
  L.setPayrollLocks(null);
  const att = attOf();
  const built = L.buildPayrollLock([EMP()], { '8': att }, JUL, JUL.length, {});
  check('the month it finalised is the month asked for', built.ym, '2026-07');
  check('it fits the cell with room to spare', built.size < L.PAYROLL_LOCK_MAX_CHARS, true);
  // Stored packed, read back unpacked — the full round trip a save and a
  // reload actually make, not the in-memory object.
  const stored = JSON.parse(JSON.stringify(built.packed));
  locked = { '2026-07': L.payrollLockUnpack(stored) };
  julBefore = salOf(EMP(), att, JUL);
  L.setPayrollLocks(locked);
  check('July now reports itself finalised', L.isPayrollMonthLocked('2026-07'), true);
  check('and reads back byte-identical to what was finalised',
        salOf(EMP(), att, JUL), julBefore);
}
{
  // THE assertion this file exists for. Every field with no dated history,
  // changed to something obviously different, one at a time.
  const EDITS = {
    'conveyance':                 e => { e.conveyance = 9999; },
    'other allowances':           e => { e.otherAllowances = 9999; },
    'retention money':            e => { e.retentionMoney = 120000; },
    'retention months':           e => { e.retentionMonths = 3; },
    'bond start':                 e => { e.bondStart = '2020-01-01'; },
    'direct-paid amount':         e => { e.directPaidAmount = 5000; e.directPaidEndMonth = '2027-03'; },
    'advance opening':            e => { e.advanceOpening = 99999; },
    'Diwali bonus':               e => { e.diwaliBonusAmount = 99999; },
    'loan amount':                e => { e.loans[0].amount = 6000; },
    'loan start month':           e => { e.loans[0].startMonth = '2026-01'; },
    'loan status':                e => { e.loans[0].status = 'closed'; },
    'loan skip months':           e => { e.loans[0].skipMonths = ['2026-07']; },
    'loan EMI':                   e => { e.loans[0].instalment = 9000; e.loans[0].emiHistory = []; },
    'PF eligibility':             e => { e.pfEligible = 'no'; },
    'PF contribution type':       e => { e.pfContributionType = 'fixed'; },
    'prior UAN':                  e => { e.hasPriorUan = 'no'; },
    'Form 11':                    e => { e.form11Submitted = 'no'; },
    'ESI eligibility':            e => { e.esiEligible = 'yes'; },
    'ESI disability':             e => { e.esiDisabled = 'yes'; },
    'ESI covered at period start':e => { e.esiCoveredAtPeriodStart = 'yes'; },
    'PT paid this year':          e => { e.ptPaidThisYear = 2400; },
    'EL opening':                 e => { e.elOpening = 99; },
    'SL opening':                 e => { e.slOpening = 99; },
    'leave opening from':         e => { e.leaveOpeningFrom = '2020-01-01'; },
    'employee type':              e => { e.employeeType = 'resident'; },
    'always-present-from':        e => { e.alwaysPresentFrom = '2020-01-01'; },
    'employment status':          e => { e.employmentStatus = 'left'; e.leftDate = '2026-07-10'; },
    'salary heading':             e => { e.salaryHeading = 'managerial'; },
    'Rate of Pay':                e => { e.ratePay = 50000; }
  };
  let moved = [];
  Object.keys(EDITS).forEach(name => {
    const e = EMP(); EDITS[name](e);
    const got = salOf(e, attOf(), JUL);
    if(JSON.stringify(got) !== JSON.stringify(julBefore)) moved.push(name);
  });
  check('none of the ' + Object.keys(EDITS).length + ' undated fields moves a finalised July', moved, []);

  // Attendance is the other way a closed month used to change under HR's feet.
  const att2 = attOf();
  ['01','02','03','06','07','08'].forEach(d => { att2['2026-07-' + d] = { code: 'A' }; });
  check('nor does rewriting that month\'s attendance', salOf(EMP(), att2, JUL), julBefore);
}
{
  // The other half of the guarantee: an open month must still follow the record.
  const e = EMP(); e.conveyance = 9999;
  const augPlain = salOf(EMP(), attOf(), AUG);
  const augEdited = salOf(e, attOf(), AUG);
  check('August, still open, follows the edit as it always did',
        augEdited.netSalary - augPlain.netSalary, 9499);
}
{
  // Reports must inherit the freeze without knowing locks exist — that is the
  // whole reason it sits inside computeSalaryFromAttendance.
  const att = { '8': attOf() };
  const csvLocked = L.salarySheetCsv([EMP()], att, JUL, JUL.length, {});
  const e = EMP(); e.conveyance = 9999; e.pfEligible = 'no';
  const csvEdited = L.salarySheetCsv([e], att, JUL, JUL.length, {});
  check('the Salary Sheet export is frozen with it',
        JSON.stringify(csvEdited) === JSON.stringify(csvLocked), true);
  const pfLocked = L.statutoryReportData([EMP()], att, JUL, JUL.length, {}, 'pf');
  const pfEdited = L.statutoryReportData([e], att, JUL, JUL.length, {}, 'pf');
  check('and every figure on the PF return',
        JSON.stringify(pfEdited.pfTot) === JSON.stringify(pfLocked.pfTot) &&
        JSON.stringify(pfEdited.pfRows.map(r => [r.wage, r.employee, r.epf, r.eps, r.admin, r.edli, r.total])) ===
        JSON.stringify(pfLocked.pfRows.map(r => [r.wage, r.employee, r.epf, r.eps, r.admin, r.edli, r.total])),
        true);
  // The one thing on that return which is NOT frozen, stated rather than
  // discovered later: the Eligible column reports how the record is configured
  // now, through pfConfigStatus, not how it was when the month closed. It is a
  // label describing the record, no figure depends on it — every contribution
  // above comes from the frozen row — and freezing it would have the return
  // claim an employee is still marked eligible when HR has since said
  // otherwise. If that ever needs to change, change it deliberately here.
  check('  while the Eligible column still describes the record as it is today',
        [pfLocked.pfRows[0].eligible, pfEdited.pfRows[0].eligible], ['Yes', 'No']);
}

console.log('\nwhat the freeze must NOT swallow\n');
{
  L.setPayrollLocks(locked);
  // A joiner's or leaver's part month is a different question from the whole
  // month, and must never be answered with the whole month's frozen figures.
  //
  // Tested through a field the freeze would give a DIFFERENT answer for —
  // conveyance is 500 in the lock and 9999 on the edited record — because a
  // ten-day range of full attendance happens to net the same as a whole month,
  // so comparing net salary would have passed either way and proved nothing.
  const edited = EMP(); edited.conveyance = 9999;
  check('the whole month reads the freeze', salOf(edited, attOf(), JUL).conveyance, 500);
  // Both shapes a part month really arrives in: with the month's own day count
  // passed for the per-day rate (a joiner, as the Salary Sheet calls it), and
  // with the range's own length (which used to slip through as a whole month).
  const part = JUL.slice(0, 10);
  check('a part-month range is still computed, not served the month\'s freeze',
        [L.computeSalaryFromAttendance(edited, attOf(), part, 31, {}).conveyance,
         L.computeSalaryFromAttendance(edited, attOf(), part, 10, {}).conveyance],
        [9999, 9999]);
  check('  and a month short of its last day is not the month either',
        L.computeSalaryFromAttendance(edited, attOf(), JUL.slice(0, 30), 31, {}).conveyance, 9999);
  // A range of the right length that does not start on the 1st is not the month.
  const shifted = monthList('2026-07').slice(1).concat(['2026-08-01']);
  check('nor is a 31-day range that starts on the 2nd',
        salOf(edited, attOf(), shifted).conveyance, 9999);
}
{
  // An employee added after the month was finalised has no frozen row, so they
  // are computed — a lock freezes what it recorded, it does not blank anyone.
  const nu = EMP(); nu.id = '99';
  check('somebody with no row in the lock is still computed',
        salOf(nu, attOf(), JUL).netSalary > 0, true);
}
{
  // Re-finalising a reopened month must read the record, not the freeze it was
  // reopened to correct.
  L.setPayrollLocks(locked);
  const e = EMP(); e.conveyance = 1500;
  const rebuilt = L.buildPayrollLock([e], { '8': attOf() }, JUL, JUL.length, {});
  const row = L.payrollLockUnpack(rebuilt.packed)['8'];
  check('re-finalising picks up the correction', row.conveyance, 1500);
  check('  and the lock in force is restored afterwards',
        L.isPayrollMonthLocked('2026-07'), true);
}

console.log('\nstoring it\n');
{
  check('the key is one per month', L.payrollLockKey('2026-07'), 'payrollLock:2026-07');
  check('and the index has its own key', L.PAYROLL_LOCK_INDEX_KEY, 'payrollLocks');
  const rows = { '1': { a: 1, b: 'x' }, '2': { a: 2, b: 'y' } };
  check('pack and unpack round-trip exactly', L.payrollLockUnpack(L.payrollLockPack(rows)), rows);
  check('an empty month packs to nothing', L.payrollLockPack({}), { f: [], r: {} });
  check('and unpacking rubbish is an empty month, not a throw',
        [L.payrollLockUnpack(null), L.payrollLockUnpack({ f: 1 })], [{}, {}]);
}
{
  // A payroll too big for the cell must refuse, not truncate: a half-written
  // cell reads back as a month where some people have no figures at all.
  L.setPayrollLocks(null);
  const many = [];
  const att = {};
  for(let i = 0; i < 400; i++){
    const e = EMP(); e.id = 'E' + i; many.push(e); att['E' + i] = attOf();
  }
  const big = L.buildPayrollLock(many, att, JUL, JUL.length, {});
  check('400 employees is over the cell limit and says so', big.tooBig, true);
  const small = L.buildPayrollLock([EMP()], { '8': attOf() }, JUL, JUL.length, {});
  check('a real roster is not', small.tooBig, false);
}

// A finalised month is only honoured if something LOADED it first, and doing
// that was left to each screen — where exactly one screen ever did it.
// renderSalarySheet called usePayrollLocks_; the Final Salary Sheet for
// Accountant, both statutory returns, the Consultant Report, the Consultant
// Summary, the Apprentice report and the salary slips did not. So finalised
// August 2026 stood or was recomputed depending on whether HR had happened to
// open the Salary Sheet first in that session — one phone showed ₹8,46,321 and
// Behra Abhimanyu at ₹27,580, the other ₹2,67,573 and Behra at ₹0, same login,
// same report, same month.
//
// setPayrollLocks now takes the months whose state was actually established,
// and pricing a whole month that is not among them raises instead of quietly
// computing. That is what makes the NEXT report — one written next year, by
// somebody who has never heard of locks — fail loudly rather than pay wrongly.
console.log('\na whole month nobody looked up is a fault, not an open month\n');
{
  L.setPayrollLocks({ '2026-07': julBefore ? { '8': julBefore } : {} }, ['2026-07']);
  let threw = null;
  try{ salOf(EMP(), attOf(), AUG); }catch(e){ threw = e; }
  check('August was never established, so it refuses to price it',
        !!(threw && threw.payrollLockNotEstablished === '2026-08'), true);
  check('  and says which month, so it can be fixed',
        /2026-08/.test(String(threw && threw.message)), true);

  // The whole point of establishing it: an OPEN month that was looked up and
  // found open computes exactly as it always did.
  L.setPayrollLocks({}, ['2026-07', '2026-08']);
  check('an open month that WAS looked up still computes',
        salOf(EMP(), attOf(), AUG).netSalary > 0, true);

  // A part month — a joiner's first days, a leaver's last — is priced from the
  // record either way and needs no lock, so it must not be caught by this.
  L.setPayrollLocks({}, ['2026-07']);
  const partAug = AUG.slice(0, 10);
  check('a part month is not caught by the guard',
        salOf(EMP(), attOf(), partAug, partAug.length).netSalary > 0, true);

  // Passing no list at all leaves the guard off, which is how Code 2.js runs:
  // it reads every key of the sheet in one go and deliberately degrades to
  // recomputing a month it cannot parse rather than failing the 8 AM pack.
  L.setPayrollLocks({});
  check('a caller that establishes nothing is unaffected',
        salOf(EMP(), attOf(), AUG).netSalary > 0, true);

  // Finalising must ignore the guard as well as the locks — it is the act of
  // deciding what the figures ARE, and the month it is deciding has by
  // definition not been established yet.
  L.setPayrollLocks({}, ['2026-07']);
  const built = L.buildPayrollLock([EMP()], { '8': attOf() }, AUG, AUG.length, {});
  check('finalising a month builds it rather than refusing', built.employees, 1);
}

L.setPayrollLocks(null);
console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
