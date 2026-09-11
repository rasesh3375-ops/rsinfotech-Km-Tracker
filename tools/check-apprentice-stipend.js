// The apprentice direct-deposit stipend: what a month gets, and what a change
// today is allowed to do to a month already paid.
//
// This exists because of a real wrong number in a real bank account. Nikhil
// Somavanshi was an Apprentice on ₹18,000 with ₹1,500 a month going straight
// to his own account, so the Salary Sheet took that ₹1,500 off Net Payable.
// On 1 August 2026 his heading moved to Contractors. The Edit employee form's
// toggleDirectPay() cleared directPaid, directPaidAmount and
// directPaidEndMonth whenever the heading on the form was not Apprentices,
// and it ran on every render of that form — so the next Save wrote the erase
// down. Those three fields carried no dated history, so the erase reached
// BACKWARDS: April 2026, a month nobody had touched, went from ₹14,700 to
// ₹16,200. Four months earlier than the change that caused it.
//
// Two separate properties have to hold, and each failed on its own:
//
//   1. A month is decided by the heading in force THAT month, never by the
//      heading today. (This half already worked — ratePayAsOf was right.)
//   2. A statement about today — the on/off flag, a new amount — must never
//      reach into a month already paid. (This half was the bug.)
//
// Both are asserted below, and so is the review list HR works from, because
// the amounts the erase destroyed are not recoverable from anything the app
// still holds.
//
//   node tools/check-apprentice-stipend.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'report-logic.js'), 'utf8');
const sandbox = vm.createContext({});
vm.runInContext(src, sandbox, { filename: 'shared/report-logic.js' });
const box = vm.runInContext(
  'var o={};[\'directPaidHistoryOf\',\'directPaidAsOf\',\'directPaidForMonth\',' +
  '\'apprenticeStipendReview\',\'SALARY_HEADINGS\',\'ratePayAsOf\',\'prePayrollChecks\']' +
  '.forEach(function(n){ try{ o[n]=eval(n); }catch(e){} }); o;', sandbox);

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
                                   '\n         want ' + JSON.stringify(want)); }
  else console.log('  ok   ' + label);
};

const APPRENTICE = box.SALARY_HEADINGS.apprentice;
const CONTRACTOR = box.SALARY_HEADINGS.contractor;

// Nikhil, exactly as the record stood: apprentice from 1 Aug 2025, contractor
// from 1 Aug 2026, ₹1,500 a month direct to his account throughout.
const nikhil = {
  id: 'N', name: 'Nikhil Somavanshi', ratePay: 18000, salaryHeading: 'contractor',
  directPaid: 'yes', directPaidAmount: 1500, directPaidEndMonth: '',
  salaryHistory: [
    { from: '2025-08-01', ratePay: 18000, salaryHeading: 'apprentice' },
    { from: '2026-08-01', ratePay: 18000, salaryHeading: 'contractor' }
  ]
};
const headingIn = (emp, ym) =>
  box.SALARY_HEADINGS[box.ratePayAsOf(emp, ym + '-01').salaryHeading];
const paidIn = (emp, ym) => box.directPaidForMonth(emp, headingIn(emp, ym), ym);

// ---- 1. the months he was an apprentice still get the stipend -------------
eq('April 2026 resolves to Apprentices', headingIn(nikhil, '2026-04').label, 'Apprentices');
eq('April 2026 takes off ₹1,500', paidIn(nikhil, '2026-04'), 1500);
eq('July 2026 — his last apprentice month — takes off ₹1,500', paidIn(nikhil, '2026-07'), 1500);

// ---- 2. the months after it do not ----------------------------------------
eq('August 2026 resolves to Contractors', headingIn(nikhil, '2026-08').label, 'Contractors');
eq('August 2026 takes off nothing', paidIn(nikhil, '2026-08'), 0);
eq('a Contractor never gets the stipend, whatever the record says',
   box.directPaidForMonth(nikhil, CONTRACTOR, '2026-04'), 0);

// ---- 3. the flag must not reach backwards --------------------------------
// THE BUG. Switching the arrangement off today is a statement about today.
// Before this fix, `directPaid !== 'yes'` was the first line of
// directPaidForMonth, so setting it to 'no' silently took ₹1,500 off every
// apprentice month on file. April is what HR reported, so April is asserted.
{
  const off = Object.assign({}, nikhil, { directPaid: 'no', directPaidAmount: 0,
                                          directPaidEndMonth: '',
                                          directPaidHistory: [{ from: null, amount: 1500 }] });
  eq('switching it off today leaves April 2026 at ₹1,500', paidIn(off, '2026-04'), 1500);
  eq('switching it off today leaves July 2026 at ₹1,500', paidIn(off, '2026-07'), 1500);
}

// ---- 4. an end month stops it, and only from after the month named --------
{
  const ended = Object.assign({}, nikhil, { directPaidEndMonth: '2026-05' });
  eq('the end month itself still pays', paidIn(ended, '2026-05'), 1500);
  eq('the month after the end month does not', paidIn(ended, '2026-06'), 0);
}

// ---- 5. changing the amount does not restate a month already paid --------
// The reason the stipend is dated at all. ₹1,500 to ₹2,000 from June: May
// keeps ₹1,500 — the figure that actually left the company — and June on gets
// ₹2,000. Undated, every month would have become ₹2,000 at once, which is the
// same fault as the erase wearing different clothes.
{
  const raised = Object.assign({}, nikhil, {
    directPaidHistory: [{ from: null, amount: 1500 }, { from: '2026-06', amount: 2000 }] });
  eq('April 2026 keeps the ₹1,500 it was paid', paidIn(raised, '2026-04'), 1500);
  eq('May 2026 keeps the ₹1,500 it was paid', paidIn(raised, '2026-05'), 1500);
  eq('June 2026 takes the new ₹2,000', paidIn(raised, '2026-06'), 2000);
  eq('July 2026 takes the new ₹2,000', paidIn(raised, '2026-07'), 2000);
  eq('August 2026 is a Contractor month and takes nothing', paidIn(raised, '2026-08'), 0);
}

// ---- 6. a dated 0 stops it without erasing what came before ---------------
{
  const stopped = Object.assign({}, nikhil, {
    directPaidHistory: [{ from: null, amount: 1500 }, { from: '2026-06', amount: 0 }] });
  eq('a dated stop leaves May 2026 at ₹1,500', paidIn(stopped, '2026-05'), 1500);
  eq('a dated stop takes nothing from June 2026', paidIn(stopped, '2026-06'), 0);
}

// ---- 7. a month before the arrangement started gets nothing --------------
// The one place the resolution rule differs from ratePayAsOf, which falls
// back to its earliest entry. Falling back here would invent a deduction in a
// month nobody was paid one.
{
  const later = Object.assign({}, nikhil, {
    directPaidHistory: [{ from: '2026-06', amount: 1500 }] });
  eq('a month before the first entry takes nothing', paidIn(later, '2026-04'), 0);
  eq('the first entry\'s own month takes ₹1,500', paidIn(later, '2026-06'), 1500);
}

// ---- 8. an apprentice with no arrangement is untouched -------------------
{
  const plain = Object.assign({}, nikhil, { directPaid: 'no', directPaidAmount: 0 });
  delete plain.directPaidHistory;
  eq('no arrangement means no deduction', paidIn(plain, '2026-04'), 0);
  eq('and no history is synthesized for them', box.directPaidHistoryOf(plain).length, 0);
}

// ---- 9. the review list names who to check, and nobody else -------------
{
  const neverApprentice = { id: 'C', name: 'Someone Else', ratePay: 30000,
                            salaryHeading: 'senior', salaryHistory: [
                              { from: '2025-04-01', ratePay: 30000, salaryHeading: 'senior' }] };
  const stillApprentice = { id: 'A', name: 'Current Apprentice', ratePay: 18000,
                            salaryHeading: 'apprentice', directPaid: 'no', salaryHistory: [
                              { from: '2025-08-01', ratePay: 18000, salaryHeading: 'apprentice' }] };
  const wiped = Object.assign({}, nikhil, { directPaid: 'no', directPaidAmount: 0 });
  delete wiped.directPaidHistory;
  const rows = box.apprenticeStipendReview([neverApprentice, stillApprentice, wiped, nikhil]);
  eq('somebody who was never an apprentice is not on the list',
     rows.some(r => r.id === 'C'), false);
  eq('a current apprentice with no stipend is listed but not flagged',
     (rows.find(r => r.id === 'A') || {}).checkThis, false);
  eq('a former apprentice whose stipend is gone IS flagged',
     (rows.find(r => r.id === 'N') || {}).checkThis, true);
  eq('a former apprentice whose stipend is intact is not flagged',
     box.apprenticeStipendReview([nikhil])[0].checkThis, false);
  eq('the list keeps the order the roster arrived in',
     box.apprenticeStipendReview([stillApprentice, wiped]).map(r => r.id), ['A', 'N']);
}

// ---- 10. the pre-payroll check speaks up on the right month, and only it --
// A warning, never a stop: the app cannot tell "never had one" from "erased",
// so it must not block payroll on a question only HR can answer.
{
  const wiped = Object.assign({}, nikhil, { directPaid: 'no', directPaidAmount: 0, doj: '2025-08-01' });
  delete wiped.directPaidHistory;
  const runFor = ym => {
    const sal = {}; sal[wiped.id] = { elBalance: 0, netSalary: 16200 };
    const att = {}; att[wiped.id] = {};
    return box.prePayrollChecks([wiped], att, ym, {}, sal, {}, { today: '2026-09-11' });
  };
  const has = ym => runFor(ym).flags.some(f => f.key === 'apprentice-stipend-missing');
  eq('April 2026 — an apprentice month — is flagged', has('2026-04'), true);
  eq('July 2026 — his last apprentice month — is flagged', has('2026-07'), true);
  eq('August 2026 — a contractor month — is not', has('2026-08'), false);
  const apr = runFor('2026-04').flags.find(f => f.key === 'apprentice-stipend-missing');
  eq('it is a warning, not a stop', apr.level, 'warn');
  // Intact record: nothing to say, on any month.
  const clean = {};
  clean[nikhil.id] = { elBalance: 0, netSalary: 14700 };
  const attC = {}; attC[nikhil.id] = {};
  eq('an intact record is never flagged',
     box.prePayrollChecks([Object.assign({ doj: '2025-08-01' }, nikhil)], attC, '2026-04', {},
                          clean, {}, { today: '2026-09-11' })
        .flags.some(f => f.key === 'apprentice-stipend-missing'), false);
}

if (failed) {
  console.log('\n' + failed + ' apprentice-stipend assertion(s) failed.');
  process.exit(1);
}
console.log('\nPASS');
