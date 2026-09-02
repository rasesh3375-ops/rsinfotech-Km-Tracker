// The central sequence engine, on its own, before anything is wired to it.
//
// The rules HR gave: assigning a number that is taken pushes the holder down
// and everyone after them; moving someone rearranges the rest; no duplicates
// are ever left. Those are easy to satisfy for the one example and easy to get
// wrong everywhere else, so this checks the invariant — always a clean 1..N
// with every employee present exactly once — after every operation, including
// the awkward ones: moving UP the list, duplicates already in the data, gaps,
// blanks, and a roster where nobody has a number at all.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({seqNoOf, employeesInSequence, normaliseSequence,' +
  ' resequenceEmployees, changedSequenceRecords, SEQ_FIELD})', sb);

const fails = [];
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};
const names = list => list.map(e => e.name);
const seqs = list => list.map(e => e[L.SEQ_FIELD]);

// The invariant that must hold after every single operation.
function assertClean(label, list, expectedCount) {
  const s = seqs(list);
  const want = Array.from({ length: expectedCount }, (_, i) => i + 1);
  const ok = JSON.stringify(s.slice().sort((a, b) => a - b)) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + ' → 1..' + expectedCount +
              ', no gaps or duplicates  ' + JSON.stringify(s));
  if (!ok) fails.push(label + ' broke the invariant');
  const ids = list.map(e => e.id);
  if (new Set(ids).size !== ids.length) { console.log('  FAIL ' + label + ' lost or duplicated a record'); fails.push(label + ' lost a record'); }
}

const mk = (id, name, seq) => (seq === undefined ? { id, name } : { id, name, seqNo: seq });
const ROSTER = [mk('A','Amit',1), mk('B','Bhavesh',2), mk('C','Chirag',3),
                mk('D','Dinesh',4), mk('E','Esha',5)];

console.log('the example HR gave: assign 3 to someone new\n');
console.log('  before: ' + names(L.employeesInSequence(ROSTER)).join(', '));
let r = L.resequenceEmployees(ROSTER.concat([mk('F','Falgun')]), 'F', 3);
console.log('  after : ' + names(r).map((n, i) => (i + 1) + '.' + n).join('  '));
eq('the new person takes 3', r.find(e => e.id === 'F').seqNo, 3);
eq('the old 3 moved to 4', r.find(e => e.id === 'C').seqNo, 4);
eq('the old 4 moved to 5', r.find(e => e.id === 'D').seqNo, 5);
eq('the old 5 moved to 6', r.find(e => e.id === 'E').seqNo, 6);
eq('1 and 2 did not move', [r.find(e => e.id === 'A').seqNo, r.find(e => e.id === 'B').seqNo], [1, 2]);
assertClean('after inserting at 3', r, 6);

console.log('\nmoving someone who is already numbered\n');
r = L.resequenceEmployees(ROSTER, 'E', 2);          // 5 → 2, i.e. upwards
console.log('  Esha 5 → 2: ' + names(r).map((n, i) => (i + 1) + '.' + n).join('  '));
eq('Esha is now 2', r.find(e => e.id === 'E').seqNo, 2);
eq('Bhavesh slid to 3', r.find(e => e.id === 'B').seqNo, 3);
eq('Amit is untouched at 1', r.find(e => e.id === 'A').seqNo, 1);
assertClean('after moving up', r, 5);

r = L.resequenceEmployees(ROSTER, 'B', 5);          // 2 → 5, i.e. downwards
console.log('  Bhavesh 2 → 5: ' + names(r).map((n, i) => (i + 1) + '.' + n).join('  '));
eq('Bhavesh is now 5', r.find(e => e.id === 'B').seqNo, 5);
eq('everyone between shifted up one',
   [r.find(e => e.id === 'C').seqNo, r.find(e => e.id === 'D').seqNo, r.find(e => e.id === 'E').seqNo], [2, 3, 4]);
assertClean('after moving down', r, 5);

console.log('\nasking for a number outside the roster\n');
[[0, 1], [-5, 1], [1, 1], [99, 5], [5, 5]].forEach(([ask, want]) => {
  const out = L.resequenceEmployees(ROSTER, 'C', ask);
  eq('asking for ' + ask + ' lands at ' + want, out.find(e => e.id === 'C').seqNo, want);
  assertClean('after asking for ' + ask, out, 5);
});

console.log('\ndata that is already wrong: duplicates, gaps and blanks\n');
const MESSY = [mk('A','Amit',3), mk('B','Bhavesh',3), mk('C','Chirag'),
               mk('D','Dinesh',900), mk('E','Esha',0), mk('F','Falgun',1)];
console.log('  stored: ' + MESSY.map(e => e.name + '=' + (e.seqNo === undefined ? 'blank' : e.seqNo)).join('  '));
let fixed = L.normaliseSequence(MESSY);
console.log('  fixed : ' + names(fixed).map((n, i) => (i + 1) + '.' + n).join('  '));
assertClean('normalising messy data', fixed, 6);
eq('the two who shared 3 keep their relative order, by name',
   [fixed.find(e => e.id === 'A').seqNo, fixed.find(e => e.id === 'B').seqNo], [2, 3]);
eq('the one real 1 stays first', fixed.find(e => e.id === 'F').seqNo, 1);
eq('a blank sorts after everyone numbered', fixed.find(e => e.id === 'C').seqNo > fixed.find(e => e.id === 'D').seqNo, true);
eq('0 is treated as unset, not as first', fixed.find(e => e.id === 'E').seqNo > 1, true);
// Resequencing messy data must clean it up in the same pass.
const fromMessy = L.resequenceEmployees(MESSY, 'D', 2);
assertClean('resequencing straight from messy data', fromMessy, 6);
eq('and the move still lands where asked', fromMessy.find(e => e.id === 'D').seqNo, 2);

console.log('\nnobody numbered at all — a roster before the migration runs\n');
const FRESH = ['Zoya','Amit','Meera'].map((n, i) => mk('id' + i, n));
const seeded = L.normaliseSequence(FRESH);
console.log('  ' + names(seeded).map((n, i) => (i + 1) + '.' + n).join('  '));
assertClean('seeding an unnumbered roster', seeded, 3);
eq('it falls back to name order', names(seeded), ['Amit','Meera','Zoya']);

console.log('\nrepeated operations never drift\n');
let live = ROSTER.slice();
const ids = ['A','B','C','D','E'];
for (let i = 0; i < 60; i++) {
  const who = ids[i % ids.length];
  const to = (i * 7) % 7;                      // deliberately includes 0 and 6
  live = L.resequenceEmployees(live, who, to);
}
assertClean('after 60 moves', live, 5);
console.log('  final: ' + names(live).map((n, i) => (i + 1) + '.' + n).join('  '));

console.log('\nonly the records that actually moved are written back\n');
const after = L.resequenceEmployees(ROSTER, 'E', 4);
const changed = L.changedSequenceRecords(ROSTER, after);
console.log('  moving Esha 5 → 4 changes: ' + names(changed).join(', '));
eq('two records changed, not the whole roster', changed.length, 2);
eq('and they are the two that swapped', names(changed).sort(), ['Dinesh','Esha']);
const none = L.changedSequenceRecords(ROSTER, L.resequenceEmployees(ROSTER, 'C', 3));
eq('moving somebody to the number they already hold writes nothing', none.length, 0);

console.log('\nnothing is mutated in place\n');
const snapshot = JSON.stringify(ROSTER);
L.resequenceEmployees(ROSTER, 'A', 5);
L.normaliseSequence(ROSTER);
L.employeesInSequence(ROSTER);
eq('the caller’s own list is untouched', JSON.stringify(ROSTER), snapshot);

console.log('\nthe order is the same however the list arrives\n');
const shuffled = ROSTER.slice().reverse();
eq('reversing the input does not change the output',
   names(L.employeesInSequence(shuffled)), names(L.employeesInSequence(ROSTER)));
// Two people with no number and no name still have to order deterministically.
const ambiguous = [{ id: 'z' }, { id: 'a' }, { id: 'm' }];
eq('unnamed, unnumbered records fall back to id order',
   L.employeesInSequence(ambiguous).map(e => e.id), ['a', 'm', 'z']);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
