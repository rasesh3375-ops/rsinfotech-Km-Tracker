// Saving attendance must never delete the days it was not asked to change.
//
// The Attendance Sheet writes one key per employee per financial year, and the
// payload REPLACES that key. So the save first reads what is already recorded
// and merges the edits into it. getAttendanceBuckets used to answer {} for a
// read that failed, exactly as it does for an employee with nothing recorded —
// and the two are not the same thing at all. A failed read meant the save wrote
// only the handful of days being edited and deleted the rest of that year.
// Reload, and every other day is unmarked; an unmarked past day scores as
// Absent. HR edited a few cells, pressed Save, and the month came back with
// everybody absent.
//
// It only bit when a read failed, which on a backend whose write lock waits six
// seconds is precisely when the sheet is busiest, so it looked random.
//
// This drives the real save function in jsdom against a fake backend, because
// the bug lives in the seam between the read and the write and neither half
// looks wrong on its own. It is kept rather than thrown away, against the usual
// convention for screen harnesses, because what it protects is a month of
// somebody's attendance and therefore their pay.
//
//   npm install jsdom      (once)
//   node tools/check-attendance-save.js
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

// A month already on record: 1-20 August all Present.
const EXISTING = {};
for(let d = 1; d <= 20; d++) EXISTING['2026-08-' + String(d).padStart(2, '0')] = { code: 'P' };
const KEY = 'attendance:8:2026-27';

setTimeout(async () => {
  try{
    const alerts = [];
    w.alert = m => alerts.push(String(m));
    w.getEmployees = async () => [{ id: '8', name: 'Hardikbhai Parmar', employmentStatus: 'active',
      employeeType: 'office', salaryHeading: 'senior', ratePay: 28000, doj: '2020-01-01' }];
    w.getAttendanceMany = async () => ({ '8': EXISTING });
    w.getHolidayMap_local = async () => ({});
    w.checkAttendanceAgainstPolicy = async () => ({ violations: [] });
    w.addActivityLog = async () => {};
    w.invalidateDashboardSnapshot = () => {};
    w.renderAttendanceSheet = async () => {};
    w.updateAttendanceSaveBar = () => {};
    w.persistPendingAttendance = () => {};
    w.showSavedToast = () => {};
    w.primeSharedRead = () => {};
    w.invalidateSharedRead = () => {};

    // Kept before run() replaces it with a stub — the last block below tests
    // the real one, and testing the stub proves nothing.
    const realBuckets = w.getAttendanceBuckets;

    // Two edits, on days the record does not yet mention.
    const edits = {
      '8|2026-08-25': { employeeId: '8', dateStr: '2026-08-25', code: 'P' },
      '8|2026-08-26': { employeeId: '8', dateStr: '2026-08-26', code: 'EL' }
    };
    const written = {};
    const run = async (bucketsFn) => {
      Object.keys(written).forEach(k => delete written[k]);
      alerts.length = 0;
      w.eval('pendingAttendance = ' + JSON.stringify(edits));
      w.getAttendanceBuckets = bucketsFn;
      w.remoteSetMany = async entries => {
        Object.assign(written, entries);
        return new Set(Object.keys(entries));
      };
      w.remoteSet = async (k, v) => { written[k] = v; return true; };
      await w.saveAttendanceChanges();
      return written[KEY] ? JSON.parse(written[KEY]) : null;
    };

    console.log('the read succeeded — the edits are merged in\n');
    {
      const out = await run(async () => ({ '8|2026-27': Object.assign({}, EXISTING) }));
      check('every day already recorded is still there', Object.keys(out).length, 22);
      check('  the first of the month included', out['2026-08-01'], { code: 'P' });
      check('  and the two new days were added',
            [out['2026-08-25'].code, out['2026-08-26'].code], ['P', 'EL']);
      check('  with nothing left pending', Object.keys(w.eval('pendingAttendance')).length, 0);
    }

    console.log('\nthe read FAILED — nothing may be written\n');
    {
      // THE assertion. Before the fix this wrote a two-day record over a
      // twenty-day one and August came back almost entirely absent.
      const out = await run(async () => ({ '8|2026-27': null }));
      check('nothing at all is written for that employee-year', out, null);
      check('  the edits stay pending so Save can be pressed again',
            Object.keys(w.eval('pendingAttendance')).sort(),
            ['8|2026-08-25', '8|2026-08-26']);
      check('  and HR is told, rather than shown a success',
            /could not be saved/.test(alerts.join('|')), true);
      check('  in words that say why nothing was written',
            /erased the rest of their year/.test(alerts.join('|')), true);
    }
    {
      // A bucket the read simply never mentioned is the same danger.
      const out = await run(async () => ({}));
      check('a bucket missing from the read is not written either', out, null);
      check('  and its edits stay pending', Object.keys(w.eval('pendingAttendance')).length, 2);
    }

    console.log('\nan employee with genuinely nothing recorded still saves\n');
    {
      // {} must keep working — a new joiner has no record, and refusing to
      // write for them would be the opposite bug.
      const out = await run(async () => ({ '8|2026-27': {} }));
      check('an empty record is written with just the new days',
            out && Object.keys(out).sort(), ['2026-08-25', '2026-08-26']);
      check('  and nothing is left pending', Object.keys(w.eval('pendingAttendance')).length, 0);
    }

    console.log('\ngetAttendanceBuckets tells empty from unreadable\n');
    {
      // The distinction the whole fix rests on, checked at its source.
      w.eval('sharedReadCache.clear()');
      w.backendAction = async () => null;              // busy, or an older backend
      w.safeGetOrThrow_ = async () => { throw new Error('the backend did not answer'); };
      const bad = await realBuckets([{ employeeId: '8', fy: '2026-27' }]);
      check('a read that failed answers null', bad['8|2026-27'], null);

      w.eval('sharedReadCache.clear()');
      w.safeGetOrThrow_ = async () => null;            // answered: no such key
      const none = await realBuckets([{ employeeId: '8', fy: '2026-27' }]);
      check('a key that was never set answers empty', none['8|2026-27'], {});

      w.eval('sharedReadCache.clear()');
      w.safeGetOrThrow_ = async () => '{not json';     // stored value is corrupt
      const bent = await realBuckets([{ employeeId: '8', fy: '2026-27' }]);
      check('and something unparseable is unreadable, not empty', bent['8|2026-27'], null);
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
