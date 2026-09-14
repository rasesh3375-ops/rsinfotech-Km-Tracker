// Every Google service the backend calls must have its permission declared.
//
// This exists because of a fault that reached HR mid-payroll and could not be
// fixed from here. Pressing Check on a PF challan returned:
//
//   You do not have permission to call DocumentApp.openById. Required
//   permissions: https://www.googleapis.com/auth/documents
//
// Reading a challan was added after the script was first authorised. Apps
// Script infers the permissions a project needs from its code, but a
// deployment keeps running on the set it was granted and never asks again on
// its own — so the one call that needed more was refused, on a live payroll
// backend, with every figure box on the screen left empty.
//
// appsscript.json now declares the scopes explicitly, which makes the
// requirement a fact in the repository rather than something Google works out
// each time. That has a sharp edge, and it is the reason this file exists:
//
//   *** Declaring oauthScopes TURNS OFF auto-inference. ***
//
// The declared list becomes the whole truth. Add MailApp, CalendarApp or any
// other service to Code 2.js without adding its scope here and it will not be
// inferred for you — it will be refused at run time, in production, in
// exactly the way DocumentApp was. There is nothing in Apps Script that warns
// about this, and the failure surfaces only when somebody presses the button.
//
// So: this reads the services actually called in Code 2.js and asserts each
// one's scope is declared. Adding a service without its permission fails here,
// on the machine, instead of at 8 AM on the 1st.
//
//   node tools/check-oauth-scopes.js
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(R, 'apps-script', 'Code 2.js'), 'utf8');
const manifestRaw = fs.readFileSync(path.join(R, 'apps-script', 'appsscript.json'), 'utf8');

let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (e) {
  console.log('  FAIL  appsscript.json is not valid JSON — Apps Script will refuse the project.');
  console.log('        ' + e.message);
  process.exit(1);
}

// What each service needs. Services with no entry need no scope at all —
// they run inside the script and touch nothing of the user's.
const NEEDS = {
  SpreadsheetApp: 'https://www.googleapis.com/auth/spreadsheets',
  DriveApp:       'https://www.googleapis.com/auth/drive',
  DocumentApp:    'https://www.googleapis.com/auth/documents',
  UrlFetchApp:    'https://www.googleapis.com/auth/script.external_request',
  MailApp:        'https://www.googleapis.com/auth/script.send_mail',
  GmailApp:       'https://www.googleapis.com/auth/gmail.send',
  ScriptApp:      'https://www.googleapis.com/auth/script.scriptapp',
  CalendarApp:    'https://www.googleapis.com/auth/calendar',
  ContactsApp:    'https://www.googleapis.com/auth/contacts',
  SlidesApp:      'https://www.googleapis.com/auth/presentations',
  FormApp:        'https://www.googleapis.com/auth/forms',
};
// Need no permission: they never leave the script.
const FREE = ['CacheService', 'LockService', 'ContentService', 'PropertiesService',
              'HtmlService', 'Utilities', 'Logger', 'XmlService', 'UrlShortener'];

const declared = Array.isArray(manifest.oauthScopes) ? manifest.oauthScopes : null;
let failed = 0;

if (!declared) {
  console.log('  FAIL  appsscript.json declares no oauthScopes.');
  console.log('        Without them Apps Script infers permissions, which is what let a');
  console.log('        deployment run for months unable to call DocumentApp. Declare them.');
  process.exit(1);
}

// Which services the code actually calls — matched on "Service." so a mention
// inside a comment or a string does not count as a use.
const used = new Set();
Object.keys(NEEDS).concat(FREE).forEach(svc => {
  if (new RegExp('\\b' + svc + '\\s*\\.').test(code)) used.add(svc);
});
// The Drive ADVANCED service (Drive.Files) rides on the same scope as DriveApp,
// but can be enabled without DriveApp ever being named.
if (/\bDrive\s*\.\s*Files\b/.test(code)) used.add('DriveApp');

Object.keys(NEEDS).forEach(svc => {
  if (!used.has(svc)) return;
  const need = NEEDS[svc];
  if (declared.indexOf(need) === -1) {
    console.log('  FAIL  ' + svc + ' is called in Code 2.js but ' + need);
    console.log('        is not in appsscript.json. Declaring oauthScopes turns OFF');
    console.log('        auto-inference, so this call WILL be refused in production.');
    failed++;
  } else {
    console.log('  ok    ' + svc.padEnd(15) + need);
  }
});

FREE.filter(s => used.has(s)).forEach(s => {
  console.log('  ok    ' + s.padEnd(15) + '(needs no permission)');
});

// An advanced service declared in the manifest has to be switched on in the
// editor too; if Drive.Files is called it must at least be declared here.
if (/\bDrive\s*\.\s*Files\b/.test(code)) {
  const adv = ((manifest.dependencies || {}).enabledAdvancedServices || [])
    .some(s => s.serviceId === 'drive');
  if (!adv) {
    console.log('  FAIL  Drive.Files is called but the Drive advanced service is not');
    console.log('        declared in appsscript.json dependencies.');
    failed++;
  } else {
    console.log('  ok    Drive.Files     advanced service declared');
  }
}

// Not a failure, but worth saying out loud on a payroll backend: a scope
// nothing uses is access granted for no reason.
const unused = declared.filter(sc =>
  !Object.keys(NEEDS).some(svc => used.has(svc) && NEEDS[svc] === sc));
if (unused.length) {
  console.log('\n  note  declared but nothing uses it — remove unless something needs it:');
  unused.forEach(sc => console.log('        ' + sc));
}

if (failed) {
  console.log('\n' + failed + ' service(s) would be refused in production. See the top of this file.');
  process.exit(1);
}
console.log('\nPASS');
