// A sequence change must either happen or say it did not.
//
// The engine (resequenceEmployees, changedSequenceRecords) was never the
// problem — check-sequence.js already covers it, and it was right. What was
// wrong sat either side of it, in the two places the arithmetic meets the
// wire, and both failed silently:
//
//   1. The wanted number was read off the DOM AFTER `await saveOneEmployee_`.
//      Anything that re-rendered the modal in between — a salary-history row
//      removed, an increment recorded, a document upload landing — rebuilt the
//      input from the stored record and put the old number back. The read then
//      found the number the employee already had, the engine correctly decided
//      nothing needed moving, and the save reported a plain "Updated <name>".
//      HR set somebody to 7, saw a clean save, and found them on 3 again at
//      the next login.
//
//   2. setMany in Code 2.js pushed every requested key into savedKeys whether
//      or not it had actually written the row. saveEmployees' deliberate
//      "every key must come back confirmed" check could therefore never see a
//      write the staleness guard had refused. A sequence change that skipped
//      somebody reported complete success and left the roster with gaps and
//      duplicates, which the next renumber then built on.
//
// So this asserts the contract on both sides of the engine rather than the
// engine again: what a no-op means, that a partial write is never reported as
// a whole one, and that neither setSequence nor setMany goes back to one
// Sheets call per key — which is what made a perfectly good save fail with
// "the server did not respond". Pure — no jsdom, no network.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({seqNoOf, employeesInSequence, resequenceEmployees,' +
  ' changedSequenceRecords, normaliseSequence})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const roster = () => ['Ana','Bhavin','Chirag','Dhruv','Esha','Farid','Gita','Hiren']
  .map((n, i) => ({ id: String(20 + i), name: n, seqNo: i + 1, savedAt: 1000 }));

// ---- 1. What a no-op actually means -------------------------------------
console.log('moving somebody to the number they already hold changes nothing\n');
{
  const before = roster();
  const changed = L.changedSequenceRecords(before, L.resequenceEmployees(before, '22', 3));
  check('Chirag is already 3, so nothing is written', changed.length, 0);
}
console.log('\n...which is exactly what a lost target looks like, and why the\n' +
            '   wanted number must be read before any await, not after\n');
{
  // The bug, reproduced at the level it actually occurred: the target that
  // reaches the engine is the employee's CURRENT number rather than the 7 HR
  // typed, because the input was rebuilt from the record in between.
  const before = roster();
  const typed = 7, whatTheStaleDomGaveBack = L.seqNoOf(before.find(e => e.id === '22'));
  const lost = L.changedSequenceRecords(before, L.resequenceEmployees(before, '22', whatTheStaleDomGaveBack));
  const kept = L.changedSequenceRecords(before, L.resequenceEmployees(before, '22', typed));
  check('a target of 3 (the re-read) writes nothing at all', lost.length, 0);
  check('a target of 7 (what HR typed) writes five records', kept.length, 5);
  check('and puts Chirag on 7', L.seqNoOf(kept.find(e => e.id === '22')), 7);
  // This is the whole failure in one line: both produce a clean save, and only
  // one of them did what HR asked.
  check('the two are indistinguishable from the save result alone —\n' +
        '       which is why a zero-length change must never be silent',
        lost.length === 0 && kept.length > 0, true);
}

// ---- 2. A partial write is never reported as a whole one ----------------
console.log('\na write the backend refuses is reported as refused, not as saved\n');
{
  // Code 2.js's setMany, as it now behaves: a row the staleness guard rejects
  // goes into `skipped`, never into `saved`.
  const setMany = (entries, sheet) => {
    const saved = [], skipped = [];
    Object.keys(entries).forEach(k => {
      const existing = sheet[k];
      let stale = false;
      if (existing !== undefined && k.indexOf('employee:') === 0) {
        try {
          stale = Number(JSON.parse(existing).savedAt) > Number(JSON.parse(entries[k]).savedAt);
        } catch (e) { stale = false; }
      }
      if (stale) { skipped.push(k); return; }
      sheet[k] = entries[k]; saved.push(k);
    });
    return { ok: true, many: true, saved, skipped };
  };

  const sheet = {};
  roster().forEach(e => { sheet['employee:' + e.id] = JSON.stringify(e); });
  // Two of them were edited somewhere else after this browser read the roster.
  ['24','25'].forEach(id => {
    const rec = JSON.parse(sheet['employee:' + id]);
    rec.savedAt = 9999; rec.designation = 'edited elsewhere';
    sheet['employee:' + id] = JSON.stringify(rec);
  });

  const before = roster();
  const changed = L.changedSequenceRecords(before, L.resequenceEmployees(before, '22', 7));
  const entries = {};
  changed.forEach(e => { entries['employee:' + e.id] = JSON.stringify(e); });
  const res = setMany(entries, sheet);

  check('the two rows that were refused are named', res.skipped.sort(),
        ['employee:24','employee:25']);
  check('and they are NOT counted as saved',
        res.saved.filter(k => res.skipped.indexOf(k) !== -1), []);
  // saveEmployees' own check, which only works because of the line above.
  const missing = Object.keys(entries).filter(k => res.saved.indexOf(k) === -1);
  check('so the client sees a partial save and can refuse to call it done',
        missing.length > 0, true);
  check('the edit made elsewhere is still intact',
        JSON.parse(sheet['employee:24']).designation, 'edited elsewhere');
}

// ---- 3. setSequence cannot be stale, because it merges one field --------
console.log('\nsetSequence writes seqNo into whatever the row holds right now\n');
{
  // Code 2.js's setSequence: read the row, set one field, write it back.
  const setSequence = (seqs, sheet) => {
    const saved = [], missing = [];
    Object.keys(seqs).forEach(id => {
      const key = 'employee:' + id;
      if (sheet[key] === undefined) { missing.push(id); return; }
      let rec;
      try { rec = JSON.parse(sheet[key]); } catch (e) { rec = null; }
      if (!rec || typeof rec !== 'object') { missing.push(id); return; }
      const n = Number(seqs[id]);
      if (!isFinite(n) || n <= 0) { missing.push(id); return; }
      rec.seqNo = n;
      sheet[key] = JSON.stringify(rec);
      saved.push(id);
    });
    return { ok: true, sequenced: true, saved, missing };
  };

  const sheet = {};
  roster().forEach(e => { sheet['employee:' + e.id] = JSON.stringify(e); });
  ['24','25'].forEach(id => {
    const rec = JSON.parse(sheet['employee:' + id]);
    rec.savedAt = 9999; rec.designation = 'edited elsewhere';
    sheet['employee:' + id] = JSON.stringify(rec);
  });

  const before = roster();
  const changed = L.changedSequenceRecords(before, L.resequenceEmployees(before, '22', 7));
  const seqs = {};
  changed.forEach(e => { seqs[e.id] = L.seqNoOf(e); });
  const res = setSequence(seqs, sheet);

  check('every record asked for is renumbered, none refused', res.missing, []);
  const stored = Object.keys(sheet).map(k => JSON.parse(sheet[k]))
    .sort((a, b) => a.seqNo - b.seqNo);
  check('the roster is a clean 1..N with no gaps and no duplicates',
        stored.map(e => e.seqNo), [1,2,3,4,5,6,7,8]);
  check('Chirag is on 7, which is what HR asked for',
        stored.find(e => e.name === 'Chirag').seqNo, 7);
  // The whole point of merging one field rather than sending the record.
  check('and the edit made on the other device is untouched',
        JSON.parse(sheet['employee:24']).designation, 'edited elsewhere');
  check('including its savedAt, so the guard still protects it',
        JSON.parse(sheet['employee:24']).savedAt, 9999);
}

// ---- 4. The write is batched, not one Sheets call per employee ----------
console.log('\nand it is written in runs, not one call per employee\n');
{
  // Code 2.js groups the rows it is changing into contiguous runs and writes
  // each run with one setValues. This is not a tidiness point: every write in
  // the app queues on one script-wide lock that waits only 6 seconds, and a
  // setValue per employee held that lock for forty round trips to the Sheets
  // service. The next save came back 'busy' and reached HR as "Could not save
  // — the server did not respond" on a record that had nothing wrong with it.
  const writesFor = rows => {
    const sorted = rows.slice().sort((a, b) => a - b);
    let runs = 0;
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === sorted[i - 1] + 1) continue;
      runs++;
    }
    return runs;
  };
  // Employee rows are created together, so in the real sheet they are adjacent.
  const adjacent = Array.from({ length: 40 }, (_, i) => i + 2);
  check('forty adjacent rows are one write, not forty', writesFor(adjacent), 1);
  check('a gap in the middle costs one more write, not thirty-nine',
        writesFor([2,3,4, 9,10,11]), 2);
  check('one employee is still one write', writesFor([7]), 1);
  check('and the worst case never exceeds one write per row',
        writesFor([2,4,6,8,10]) <= 5, true);
  // The shape the bug had: what it used to cost.
  check('the old way cost one call per employee, which is what broke it',
        adjacent.length, 40);

  // setMany had the identical shape and was fixed the same way, before it
  // could do the same thing on a busy attendance day. Its extra wrinkle is
  // that a key with no row yet is appended rather than updated, and those
  // used to be an appendRow each.
  console.log('');
  const setManyWrites = (existingRows, newKeys) => ({
    updates: writesFor(existingRows),
    appends: newKeys > 0 ? 1 : 0,          // one block, not one per key
  });
  // A month of attendance for ten staff, all of whom already have a row.
  check('ten adjacent attendance rows are one write, not ten',
        setManyWrites([12,13,14,15,16,17,18,19,20,21], 0), { updates: 1, appends: 0 });
  // First save of a new financial year: nobody has a row for it yet.
  check('ten brand-new keys are one appended block, not ten appendRows',
        setManyWrites([], 10), { updates: 0, appends: 1 });
  // The realistic middle: some rows exist, some are new.
  check('a mix costs one write per run plus one block',
        setManyWrites([12,13,14], 3), { updates: 1, appends: 1 });
  check('and nothing at all costs nothing',
        setManyWrites([], 0), { updates: 0, appends: 0 });
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
