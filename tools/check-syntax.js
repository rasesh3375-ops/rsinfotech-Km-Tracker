// Parses every inline <script> in index.html. Catches an unbalanced brace or a
// stray character before it reaches the browser, where the whole app would
// simply not start.
//
//   node tools/check-syntax.js
//
// No dependencies. Run it after every edit to index.html.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const re = /<script(?![^>]*src=)[^>]*>/g;
let m, blocks = 0, bad = 0;
while ((m = re.exec(html))) {
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  const line = html.slice(0, start).split('\n').length;
  blocks++;
  try {
    new Function(html.slice(start, end));
  } catch (err) {
    bad++;
    console.error('index.html:' + line + '  ' + err.message);
  }
}
console.log(blocks + ' inline script block(s), ' + bad + ' with syntax errors');
process.exit(bad ? 1 : 0);
