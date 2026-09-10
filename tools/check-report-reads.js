// A report shows the month's real figures, or it shows nothing. Never ₹0.
//
// Two faults met on 10 September 2026 and produced the same report, on the same
// login, with two different grand totals on two phones — ₹8,46,321 on one and
// ₹2,67,573 on the other, Behra Abhimanyu at ₹27,580 against ₹0.
//
// 1. A finalised month was only put in force by ONE screen. usePayrollLocks_
//    was called from renderSalarySheet and nowhere else, so the Final Salary
//    Sheet for Accountant, both statutory returns, the Consultant Report, the
//    Consultant Summary, the Apprentice report and the salary slips recomputed
//    a finalised month from scratch — unless HR happened to have opened the
//    Salary Sheet earlier in the same session, which is what made it look
//    random and device-specific.
//
// 2. A failed attendance read was handed back as {} — an employee with no
//    attendance. computeAttendanceSummary scores every unmarked past day as
//    Absent, so {} for a month somebody worked is a salary of ₹0: printed,
//    added into the grand total, and filed to Drive over the correct copy,
//    with nothing on screen to say a read had failed. This is the same fault
//    the SAVE side had (tools/check-attendance-save.js); the read side kept
//    it, where it is worse, because a wrong figure on a report gets paid.
//
// Together they are exactly the shape below: attendance that cannot be read
// PLUS a lock that was never loaded is ₹0 for everybody, and either one being
// right on its own is enough to stop it.
//
// Kept rather than thrown away, against the usual convention for screen
// harnesses, because what it protects is a month of payroll that has already
// been paid, and because the code it covers only exists as browser functions.
//
//   npm install jsdom      (once)
//   node tools/check-report-reads.js
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

const YM = '2026-08';
// Written out rather than read off the page. PAYROLL_LOCK_INDEX_KEY is a
// top-level const in the shared file, so it is NOT a property of window — see
// CLAUDE.md — and `key === w.PAYROLL_LOCK_INDEX_KEY` compared against undefined,
// so the stubs below answered null for the index as well. That reads as "no
// month is finalised", which is the very fault being tested, and it made three
// checks fail for a reason that had nothing to do with the app.
const IDX_KEY = 'payrollLocks';
const EMP = { id: '39', name: 'Behra Abhimanyu Govind Bhai', employmentStatus: 'active',
              employeeType: 'field', doj: '2020-01-01', salaryHeading: 'contractor',
              ratePay: 28000, bankName: 'STATE BANK OF INDIA',
              accountNumber: '10140664401', ifsc: 'SBIN0001456' };

setTimeout(async () => {
  try{
    // ---------- the read path tells "nothing recorded" from "could not read" ----------
    console.log('an attendance read that failed is not an employee with no attendance\n');
    {
      w.eval('sharedReadCache.clear()');
      w.backendAction = async () => null;                       // busy, or no answer
      let threw = null;
      try{ await w.getAttendance('39'); }catch(e){ threw = e; }
      check('one employee: it refuses rather than answering {}', !!(threw && threw.readFailed), true);

      w.eval('sharedReadCache.clear()');
      threw = null;
      try{ await w.getAttendanceMany(['39']); }catch(e){ threw = e; }
      check('  and so does the batch every report reads through',
            !!(threw && threw.readFailed), true);

      // The opposite bug would be refusing for somebody who genuinely has
      // nothing recorded — a new joiner, or a month nobody has filled in yet.
      w.eval('sharedReadCache.clear()');
      w.backendAction = async () => ({ values: {} });            // answered: nothing stored
      check('an employee with genuinely nothing recorded still reads as empty',
            await w.getAttendance('39'), {});
    }

    // ---------- the finalised month is never silently unlocked ----------
    console.log('\na finalised month that cannot be read stops the report\n');
    {
      const reset = () => {
        w.eval('payrollLockIndex_ = null');
        w.eval('Object.keys(payrollLockRows_).forEach(k => delete payrollLockRows_[k])');
        w.eval('payrollLockMonthsRead_.clear()');
        w.eval('sharedReadCache.clear()');
        w.setPayrollLocks(null);
      };

      reset();
      w.safeGetOrThrow_ = async () => { const e = new Error('the server did not respond'); e.readFailed = true; throw e; };
      let threw = null;
      try{ await w.usePayrollLocks_(YM); }catch(e){ threw = e; }
      check('the index could not be read, so nothing is claimed either way',
            !!(threw && threw.readFailed), true);
      // THE assertion behind that one. safeGet answered null for a failed read
      // and for "nothing stored" alike, and the second reads as "no month is
      // finalised" — then cached it in payrollLockIndex_ for the rest of the
      // session, so one bad moment unlocked every finalised month on that
      // device until it was reloaded.
      check('  and nothing is remembered, so the next screen asks again',
            w.eval('payrollLockIndex_'), null);

      reset();
      w.safeGetOrThrow_ = async key =>
        key === IDX_KEY ? JSON.stringify({ [YM]: { lockedAt: '2026-09-09', employees: 1 } })
                                         : null;               // the month's figures are gone
      threw = null;
      try{ await w.usePayrollLocks_(YM); }catch(e){ threw = e; }
      check('finalised, but its figures are missing — refuses rather than recomputing',
            !!(threw && threw.readFailed), true);
    }

    // ---------- the report HR actually looked at ----------
    console.log('\nthe Final Salary Sheet for Accountant, on a finalised month\n');
    {
      // The month is finalised at ₹27,580. Attendance is deliberately empty:
      // an unlocked month over empty attendance is ₹0 — the exact figure the
      // second phone printed — so the only way a real salary reaches the page
      // is the lock actually being in force.
      const frozen = { netSalary: 27580, finalPayable: 27580, conveyance: 0, salaryGross: 27580,
                       basic: 13790, hra: 11032, lta: 2758, pfEmployee: 0, esiEmployee: 0, pt: 200,
                       totalDeduction: 0, leaveDays: 0, name: EMP.name };
      const packed = w.payrollLockPack({ '39': frozen });

      w.eval('payrollLockIndex_ = null');
      w.eval('Object.keys(payrollLockRows_).forEach(k => delete payrollLockRows_[k])');
      w.eval('payrollLockMonthsRead_.clear()');
      w.eval('sharedReadCache.clear()');
      w.setPayrollLocks(null);

      w.safeGetOrThrow_ = async key =>
        key === IDX_KEY ? JSON.stringify({ [YM]: { lockedAt: '2026-09-09', employees: 1 } })
                                         : JSON.stringify(packed);
      w.populateMonthYearSelects = () => {};
      w.getMonthYearValue = () => YM;
      w.getEmployees = async () => [EMP];
      w.getHolidayMap_local = async () => ({});
      w.getAttendanceMany = async () => ({ '39': {} });
      w.getAttendance = async () => ({});
      w.isCompactSheetView = () => false;
      const filed = [];
      w.queueFileToDrive = (folder, file) => { filed.push(file); };
      w.stashReportShare = () => {};
      w.openFullscreenView = () => {};

      await w.renderFinalSalarySheet();

      check('it establishes whether the month is finalised',
            w.isPayrollMonthLocked(YM), true);
      const text = w.document.getElementById('finalSalaryBox').textContent.replace(/\s+/g, ' ');
      // ₹27,580 as fmtMoney renders it — the frozen figure, not a recomputation.
      check('  and prints the figure it was finalised at', /27,580/.test(text), true);
      check('  not the ₹0 an empty month recomputes to', /₹0\b/.test(text), false);
      check('  the sheet was still filed to Drive', filed.length > 0, true);
    }

    // ---------- and the report a screen forgot to teach about locks ----------
    console.log('\na report that never establishes the month refuses, rather than paying wrongly\n');
    {
      w.setPayrollLocks({}, ['2026-07']);           // July looked up, August not
      const days = new Date(2026, 8, 0).getDate();
      const dateList = [];
      for(let d = 1; d <= days; d++) dateList.push(YM + '-' + String(d).padStart(2, '0'));
      let threw = null;
      try{ w.computeSalaryFromAttendance(EMP, {}, dateList, days, {}); }catch(e){ threw = e; }
      check('it raises instead of quietly computing a whole finalised-or-not month',
            !!(threw && threw.payrollLockNotEstablished === YM), true);
      w.setPayrollLocks(null);
    }

    // ---------- and no report is left out in the first place ----------
    //
    // The runtime guard above catches a report that forgot, but it catches it
    // in front of HR. This catches it here. Every top-level function that
    // prices a month — directly through computeSalaryForEmployee /
    // computeSalaryFromAttendance, or through one of the shared builders that
    // does it for them — must also establish whether that month is finalised.
    // Read statically, so a branch nothing exercises is covered exactly like
    // one that does; the same reason tools/check-shared-leaks.js exists.
    console.log('\nevery report that prices a month establishes whether it is finalised\n');
    {
      const src = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
      const PRICES = ['computeSalaryForEmployee(', 'computeSalaryFromAttendance(',
                      'statutoryReportData(', 'salarySheetCsv(', 'finalSalarySheetCsv(',
                      'wageRegisterRows(', 'consultantSummaryTotals('];
      // The two that define or freeze the calculation rather than reporting it.
      const EXEMPT = ['computeSalaryForEmployee', 'finalisePayrollMonth'];
      const lines = src.split('\n');
      const fns = [];
      lines.forEach((line, i) => {
        const m = /^(?:async )?function ([A-Za-z0-9_$]+)\s*\(/.exec(line);
        if(m) fns.push({ name: m[1], from: i });
      });
      fns.forEach((f, i) => { f.to = i + 1 < fns.length ? fns[i + 1].from : lines.length; });
      const missing = [];
      fns.forEach(f => {
        if(EXEMPT.indexOf(f.name) !== -1) return;
        const body = lines.slice(f.from, f.to)
          .map(l => l.replace(/^\s*\/\/.*$/, ''))     // a mention in a comment is not a call
          .join('\n');
        if(!PRICES.some(p => body.indexOf(p) !== -1)) return;
        if(body.indexOf('usePayrollLocks_(') === -1) missing.push(f.name);
      });
      check('no report prices a month without establishing it', missing, []);
    }

    if(pageErrors.length){
      console.log('\nPAGE ERRORS:\n' + pageErrors.join('\n'));
      fails.push('page errors');
    }
    console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
    process.exit(fails.length ? 1 : 0);
  }catch(e){
    console.log('threw: ' + (e && e.stack));
    if(pageErrors.length) console.log('PAGE ERRORS:\n' + pageErrors.join('\n'));
    process.exit(1);
  }
}, 1200);
