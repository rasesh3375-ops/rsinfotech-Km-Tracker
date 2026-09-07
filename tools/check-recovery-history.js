// Changing or stopping a recurring recovery must not restate months already paid.
//
// This is the one that reached the bank. Hardikbhai Parmar was on an Advance
// for Temporary of ₹1,600. May, June and July 2026 were all paid with it
// deducted. HR then stopped it — by clearing the flat rate on the Employee
// form, which was the obvious way to do it — and the Employee form rebuilt the
// schedule's whole history from that one field. The June and July Salary
// Sheets, regenerated afterwards, read ₹0 for him. Nothing had gone wrong at
// the bank; the record had simply forgotten what it had been paying, and every
// past sheet silently restated itself to match.
//
// The loan carried the identical hole, and worse: loanEmiHistoryOf falls back
// to the flat instalment for EVERY month when emiHistory is empty, and
// loanScheduleThrough walks the schedule from the start month, so a changed
// EMI moved the balance carried forward too.
//
// The rule both now follow: an edit to a rate that has ALREADY RUN becomes a
// dated change from the current month, leaving every earlier month on the rate
// it was actually paid. A schedule that has never deducted anything is still
// edited in place — there is no history to protect, and that is what keeps a
// fresh entry (or one already flattened to nil) repairable.
//
// The collect functions live in index.html and read the DOM, so this drives
// them the way the browser does: the real page in jsdom, real form fields,
// real save path. It is the one screen-level check kept in the repo rather
// than thrown away, because what it protects is months of paid salary.
//
//   npm install jsdom      (once)
//   node tools/check-recovery-history.js
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('  SKIP  jsdom is not installed — run `npm install jsdom` to run this check.');
  process.exit(0);
}

let html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
html = html.replace('<script src="/shared/report-logic.js"></script>',
  '<script>' + fs.readFileSync(path.join(R, 'shared', 'report-logic.js'), 'utf8') + '</script>');

const pageErrors = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.test/hr/',
  beforeParse(w){
    w.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){},
                            addEventListener(){}, removeEventListener(){} });
    w.fetch = async () => ({ ok:true, status:200, text:async()=>'{}', json:async()=>({ok:true}) });
    w.alert = () => {}; w.confirm = () => true;
    w.addEventListener('error', e => pageErrors.push(e.error && e.error.stack));
  }});
const w = dom.window;

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

setTimeout(() => {
  try {
    const thisYm = w.eval('todayStr()').slice(0, 7);
    const doc = w.document;

    // ---- Advance for Temporary -------------------------------------------
    // Drives the real form: set the draft, render the box, type into the
    // field the way HR does, then collect. Nothing is stubbed.
    const advCollect = (schedule, typedRate, typedStart) => {
      w.eval('editingEmployeeDraft = ' + JSON.stringify({ advanceTempSchedule: schedule }));
      let box = doc.getElementById('advanceTempScheduleBox');
      if(!box){ box = doc.createElement('div'); box.id = 'advanceTempScheduleBox'; doc.body.appendChild(box); }
      w.eval('renderAdvanceTempSchedule()');
      const rateEl = doc.getElementById('advTemp_rate');
      const startEl = doc.getElementById('advTemp_start');
      if(typedRate !== undefined) rateEl.value = String(typedRate);
      if(typedStart !== undefined) startEl.value = typedStart;
      w.eval('syncAdvanceTempSchedule()');
      return w.eval('collectAdvanceTempSchedule()');
    };
    const advAt = (out, ym) => w.eval('advanceTempForMonth')({ advanceTempSchedule: out }, ym);

    console.log('stopping an Advance for Temporary that has already run\n');
    {
      // Hardikbhai's case exactly: ₹1,600 from May, cleared to nil in September.
      const out = advCollect({ startMonth: '2026-05', instalment: 1600,
                               rateHistory: [{ from: '2026-05', instalment: 1600 }] }, 0);
      check('May, June and July keep the ₹1,600 they were paid on',
            ['2026-05', '2026-06', '2026-07'].map(m => advAt(out, m)), [1600, 1600, 1600]);
      check('and it stops from the month it was actually stopped in',
            advAt(out, thisYm), 0);
      check('the stop is recorded as a dated entry, not a rewrite',
            out.rateHistory.length, 2);
      check('with the original rate still first', out.rateHistory[0].instalment, 1600);
    }
    {
      // The same edit, but raising the rate rather than stopping it.
      const out = advCollect({ startMonth: '2026-05', instalment: 1600,
                               rateHistory: [{ from: '2026-05', instalment: 1600 }] }, 2000);
      check('a raise leaves the earlier months alone too', advAt(out, '2026-06'), 1600);
      check('  and applies from this month on', advAt(out, thisYm), 2000);
    }
    {
      // A schedule with an existing dated history must not be disturbed at all.
      const hist = [{ from: '2026-04', instalment: 1000 }, { from: '2026-07', instalment: 500 }];
      const out = advCollect({ startMonth: '2026-04', instalment: 1000, rateHistory: hist });
      check('a schedule already carrying rate changes is saved untouched',
            out.rateHistory, hist);
      check('  and still resolves each month from its own entry',
            ['2026-05', '2026-08'].map(m => advAt(out, m)), [1000, 500]);
    }
    {
      // Nothing has ever been deducted, so there is no history to protect and
      // the figure must stay directly editable — this is what makes repairing
      // a schedule already flattened to nil possible.
      const out = advCollect({ startMonth: '2026-05', instalment: 0, rateHistory: [] }, 1600);
      check('a schedule that never deducted anything is edited in place',
            [out.rateHistory.length, advAt(out, '2026-05'), advAt(out, thisYm)], [1, 1600, 1600]);
    }
    {
      const out = advCollect({ startMonth: '', instalment: 0, rateHistory: [] }, 0);
      check('an empty schedule is still saved as nothing at all', out, null);
    }
    {
      // A schedule starting this month has no earlier month to protect, so the
      // edit lands on its one entry rather than dating a change against itself.
      const out = advCollect({ startMonth: thisYm, instalment: 900,
                               rateHistory: [{ from: thisYm, instalment: 900 }] }, 400);
      check('a schedule starting this month is corrected, not split',
            [out.rateHistory.length, advAt(out, thisYm)], [1, 400]);
    }

    // ---- Loan EMI ---------------------------------------------------------
    console.log('\nchanging the EMI on a loan that has already been recovering\n');
    const loanCollect = (loan, typedEmi) => {
      w.eval('editingEmployeeDraft = ' + JSON.stringify({ loans: [loan] }));
      let box = doc.getElementById('loanRowsBox');
      if(!box){ box = doc.createElement('div'); box.id = 'loanRowsBox'; doc.body.appendChild(box); }
      w.eval('renderLoanRows()');
      if(typedEmi !== undefined) doc.getElementById('loan_emi_0').value = String(typedEmi);
      w.eval('syncLoanRow(0)');
      return w.eval('collectLoanRows()')[0];
    };
    const emiAt = (loan, ym) => w.eval('loanEmiRateAsOf')(loan, ym);
    {
      const out = loanCollect({ id: 'L1', amount: 60000, instalment: 2000,
                                startMonth: '2026-04', status: 'active' }, 3000);
      check('months already recovered keep the ₹2,000 they were recovered at',
            ['2026-04', '2026-06', '2026-07'].map(m => emiAt(out, m)), [2000, 2000, 2000]);
      check('and the new EMI runs from this month on', emiAt(out, thisYm), 3000);
      check('the loan itself is not recreated',
            [out.id, out.amount, out.startMonth], ['L1', 60000, '2026-04']);
      check('and the change is a dated entry', out.emiHistory.length, 2);
    }
    {
      // Stopping the deduction outright is the same mechanism, EMI nil.
      const out = loanCollect({ id: 'L2', amount: 60000, instalment: 2500,
                                startMonth: '2026-04', status: 'active' }, 0);
      check('an EMI cleared to nil still leaves the recovered months alone',
            emiAt(out, '2026-06'), 2500);
      check('  and recovers nothing from now on', emiAt(out, thisYm), 0);
    }
    {
      const hist = [{ from: '2026-04', instalment: 2500 }, { from: '2026-06', instalment: 1500 }];
      const out = loanCollect({ id: 'L3', amount: 60000, instalment: 2500, startMonth: '2026-04',
                                status: 'active', emiHistory: hist });
      check('a loan already carrying EMI changes is saved untouched', out.emiHistory, hist);
    }
    {
      // Correcting a loan entered today, before it has recovered anything.
      const out = loanCollect({ id: 'L4', amount: 30000, instalment: 1000,
                                startMonth: thisYm, status: 'active' }, 1200);
      check('a loan starting this month is corrected, not split',
            [out.emiHistory.length, emiAt(out, thisYm)], [1, 1200]);
    }

    if(pageErrors.length){
      console.log('\nPAGE ERRORS:\n' + pageErrors.join('\n'));
      fails.push('page errors');
    }
    console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
    process.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.log('threw: ' + (e && e.stack));
    if(pageErrors.length) console.log('PAGE ERRORS:\n' + pageErrors.join('\n'));
    process.exit(1);
  }
}, 1200);
