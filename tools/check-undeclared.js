// Finds identifiers that are read but never declared anywhere in scope — the
// `monthVal is not defined` class of bug, which only shows itself when the
// line actually runs. Four reports and one image upload were broken this way
// before this existed; nothing else in the project would have caught them,
// because the file parses perfectly and the bad line only runs when a real
// person opens that screen.
//
//   npm install acorn      (once)
//   node tools/check-undeclared.js
//
// Heuristic, not a full linter: it reports identifier READS that resolve to no
// declaration in any enclosing scope. Guarded browser globals it does not know
// about show up as noise — check them by hand and add them to BUILTINS. It has
// no false negatives that matter for this bug class.
const fs = require('fs');
const path = require('path');
let acorn;
try {
  acorn = require('acorn');
} catch (e) {
  console.error('This needs acorn:  npm install acorn');
  process.exit(2);
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const blocks = [];
const re = /<script(?![^>]*src=)[^>]*>/g;
let m;
while ((m = re.exec(html))) {
  const s = m.index + m[0].length, e = html.indexOf('</script>', s);
  blocks.push({ code: html.slice(s, e), lineOffset: html.slice(0, s).split('\n').length - 1 });
}

const BUILTINS = new Set((
  'window document console Math JSON Date Array Object String Number Boolean RegExp Error TypeError ' +
  'Promise Set Map WeakMap WeakSet Symbol Infinity NaN undefined null true false parseInt parseFloat ' +
  'isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI setTimeout clearTimeout ' +
  'setInterval clearInterval requestAnimationFrame localStorage sessionStorage location navigator ' +
  'fetch alert confirm prompt FormData FileReader Blob URL Image XMLHttpRequest Event CustomEvent ' +
  'crypto btoa atob structuredClone Intl arguments this globalThis L html2canvas jspdf ' +
  'HTMLElement Node NodeList Element CanvasRenderingContext2D AbortController TextEncoder Uint8Array ' +
  'ArrayBuffer DataView Reflect Proxy BigInt eval print history screen top parent self frames' ).split(/\s+/));

const problems = [];

function declaredIn(node, out) {           // names a pattern binds
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); break;
    case 'ObjectPattern': node.properties.forEach(p =>
      declaredIn(p.type === 'RestElement' ? p.argument : p.value, out)); break;
    case 'ArrayPattern': node.elements.forEach(el => declaredIn(el, out)); break;
    case 'AssignmentPattern': declaredIn(node.left, out); break;
    case 'RestElement': declaredIn(node.argument, out); break;
  }
}

// Hoisted declarations reachable from a function body (var + function decls),
// not descending into nested functions for `var`, but block scopes count.
function collectBodyDecls(node, out, topLevel) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => collectBodyDecls(n, out, topLevel)); return; }
  switch (node.type) {
    case 'VariableDeclaration':
      node.declarations.forEach(d => declaredIn(d.id, out)); break;
    case 'FunctionDeclaration': case 'ClassDeclaration':
      if (node.id) out.add(node.id.name); return;   // don't descend
    case 'FunctionExpression': case 'ArrowFunctionExpression':
      return;                                        // own scope
    case 'CatchClause': declaredIn(node.param, out); break;
  }
  for (const k in node) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    collectBodyDecls(node[k], out, topLevel);
  }
}

function walkScope(node, scopes, fnName, block) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walkScope(n, scopes, fnName, block)); return; }

  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression') {
    const own = new Set();
    if (node.id) own.add(node.id.name);
    node.params.forEach(p => declaredIn(p, own));
    collectBodyDecls(node.body, own);
    const name = (node.id && node.id.name) || fnName;
    walkScope(node.body, scopes.concat([own]), name, block);
    return;
  }

  if (node.type === 'Identifier') return;   // handled by parents below

  // Identifier *reads*
  const readKeys = {
    CallExpression: ['callee', 'arguments'], NewExpression: ['callee', 'arguments'],
    BinaryExpression: ['left', 'right'], LogicalExpression: ['left', 'right'],
    UnaryExpression: ['argument'], UpdateExpression: ['argument'],
    ConditionalExpression: ['test', 'consequent', 'alternate'],
    TemplateLiteral: ['expressions'], ReturnStatement: ['argument'],
    SpreadElement: ['argument'], AwaitExpression: ['argument'],
    ArrayExpression: ['elements'], SequenceExpression: ['expressions'],
    IfStatement: ['test'], WhileStatement: ['test'], SwitchStatement: ['discriminant'],
    ThrowStatement: ['argument'], TaggedTemplateExpression: ['tag']
  };
  const check = id => {
    if (!id || id.type !== 'Identifier') return;
    if (BUILTINS.has(id.name)) return;
    if (scopes.some(s => s.has(id.name))) return;
    problems.push({ name: id.name, fn: fnName, pos: id.start });
  };
  const keys = readKeys[node.type];
  if (keys) keys.forEach(k => {
    const v = node[k];
    (Array.isArray(v) ? v : [v]).forEach(check);
  });
  if (node.type === 'MemberExpression') check(node.object);
  if (node.type === 'Property' && !node.computed) check(node.value);
  if (node.type === 'AssignmentExpression') check(node.right);
  if (node.type === 'VariableDeclarator') check(node.init);

  for (const k in node) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    walkScope(node[k], scopes, fnName, block);
  }
}

blocks.forEach(b => {
  const ast = acorn.parse(b.code, { ecmaVersion: 2022, locations: false });
  const globals = new Set();
  collectBodyDecls(ast, globals, true);
  walkScope(ast, [globals], '(top level)');
  problems.forEach(p => {
    if (p.reported) return;
    p.reported = true;
    p.line = b.lineOffset + b.code.slice(0, p.pos).split('\n').length;
  });
});

const seen = new Set();
const real = problems.filter(p => {
  const k = p.fn + ':' + p.name;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
real.forEach(p => console.log('index.html:' + p.line + '  ' + p.fn + '() reads undeclared `' + p.name + '`'));
console.log('\n' + real.length + ' undeclared identifier(s)');
