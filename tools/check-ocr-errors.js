// What HR reads when a challan cannot be converted.
//
// This screen only ever appears when something has already gone wrong, so the
// wording IS the feature: it is the whole difference between a one-minute fix
// and an evening lost. On 13 September 2026 it failed the other way. The
// script had never been granted permission to read a Google Doc — reading a
// challan was added after it was first authorised, and Apps Script never asks
// again on its own — and Google's refusal reached HR verbatim, mid-payroll:
//
//   Could not reach the server to convert this challan: Drive could not
//   convert that challan to text: You do not have permission to call
//   DocumentApp.openById. Required permissions:
//   https://www.googleapis.com/auth/documents. For more information, see
//   https://developers.google.com/apps-script/guides/support/troubleshooting
//   #authorization-is Type the figures in from the challan.
//
// Every box on the screen was empty and the reply was "How this work I do not
// understand" — which is the correct reaction to that. Nothing in it says what
// to click, and nothing says the figures can still be typed in and compared
// exactly as normal.
//
// ocrChallanErrorFor_ is pure and split out of doOcrChallan_ for this file to
// reach without stubbing Drive, Docs or a Spreadsheet. The strings below are
// the real ones Apps Script produces, not paraphrases.
//
//   node tools/check-ocr-errors.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code 2.js'), 'utf8');

// Just the one function, lifted out by name — the rest of the backend reaches
// for Apps Script globals at load time and has no business running here.
const m = /\nfunction ocrChallanErrorFor_\(msg\) \{[\s\S]*?\n\}\n/.exec(src);
if (!m) {
  console.log('  FAIL  ocrChallanErrorFor_ not found in apps-script/Code 2.js.');
  console.log('        Inlined back into doOcrChallan_? It has to stay separate to be checked.');
  process.exit(1);
}
const sandbox = { String, RegExp };
vm.createContext(sandbox);
const fn = vm.runInContext(m[0] + ';ocrChallanErrorFor_', sandbox);

let failed = 0;
const check = (label, input, wantKey, mustSay) => {
  const out = fn(input);
  const problems = [];
  if (out.ok !== false) problems.push('ok should be false, got ' + JSON.stringify(out.ok));
  if (out.error !== wantKey) problems.push('error should be "' + wantKey + '", got "' + out.error + '"');
  mustSay.forEach(phrase => {
    if (String(out.message || '').toLowerCase().indexOf(phrase.toLowerCase()) === -1) {
      problems.push('message never says "' + phrase + '"');
    }
  });
  if (problems.length) {
    failed++;
    console.log('  FAIL  ' + label);
    problems.forEach(p => console.log('         ' + p));
    console.log('         message was: ' + JSON.stringify(out.message));
  } else {
    console.log('  ok    ' + label);
  }
};

// ---- the one that actually happened, verbatim -----------------------------
const REAL = 'You do not have permission to call DocumentApp.openById. Required permissions: ' +
  'https://www.googleapis.com/auth/documents. For more information, see ' +
  'https://developers.google.com/apps-script/guides/support/troubleshooting#authorization-is';
check('the exact error HR saw is recognised as a permission problem', REAL, 'needs-authorisation',
      // It has to name the menu path, say it is a one-off, and say the figures
      // can still be typed in — the three things the raw Google text lacked.
      ['Extensions > Apps Script', 'Run', 'Allow', 'one-off', 'typed in']);
check('and it warns against creating a NEW deployment', REAL, 'needs-authorisation',
      ['never a new deployment']);

// Other shapes of the same refusal. Matched on the scope and on Apps Script's
// own phrasings rather than on DocumentApp by name, because a newly added
// service would refuse the same way and want the same answer.
check('a bare "Authorization is required" reads the same way',
      'Exception: Authorization is required to perform that action.',
      'needs-authorisation', ['Extensions > Apps Script', 'typed in']);
check('a scope URL on its own is enough',
      'Required permissions: https://www.googleapis.com/auth/documents',
      'needs-authorisation', ['Extensions > Apps Script']);
check('and so is a refusal naming a different service',
      'You do not have permission to call GmailApp.sendEmail',
      'needs-authorisation', ['Extensions > Apps Script']);

// ---- the Drive advanced service, which was already handled ----------------
check('the Drive service being switched off still says so',
      'ReferenceError: Drive is not defined',
      'no-drive-service', ['Services (+) > Drive API > Add', 'typed in by hand']);
check('and so does a Drive.Files failure',
      'TypeError: Cannot read properties of undefined (reading \'copy\') at Drive.Files',
      'no-drive-service', ['Services (+) > Drive API > Add']);

// ---- anything else is passed through rather than guessed at ---------------
// A message this file does not recognise must still reach somebody in full.
// Swallowing it into a friendly generic would leave a real fault with nothing
// to diagnose it from.
check('an unrecognised failure is reported as itself',
      'Service invoked too many times for one day: docs',
      'convert-failed', ['Service invoked too many times']);
check('an empty error still produces an answer', '', 'convert-failed', ['could not convert']);

// None of the three may ever claim the challan was read.
['', REAL, 'Drive is not defined', 'anything at all'].forEach(msg => {
  const out = fn(msg);
  if (out.ok !== false || out.text) {
    failed++;
    console.log('  FAIL  a failure reported ok/text for input ' + JSON.stringify(msg));
  }
});
if (!failed) console.log('  ok    no failure path ever reports the challan as read');

if (failed) {
  console.log('\n' + failed + ' challan-conversion message(s) would leave HR stuck. See the top of this file.');
  process.exit(1);
}
console.log('\nPASS');
