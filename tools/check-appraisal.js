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
  // The same employee, same history, asked for TODAY's month instead — where
  // nothing is recorded. Now the percentage is a proposal and does apply.
  const e = withHist([{ from: '2020-01-01', ratePay: 10000, salaryHeading: 'managerial' },
                      { from: '2026-07-01', ratePay: 11000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-09', percent: 10 });
  check('a month with no increment applies the percentage as a proposal',
        [a.oldRate, a.newRate], [11000, 12100]);
  check('and says it is not yet on the record', a.alreadyRecorded, false);
  // It must start from the July rate, not the original 10,000.
  check('starting from the rate actually in force that month', a.oldRate, 11000);
}
{
  // Generating the July letter twice must not compound.
  const e = withHist([{ from: '2020-01-01', ratePay: 10000, salaryHeading: 'managerial' },
                      { from: '2026-07-01', ratePay: 11000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-07', percent: 10 });
  const b = L.appraisalFigures(e, { ym: '2026-07', percent: 10 });
  check('generating the same letter twice gives the same figures',
        [a.oldRate, a.newRate], [b.oldRate, b.newRate]);
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

console.log('\nan employee whose first record IS the increment\n');
{
  const e = withHist([{ from: '2026-07-01', ratePay: 11000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-07', percent: 10 });
  // There is no earlier rate, so there is nothing honest to call a previous
  // salary — and 0% would be a claim, not a blank.
  check('it says there is no previous salary to state', a.hasPrevious, false);
  check('and does not invent a rise', [a.oldRate, a.newRate], [11000, 11000]);
}

console.log('\nthe order the letter prints, and what adds up\n');
{
  const e = withHist([{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' }]);
  const a = L.appraisalFigures(e, { ym: '2026-09', percent: 10 });
  check('the rate rises by the percentage typed', [a.oldRate, a.newRate], [30000, 33000]);
  // Grand total is take home plus the three deductions, and must come back to
  // the gross — that is what makes the block on the letter checkable by eye.
  const grand = p => Math.round(p.salaryGross + p.other + p.conveyance);
  check('previous take home plus PT, PF and ESI is the previous grand total',
        Math.round(a.takeHomeBefore + a.before.pt + a.before.pf + a.before.esi), grand(a.before));
  check('and the same holds on the revised side',
        Math.round(a.takeHomeAfter + a.after.pt + a.after.pf + a.after.esi), grand(a.after));
  check('the grand totals are the two rates of pay', [grand(a.before), grand(a.after)], [30000, 33000]);
  // Take home does not move by the rate's percentage: PT is flat and PF caps.
  check('take home moves by its own amount, not the rate\'s percentage',
        [Math.round(a.takeHomeBefore), Math.round(a.takeHomeAfter)], [28000, 31000]);
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
