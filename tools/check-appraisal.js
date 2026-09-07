// The Salary Appraisal Letter's figures.
//
// This letter goes to the employee with a number on it, so the failure that
// matters is the one HR found: an increment already recorded for the month was
// being treated as a fresh starting point, and the typed percentage applied on
// top of it. Somebody who went from 10,000 to 11,000 in July got a letter
// promising 12,100 — a raise nobody granted, in writing.
//
// So the first block below is that exact case, and it is the reason the rest
// exists.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({appraisalFigures, appraisalRoster})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const EMP = { id: 'E1', name: 'Tushar', employmentStatus: 'active', employeeType: 'office',
  doj: '2020-01-01', salaryHeading: 'managerial', pfEligible: 'yes',
  pfContributionType: 'percent', hasPriorUan: 'yes', form11Submitted: 'yes' };
const withHist = h => Object.assign({}, EMP, { ratePay: h[h.length - 1].ratePay, salaryHistory: h });

// ------------------------------------------------- HR's own worked example
console.log('an increment already recorded for the month\n');
{
  // 10,000, raised 10% to 11,000 effective 1 July. Ask for July.
  const e = withHist([{ from: '2020-01-01', ratePay: 10000, salaryHeading: 'managerial' },
                      { from: '2026-07-01', ratePay: 11000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-07', percent: 10 });
  // THE assertion. Before this, newRate came out at 12,100 — the typed 10%
  // applied to a rate that already contained the July rise.
  check('the recorded rise is reported, not applied a second time',
        [a.oldRate, a.newRate], [10000, 11000]);
  check('and the percentage is the one that actually separates them',
        Math.round(a.ratePct), 10);
  check('it knows the appraisal has already happened', a.alreadyRecorded, true);
  check('and takes the effective date from the record, not from a form',
        a.effectiveFrom, '2026-07-01');
}
{
  // HR's SECOND report, and the reason the rule is "the most recent increment"
  // rather than "an increment inside this month". Manishkumar was raised on
  // 1 August; HR opened his letter in September — the default month — and got
  // "Increment: 0%" over two identical columns, because nothing was recorded
  // in September. The rise is what the letter is about, whenever it happened.
  const e = withHist([{ from: '2020-01-01', ratePay: 31000, salaryHeading: 'managerial' },
                      { from: '2026-08-01', ratePay: 34258, salaryHeading: 'managerial' }]);
  ['2026-08', '2026-09', '2026-12'].forEach(ym => {
    const a = L.appraisalFigures(e, { ym: ym });
    check('asked in ' + ym + ', it still reports the August rise',
          [a.oldRate, a.newRate, a.alreadyRecorded], [31000, 34258, true]);
    check('  and keeps the date the rise actually took effect', a.effectiveFrom, '2026-08-01');
  });
}
{
  // Nothing on file to report, so the typed percentage is the appraisal.
  const e = withHist([{ from: '2020-01-01', ratePay: 20000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-09', percent: 10 });
  check('an employee never increased gets the proposal',
        [a.oldRate, a.newRate, a.alreadyRecorded], [20000, 22000, false]);
}
{
  // Drafting a rise for somebody who already has one on file — HR asks for a
  // proposal explicitly rather than the app guessing from a typed number.
  const e = withHist([{ from: '2020-01-01', ratePay: 31000, salaryHeading: 'managerial' },
                      { from: '2026-08-01', ratePay: 34258, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-09', percent: 10, mode: 'proposed' });
  check('a proposal starts from the rate now in force, not the pre-August one',
        [a.oldRate, a.newRate, a.alreadyRecorded], [34258, 37684, false]);
}

console.log('\ntwo rises inside one month\n');
{
  const e = withHist([{ from: '2020-01-01', ratePay: 10000, salaryHeading: 'managerial' },
                      { from: '2026-07-01', ratePay: 11000, salaryHeading: 'managerial' },
                      { from: '2026-07-20', ratePay: 12000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-07', percent: 10 });
  // The month's whole movement, not just its last step — otherwise the letter
  // would state a rise from 11,000, which the employee was never on for a
  // full month.
  check('the letter states the month\'s whole movement', [a.oldRate, a.newRate], [10000, 12000]);
  check('and derives 20% from the two ends', Math.round(a.ratePct), 20);
  check('with the effective date of the first of them', a.effectiveFrom, '2026-07-01');
}

console.log('\nan employee with only one salary on file\n');
{
  const e = withHist([{ from: '2026-07-01', ratePay: 11000, salaryHeading: 'managerial' }]);
  // Nothing earlier to compare against, so there is no recorded increment to
  // report and the typed percentage is the appraisal.
  const a = L.appraisalFigures(e, { ym: '2026-07', percent: 10 });
  check('the typed rise is treated as a proposal',
        [a.oldRate, a.newRate, a.alreadyRecorded], [11000, 12100, false]);
}
{
  const e = withHist([{ from: '2026-07-01', ratePay: 11000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-07' });
  // No history to report AND no rise proposed — there is no appraisal here to
  // write about, and printing "Increment: 0%" over two identical columns would
  // be a claim rather than a blank. That is exactly what HR was shown.
  check('with no percentage either, it says there is nothing to state',
        [a.hasPrevious, a.oldRate, a.newRate], [false, 11000, 11000]);
}

console.log("\nHR's own letter, to the rupee\n");
{
  // Manishkumar's real letter, hand-written by HR and reconciled against this:
  //   July   28,980 + 1,800 + 1,800 + 200 = 32,780
  //   August 32,258 + 1,800 + 1,800 + 200 = 36,058
  // The PF line is 3,600 in HR's letter — 1,800 each way. Printing only the
  // employee share made the app read 34,258 against HR's 36,058, on a Take
  // Home that already agreed exactly.
  const e = Object.assign({}, EMP, { pfContributionType: 'fixed', ratePay: 34258,
    salaryHistory: [{ from: '2020-01-01', ratePay: 30980, salaryHeading: 'managerial' },
                    { from: '2026-08-01', ratePay: 34258, salaryHeading: 'managerial' }] });
  const a = L.appraisalFigures(e, { ym: '2026-09' });
  const grand = (p, t) => Math.round(t + p.pf + p.pfEmployer + p.esi + (p.esiEmployer || 0) + p.pt);
  check('July take home matches HR\'s letter', Math.round(a.takeHomeBefore), 28980);
  check('August take home too', Math.round(a.takeHomeAfter), 32258);
  check('both sides of PF are 1,800 each, HR\'s 3,600',
        [Math.round(a.after.pf), Math.round(a.after.pfEmployer)], [1800, 1800]);
  check('July grand total is HR\'s 32,780', grand(a.before, a.takeHomeBefore), 32780);
  check('August grand total is HR\'s 36,058', grand(a.after, a.takeHomeAfter), 36058);
}

console.log('\nthe order the letter prints, and what adds up\n');
{
  const e = withHist([{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-09', percent: 10 });
  check('the rate rises by the percentage typed', [a.oldRate, a.newRate], [30000, 33000]);
  // Grand Total is now take home plus BOTH sides of PF and ESI plus PT, so it
  // no longer equals the Rate of Pay — it is what HR's letters have always
  // called Gross, and it must reconcile as the sum of the printed lines.
  const grand = (p, t) => Math.round(t + p.pf + p.pfEmployer + p.esi + (p.esiEmployer || 0) + p.pt);
  check('the printed lines add up to the grand total on the previous side',
        grand(a.before, a.takeHomeBefore),
        Math.round(a.takeHomeBefore + a.before.pf + a.before.pfEmployer + a.before.pt));
  check('and the employer share is on the record, not assumed equal',
        Math.round(a.after.pfEmployer) > 0, true);
  check('take home is still gross less the employee-side deductions only',
        Math.round(a.after.salaryGross - a.after.pf - a.after.esi - a.after.pt),
        Math.round(a.takeHomeAfter));
}

console.log('\nheadings that attract nothing\n');
{
  const e = Object.assign({}, EMP, { salaryHeading: 'apprentice', ratePay: 12000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 12000, salaryHeading: 'apprentice' }] });
  const a = L.appraisalFigures(e, { ym: '2026-09', percent: 10 });
  check('an Apprentice attracts none of the three',
        [a.applies.pf, a.applies.esi, a.applies.pt], [false, false, false]);
  check('so take home and grand total are the same figure',
        [Math.round(a.takeHomeAfter), Math.round(a.after.salaryGross)], [13200, 13200]);
}
{
  // A heading change recorded with the increment must be honoured on the
  // revised side and not applied retrospectively to the previous one.
  const e = withHist([{ from: '2020-01-01', ratePay: 20000, salaryHeading: 'junior' },
                      { from: '2026-07-01', ratePay: 24000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-07' });
  check('the previous side keeps the old heading\'s split',
        Math.round(a.before.basic), 20000);          // junior is a flat basic
  check('and the revised side uses the new one',
        Math.round(a.after.basic), Math.round(24000 * 0.65));
}

console.log('\nevery employee for one month\n');
{
  const roster = [
    withHist([{ from: '2020-01-01', ratePay: 10000 }, { from: '2026-07-01', ratePay: 11000 }]),
    Object.assign({}, withHist([{ from: '2020-01-01', ratePay: 20000 }]), { id: 'E2', name: 'Bhavesh' }),
    Object.assign({}, withHist([{ from: '2020-01-01', ratePay: 15000 }]),
                  { id: 'E3', name: 'Left One', employmentStatus: 'left' })
  ];
  const rows = L.appraisalRoster(roster, { ym: '2026-07', percent: 10 });
  check('somebody who has left is not appraised', rows.map(r => r.name), ['Tushar', 'Bhavesh']);
  // One with the rise on record, one without — each handled on its own terms
  // in the same pass, which is the point of doing the whole roster at once.
  check('the one already increased reports his recorded rise',
        [rows[0].figures.oldRate, rows[0].figures.newRate, rows[0].figures.alreadyRecorded],
        [10000, 11000, true]);
  check('the one not yet increased gets the proposal',
        [rows[1].figures.oldRate, rows[1].figures.newRate, rows[1].figures.alreadyRecorded],
        [20000, 22000, false]);
  // getEmployees() hands the roster over in HR's own sequence order; re-sorting
  // it here is the one thing that would break every screen's agreement on it.
  check('the roster order it was given is the order it comes back in',
        rows.map(r => r.id), ['E1', 'E2']);
  check('an empty roster is an empty list, not an error', L.appraisalRoster([], { ym: '2026-07' }), []);
  check('and a missing one does not throw', L.appraisalRoster(null, { ym: '2026-07' }), []);
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
