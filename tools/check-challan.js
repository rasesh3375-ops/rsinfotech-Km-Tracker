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
  ' parseChallanText, monthDateList_, computeSalaryFromAttendance, employedDuringPeriod_})', sb);

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

// ------------------------------------------------- reading the challan's text
//
// Both of these are the exact shapes two real challans from this company's
// Drive convert to — only the identifiers and amounts are made up. The shapes
// are the whole point: the same portal prints the value BEFORE its label on
// one receipt and AFTER it on another, so a parser that assumes either one
// reads half the challans wrong. Layout B additionally carries the 7Q/14B
// damages column as a trailing zero, runs that zero into the next label
// ("0Account-2"), writes "TRRN :" rather than "TRRN No :", and prints no
// member count at all.
console.log('\nthe two layouts a real challan converts to\n');
// Value BEFORE label. 30,000 + 900 + 8,000 + 700 + 0 = 39,600.
const LAYOUT_A =
  'Payment Confirmation Receipt\n\nTRRN No : 1899900011122\n\n' +
  'Payment Confirmed Challan Status :\n\n10-SEP-2025 16:04:38 Challan Generated On :\n\n' +
  'ABCDE1234567000 Establishment ID :\n\nR S INFOTECH Establishment Name :\n\n' +
  'Monthly Contribution Challan Challan Type :\n\n12 Total Members :\n\n' +
  'AUG-2025 Wage Month :\n\n39,600 Total Amount (Rs) :\n\n' +
  '30,000 Account-1 Amount (Rs) :\n\n900 Account-2 Amount (Rs) :\n\n' +
  '8,000 Account-10 Amount (Rs) :\n\n700 Account-21 Amount (Rs) :\n\n' +
  '0 Account-22 Amount (Rs) :\n\nPayment Confirmation Bank : Axis Bank\n\n' +
  '211110925001457 CRN :\n\nPayment Date : 11-SEP-2025\n\n0 Total PMRPY Benefit :\n\nPage 1 of 1';
// Value AFTER label, one long line, damages column, no Total Members.
const LAYOUT_B =
  '24/12/2025 Generated On 10:40:36 Payment Confirmation Receipt\n\nTRRN : 2599900022233\n\n' +
  'Challan Status : Payment Confirmed Challan Generated On : 06-DEC-2025 15:21:55 ' +
  'Establishment ID : ABCDE1234567000 Establishment Name : R S INFOTECH ' +
  'Challan Type : Monthly Contribution Wage Month : NOV-2025 ' +
  'Total Amount (Rs) : 39,600 Accounts Amount (Rs) 7Q 14B\n\n' +
  'Account-1 Amount (Rs) : 30,000 0Account-2 Amount (Rs) : 900 0' +
  'Account-10 Amount (Rs) : 8,000 0Account-21 Amount (Rs) : 700 0' +
  'Account-22 Amount (Rs) : 0 0\n\nPayment : Payment type : Full Confirmation Bank\n\n' +
  'Axis Bank\n\nCRN : 211081225002038 Page 1 of 1';
{
  const a = L.parseChallanText(LAYOUT_A);
  // THE assertion. Read the obvious way — "the number after the colon" — A/c 1
  // comes out as 900, because the figure following that colon is the NEXT
  // row's. It is a plausible-looking wrong number that would be compared,
  // would disagree, and would send somebody to the PF consultant about a
  // challan that was correct.
  check('A/c 1 is its own figure, not the row below it', a.ac1, 30000);
  check('the whole of layout A reads',
        [a.ac2, a.ac10, a.ac21, a.ac22, a.total], [900, 8000, 700, 0, 39600]);
  check('the orientation was worked out, not assumed', a.orientation, 'before');
  check('and it knows the reading holds up', a.reliable, true);
  check('the wage month becomes a month this app can use', a.month, '2025-08');
  check('the member count is read', a.memberCount, 12);
  // "R S INFOTECH" sits directly after the establishment ID on the page and
  // was read as the ID on the first run.
  check('the establishment ID, not the name printed next to it',
        a.establishment, 'ABCDE1234567000');
  // The TRRN is in the header, above the table, so it is label-then-value even
  // on a challan whose table below it is the other way round. Both "before"
  // challans in Drive came back with no TRRN at all until that was handled.
  check('the TRRN is found even though the table runs the other way',
        a.trrn, '1899900011122');
}
{
  const b = L.parseChallanText(LAYOUT_B);
  check('the same figures read off the opposite layout',
        [b.ac1, b.ac2, b.ac10, b.ac21, b.ac22, b.total], [30000, 900, 8000, 700, 0, 39600]);
  check('with the orientation the other way round', b.orientation, 'after');
  check('the damages column is not mistaken for an account', b.reliable, true);
  check('"TRRN :" is read as well as "TRRN No :"', b.trrn, '2599900022233');
  check('a glued-on digit does not break the label after it', b.month, '2025-11');
  // The one that would quietly report every member as unaccounted for.
  check('a member count the challan does not print stays unread, not zero',
        b.memberCount, null);
  const a = L.parseChallanText(LAYOUT_A);
  check('both layouts arrive at the same figures',
        [a.ac1, a.ac2, a.ac10, a.ac21, a.ac22, a.total],
        [b.ac1, b.ac2, b.ac10, b.ac21, b.ac22, b.total]);
}

console.log('\na reading that cannot be trusted says so\n');
{
  // Accounts that do not add up to the total printed beside them. Neither
  // orientation passes its own arithmetic, so nothing here may be presented as
  // read — HR has to check every box.
  const broken = LAYOUT_A.replace('30,000 Account-1', '31,234 Account-1');
  const p = L.parseChallanText(broken);
  check('a challan whose accounts do not sum is not called reliable', p.reliable, false);
  // Still filled in — an unreliable reading is a draft to correct, and a blank
  // form gives HR nothing to correct.
  check('but the figures are still offered to be corrected', p.ac1, 31234);
}
{
  const p = L.parseChallanText('This is not a challan. Nothing here is a figure.');
  check('a document with no challan in it finds nothing', p.found, 0);
  check('and does not invent a total', p.total, null);
}
{
  const p = L.parseChallanText('');
  check('empty text finds nothing', p.found, 0);
}

console.log('\nfrom the document straight through to the comparison\n');
{
  // The round trip the feature is: text in, figures out, compared against what
  // the app computed. Totals here are made to match layout A exactly.
  const t = { acct1: 30000, acct22: 0, pfTotal: 39600,
              pf: { admin: 900, eps: 8000, edli: 700, count: 12 } };
  const cmp = L.challanComparison(L.parseChallanText(LAYOUT_A), t, { ym: '2025-08' });
  check('a challan that matches payroll agrees on every line',
        [cmp.differCount, cmp.missingCount, cmp.agrees], [0, 0, true]);
  check('and the month read off it lines up', cmp.monthMatches, true);
  // Layout B prints no member count, so that row must be absent rather than
  // compared against a zero.
  const cmpB = L.challanComparison(L.parseChallanText(LAYOUT_B), t, { ym: '2025-11' });
  check('the missing member count is left out rather than failed',
        [cmpB.differCount, cmpB.missingCount], [0, 0]);
  check('the wrong month is still caught after a real read',
        L.challanComparison(L.parseChallanText(LAYOUT_A), t, { ym: '2025-09' }).monthMatches, false);
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
