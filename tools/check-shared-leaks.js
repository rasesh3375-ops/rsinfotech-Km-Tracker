// check-shared-standalone.js only catches a missing helper if its fixture
// happens to run the line that calls it. evaluateAttendanceDay sat behind
// `if(e.checkinTime && e.checkoutTime)`, the fixture had no punch times, and so
// the 1 August report email was the thing that found it -- at 8 AM, with
// nobody watching, sending nothing.
//
// This finds them without running anything: parse shared/report-logic.js,
// collect everything it declares, then walk every identifier it READS and
// report the ones that resolve to nothing in the file. No fixture, so a branch
// that never executes in a test is caught exactly like one that does.
//
//   node tools/check-shared-leaks.js
//
// KNOWN is the browser-only code still sitting in the shared file by mistake --
// getAttendanceMany and its read cache (async, and it calls the backend),
// payrollFormContext (reads the open form through document), elFyRows (async),
// and toCsv's csvEscape. None of them is reachable from any report email today,
// which is the only reason they are tolerated rather than fixed. They belong in
// index.html; move them there and delete the name from this list. Do NOT add a
// new name to KNOWN to make this pass -- that is the bug it exists to stop.
const fs = require('fs');
const acorn = require('acorn');
const walk = require('acorn-walk');

const R = '/home/user/rsinfotech-Km-Tracker';
const src = fs.readFileSync(R + '/shared/report-logic.js', 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 2022 });

// Everything the JS language itself provides, plus what Apps Script's own
// runtime has. Anything outside this and outside the file is a leak.
const KNOWN = new Set(['LONG_READ_TTL_MS', 'applyAlwaysPresentFillToMany_', 'backendAction',
  'csvEscape', 'document', 'getAttendance']);

const BUILTINS = new Set(['undefined','NaN','Infinity','Object','Function','Boolean','Symbol',
  'Error','TypeError','RangeError','SyntaxError','ReferenceError','EvalError','URIError',
  'Number','BigInt','Math','Date','String','RegExp','Array','Map','Set','WeakMap','WeakSet',
  'JSON','Promise','Reflect','Proxy','Intl','parseInt','parseFloat','isNaN','isFinite',
  'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','console','globalThis',
  'ArrayBuffer','Uint8Array','Int8Array','Float64Array','DataView','arguments']);

// Top-level declarations in the file.
const declared = new Set();
ast.body.forEach(n => {
  if (n.type === 'FunctionDeclaration' && n.id) declared.add(n.id.name);
  if (n.type === 'VariableDeclaration') n.declarations.forEach(d => {
    if (d.id.type === 'Identifier') declared.add(d.id.name);
  });
  if (n.type === 'ClassDeclaration' && n.id) declared.add(n.id.name);
});

// Walk with scope tracking so locals and parameters are not reported.
const leaks = new Map();
function scopeNamesOf(node) {
  const names = new Set();
  const addPattern = p => {
    if (!p) return;
    if (p.type === 'Identifier') names.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach(pr =>
      addPattern(pr.type === 'RestElement' ? pr.argument : pr.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern);
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
  };
  (node.params || []).forEach(addPattern);
  if (node.id && node.id.type === 'Identifier') names.add(node.id.name);
  const body = node.body && node.body.type === 'BlockStatement' ? node.body : node;
  walk.recursive(body, null, {
    Function() {},                       // don't descend into nested functions
    VariableDeclaration(n2) { n2.declarations.forEach(d => addPattern(d.id)); },
    FunctionDeclaration(n2) { if (n2.id) names.add(n2.id.name); },
    ClassDeclaration(n2) { if (n2.id) names.add(n2.id.name); },
  }, Object.assign({}, walk.base, { Function(){}, }));
  return names;
}

walk.ancestor(ast, {
  Identifier(node, _state, ancestors) {
    const name = node.name;
    if (declared.has(name) || BUILTINS.has(name)) return;

    // Skip positions that are not a variable read.
    for (let i = ancestors.length - 2; i >= 0; i--) {
      const p = ancestors[i], c = ancestors[i + 1];
      if (p.type === 'MemberExpression' && p.property === c && !p.computed) return;
      if (p.type === 'Property' && p.key === c && !p.computed) return;
      if (p.type === 'MethodDefinition' && p.key === c && !p.computed) return;
      if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' ||
           p.type === 'ArrowFunctionExpression') && (p.params.includes(c) || p.id === c)) return;
      if (p.type === 'VariableDeclarator' && p.id === c) return;
      if (p.type === 'LabeledStatement' || p.type === 'BreakStatement' ||
          p.type === 'ContinueStatement') return;
      break;
    }

    // Is it bound by any enclosing function scope?
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression' ||
          a.type === 'ArrowFunctionExpression') {
        if (scopeNamesOf(a).has(name)) return;
      }
    }

    const line = src.slice(0, node.start).split('\n').length;
    if (!leaks.has(name)) leaks.set(name, []);
    leaks.get(name).push(line);
  }
});

const fresh = [...leaks.keys()].filter(n => !KNOWN.has(n));
const stale = [...KNOWN].filter(n => !leaks.has(n));
if (stale.length) {
  console.log('These are in KNOWN but no longer leak — delete them from the list:');
  stale.forEach(n => console.log('  ' + n));
}
if (!fresh.length) {
  console.log('No new leaks. ' + leaks.size + ' known browser-only name(s) still to move ' +
              'out of the shared file: ' + [...leaks.keys()].join(', ') + '.');
  process.exit(stale.length ? 1 : 0);
}
console.log('shared/report-logic.js reads ' + fresh.length + ' NEW name(s) it does not define.');
console.log('In the browser these resolve out of index.html; in Apps Script they throw —');
console.log('which means a report email that sends nothing at 8 AM on the 1st.\n');
const html = fs.readFileSync(R + '/index.html', 'utf8');
[...leaks.entries()].filter(([n]) => !KNOWN.has(n)).sort().forEach(([name, lines]) => {
  const where = new RegExp('function\\s+' + name + '\\s*\\(').exec(html);
  const at = where ? 'defined in index.html:' + html.slice(0, where.index).split('\n').length
                   : 'NOT FOUND in index.html either';
  console.log('  ' + name);
  console.log('      read at shared/report-logic.js:' + lines.join(', '));
  console.log('      ' + at);
});
process.exit(1);
