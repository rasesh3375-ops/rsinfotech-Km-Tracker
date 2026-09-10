// The app must never switch off the user's ability to zoom.
//
// This cost five rounds to find. index.html carried a repaint workaround
// (kmtNudgeRepaint_) that wrote `maximum-scale=1` onto the viewport meta and
// took it off a frame later, as a lever for forcing iOS to reprocess viewport
// metrics after a fixed overlay had been left painted stale. It was called
// five times over 200ms by kmtRetryNudgeRepaint_, from a touchend that fires
// at the end of every pinch.
//
// maximum-scale=1 does not nudge WebKit. It tells iOS the page may not be
// zoomed. So once the pinch belonged to the browser, the app was switching the
// zoom off a fraction of a second after each successful pinch — reported as
// "some time zoom working and many times not working... then one time it works
// then zoom not working at all", which is exactly what an intermittent race
// between a person's fingers and a 200ms timer looks like.
//
// It is checked statically, and in the whole file rather than in that one
// function, because the next person to meet an iOS repaint bug will find the
// same lever documented all over the web and reach for it again. There is no
// repaint worth taking somebody's zoom away for, and on a payroll app that HR
// reads figures off a phone with, it is worse than the bug it was fixing.
//
//   node tools/check-no-zoom-lock.js
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

const FILES = ['index.html'];
// Both halves of "you may not zoom this page", in the forms they are written
// in a meta tag or assigned from script.
const BANNED = [
  [/maximum-scale/i,          'maximum-scale (caps how far the page may be zoomed)'],
  [/minimum-scale/i,          'minimum-scale (caps how far it may be zoomed out)'],
  [/user-scalable\s*=\s*(no|0)/i, 'user-scalable=no (forbids zooming outright)'],
];

let failed = 0;
FILES.forEach(file => {
  const src = fs.readFileSync(path.join(R, file), 'utf8');
  src.split('\n').forEach((line, i) => {
    // A line that only talks about it is fine — this file's own comments
    // explain at length why it must not be used, and so do index.html's.
    const code = line.replace(/^\s*(\/\/|\*|<!--).*$/, '');
    BANNED.forEach(([re, what]) => {
      if (re.test(code)) {
        console.log('  FAIL  ' + file + ':' + (i + 1) + '  ' + what);
        console.log('        ' + line.trim().slice(0, 120));
        failed++;
      }
    });
  });
});

if (failed) {
  console.log('\n' + failed + ' place(s) take the user\'s zoom away. None is worth it — see the top of this file.');
  process.exit(1);
}
console.log('  ok    nothing in the app limits or forbids zooming.');
