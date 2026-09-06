// Comparing a PF challan against what the month actually came to.
//
// The reading half of this feature is a language model, and a model can be
// confidently wrong. That is precisely why nothing below involves one: the
// model's only job is to copy what is printed, and every decision about
// whether a challan is right is made here, by subtraction, over figures
// consultantSummaryTotals computed from the same Salary Sheet the PF Return is
// filed from.
//
// So these assertions are the safety net for the whole feature. What matters
// most is not that a mismatch is caught — it is that a match is never claimed
// when a figure could not be read, and that a challan compared against the
// wrong month is not reported as a disaster.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({challanComparison, CHALLAN_ACCOUNTS, consultantSummaryTotals,' +
  ' monthDateList_, computeSalaryFromAttendance, employedDuringPeriod_})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

// A totals object of the exact shape consultantSummaryTotals returns, so the
// comparison is exercised against the real contract rather than a convenient
// invention. Built from the real function below as well, to prove the shape.
const totals = {
  acct1: 12000, acct22: 0, pfTotal: 15250,
  pf: { admin: 250, eps: 2500, edli: 500, count: 40 }
};
const rowOf = (cmp, label) => cmp.rows.find(r => r.label.indexOf(label) === 0);

// ------------------------------------------------------------- everything agrees
console.log('a challan that matches the month\n');
{
  const cmp = L.challanComparison(
    { ac1: 12000, ac2: 250, ac10: 2500, ac21: 500, ac22: 0, total: 15250,
      memberCount: 40, month: '2026-08', trrn: 'TRRN123' },
    totals, { ym: '2026-08' });
  check('nothing differs', cmp.differCount, 0);
  check('nothing is unread', cmp.missingCount, 0);
  check('it says so', cmp.agrees, true);
  check('and the month lines up', cmp.monthMatches, true);
  check('every row is marked as agreeing',
        cmp.rows.every(r => r.status === 'agrees'), true);
  check('with a difference of zero, not a blank',
        cmp.rows.every(r => r.difference === 0), true);
}

// --------------------------------------------------------------- one figure out
console.log('\none account that does not match\n');
{
  const cmp = L.challanComparison(
    { ac1: 12500, ac2: 250, ac10: 2500, ac21: 500, ac22: 0, total: 15750, memberCount: 40 },
    totals, { ym: '2026-08' });
  check('two figures differ — the account and the total it feeds', cmp.differCount, 2);
  check('and it does not claim agreement', cmp.agrees, false);
  check('the account is named', rowOf(cmp, 'A/c 1').status, 'differs');
  check('with the difference signed the way it was paid',
        rowOf(cmp, 'A/c 1').difference, 500);
  check('and the accounts that do match are still marked as matching',
        rowOf(cmp, 'A/c 10').status, 'agrees');
}
{
  // Under-paid, so the sign goes the other way. A difference reported without
  // a sign leaves HR unable to tell a shortfall from an overpayment.
  const cmp = L.challanComparison({ ac1: 11000 }, totals, { ym: '2026-08' });
  check('paying less than the month came to reads as negative',
        rowOf(cmp, 'A/c 1').difference, -1000);
}

// ------------------------------------------------------- a figure that was not read
console.log('\na figure the reader could not make out\n');
{
  // The one that matters most. A null must never be treated as a zero — that
  // would report "differs by ₹12,000" against a challan that may be perfectly
  // correct, or worse, agree with a zero the app also happens to hold.
  const cmp = L.challanComparison(
    { ac1: null, ac2: 250, ac10: 2500, ac21: 500, ac22: 0, total: 15250, memberCount: 40 },
    totals, { ym: '2026-08' });
  check('an unread figure is not a mismatch', rowOf(cmp, 'A/c 1').status, 'missing');
  check('nor is it silently read as zero', rowOf(cmp, 'A/c 1').challan, null);
  check('and it has no difference to report', rowOf(cmp, 'A/c 1').difference, null);
  check('it is counted as unread', cmp.missingCount, 1);
  check('the rest still compare normally', cmp.differCount, 0);
}
{
  // Nothing read at all must not come back as "everything agrees".
  const cmp = L.challanComparison({}, totals, { ym: '2026-08' });
  check('a challan nothing could be read from does not claim to agree', cmp.agrees, false);
  check('every figure is unread', cmp.missingCount, cmp.rows.length);
}

// ------------------------------------------------------------ money and counts
console.log('\na head count is not an amount of money\n');
{
  const cmp = L.challanComparison({ ac1: 12000, memberCount: 40 }, totals, { ym: '2026-08' });
  check('the accounts are money', rowOf(cmp, 'A/c 1').unit, 'money');
  check('the total too', rowOf(cmp, 'Total').unit, 'money');
  // "Members ₹1" appeared on the first run. The unit belongs on the row, not
  // in whatever draws it.
  check('but the member count is a count', rowOf(cmp, 'Members').unit, 'count');
}

// ---------------------------------------------------------------- the wrong month
console.log('\na challan compared against the wrong month\n');
{
  const cmp = L.challanComparison(
    { ac1: 12000, month: '2026-07' }, totals, { ym: '2026-08' });
  check('the mismatch of months is reported separately', cmp.monthMatches, false);
  check('and the month it claims is carried through', cmp.month, '2026-07');
}
{
  const cmp = L.challanComparison({ ac1: 12000 }, totals, { ym: '2026-08' });
  check('no month on the challan is unknown, not wrong', cmp.monthMatches, null);
}

// -------------------------------------------------------- amounts as they print
console.log('\nfigures as a challan actually prints them\n');
{
  // Rupee signs, thousands separators, decimals and stray spaces are all
  // normal on a scanned challan, and a reader copying what is printed will
  // hand them back that way.
  const cmp = L.challanComparison(
    { ac1: '₹12,000.00', ac2: ' 250 ', ac10: '2,500', ac21: '500.00', ac22: '0',
      total: '15,250', memberCount: '40' },
    totals, { ym: '2026-08' });
  check('a formatted amount still compares', cmp.differCount, 0);
  check('and none of them reads as unread', cmp.missingCount, 0);
}
{
  const cmp = L.challanComparison({ ac1: 'illegible' }, totals, { ym: '2026-08' });
  check('a word where a number should be is unread, not zero',
        rowOf(cmp, 'A/c 1').status, 'missing');
}

// ------------------------------------------------ against the real totals object
console.log('\nagainst what consultantSummaryTotals really returns\n');
{
  const LIST = L.monthDateList_('2026-08');
  const emp = { id: 'E1', name: 'One', employmentStatus: 'active', employeeType: 'office',
    doj: '2020-01-01', salaryHeading: 'managerial', ratePay: 30000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' }],
    pfEligible: 'yes', pfContributionType: 'percent', hasPriorUan: 'yes', form11Submitted: 'yes' };
  const att = {}; LIST.forEach(d => { if(new Date(d + 'T00:00:00').getDay() !== 0) att[d] = { code: 'P' }; });
  const real = L.consultantSummaryTotals([emp], { E1: att }, LIST, LIST.length, {});
  // Every accessor the comparison uses must exist on the real object — this is
  // what stops a rename in consultantSummaryTotals silently turning every
  // account into a zero that then "differs" against a correct challan.
  L.CHALLAN_ACCOUNTS.forEach(a => {
    check('the ' + a.key + ' figure is a real number on the real totals',
          Number.isFinite(Number(a.of(real))), true);
  });
  check('and so is the total', Number.isFinite(Number(real.pfTotal)), true);
  // Feed the app's own figures back in as if they were the challan: everything
  // must agree, which is the round trip the whole feature rests on.
  const asChallan = { total: Math.round(real.pfTotal), memberCount: real.pf.count };
  L.CHALLAN_ACCOUNTS.forEach(a => { asChallan[a.key] = Math.round(a.of(real)); });
  const cmp = L.challanComparison(asChallan, real, { ym: '2026-08' });
  check('a challan carrying exactly what the app computed agrees on every line',
        [cmp.differCount, cmp.missingCount, cmp.agrees], [0, 0, true]);
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
