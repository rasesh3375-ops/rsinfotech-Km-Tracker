const SHEET_NAME = 'KV';
const ROOT_FOLDER_ID = '1tbsCiTna99xTd3MHDL98aYnICdWOTThx'; // R.S. Infotech HR Dashboard
// Pinned by ID on purpose. This script is container-bound to "KM Tracker Data",
// which is NOT where the data lives — getActiveSpreadsheet() resolved to that
// empty sheet and made every lookup (including hr_password) silently return
// nothing. Always address "RS Tracker Backend" explicitly.
const SPREADSHEET_ID = '18V6sH2Ml5diC1tNxuyYY6uf-v3qt1uTWOWyKbdWzPjw'; // RS Tracker Backend

// ===== UNCHANGED: your existing data helpers =====

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['key', 'value']);
  }
  return sheet;
}

function findRow_(sheet, key) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return i + 1;
  }
  return -1;
}

function getOrCreateFolderPath_(pathParts) {
  let folder = DriveApp.getFolderById(ROOT_FOLDER_ID);
  for (const name of pathParts) {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  }
  return folder;
}

function saveFile_(pathParts, fileName, content, mimeType) {
  const folder = getOrCreateFolderPath_(pathParts || []);
  const existing = folder.getFilesByName(fileName);
  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }
  folder.createFile(fileName, content, mimeType || MimeType.PLAIN_TEXT);
}

// ===== NEW: sessions (replaces "trust anyone with the URL") =====

const SESSION_SHEET_NAME = 'SESSIONS';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

function getSessionSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SESSION_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SESSION_SHEET_NAME);
    sheet.appendRow(['token', 'role', 'username', 'expiresAt']);
  }
  return sheet;
}

function createSession_(role, username, ttlMs) {
  const sheet = getSessionSheet_();
  const token = Utilities.getUuid() + '-' + Utilities.getUuid();
  const expiresAt = Date.now() + (ttlMs || SESSION_LIFETIME_MS);
  sheet.appendRow([token, role, username, expiresAt]);
  return { token: token, expiresAt: expiresAt };
}
const RECOVERY_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes to finish a password reset

function validateSession_(token) {
  if (!token) return null;
  const sheet = getSessionSheet_();
  const data = sheet.getDataRange().getValues();
  const now = Date.now();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      if (Number(data[i][3]) < now) return null; // expired
      return { role: data[i][1], username: data[i][2] };
    }
  }
  return null;
}

function deleteSession_(token) {
  const sheet = getSessionSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === token) sheet.deleteRow(i + 1);
  }
}

// ===== NEW: brute-force lockout on login =====

function checkLoginLockout_(username) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get('fail_' + username);
  if (!raw) return;
  const info = JSON.parse(raw);
  if (info.count >= MAX_LOGIN_ATTEMPTS && Date.now() < info.lockedUntil) {
    throw new Error('Too many failed attempts. Try again in a few minutes.');
  }
}
function recordLoginFailure_(username) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get('fail_' + username);
  const info = raw ? JSON.parse(raw) : { count: 0, lockedUntil: 0 };
  info.count += 1;
  info.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  cache.put('fail_' + username, JSON.stringify(info), 21600);
}
function clearLoginFailure_(username) {
  CacheService.getScriptCache().remove('fail_' + username);
}

function sha256Hex_(str) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

// ===== NEW: server-side login (this is what actually stops direct-URL access) =====

function doLogin_(body) {
  const username = body.username;
  const password = body.password;
  const role = body.role; // 'hr' or 'engineer'

  checkLoginLockout_(username);
  const sheet = getSheet_();

  if (role === 'hr') {
    const row = findRow_(sheet, 'hr_password');
    if (row === -1) return { error: 'HR account not set up yet' };
    const rec = JSON.parse(sheet.getRange(row, 2).getValue());
    const hash = sha256Hex_(rec.salt + ':' + password);
    if (rec.username !== username || hash !== rec.hash) {
      recordLoginFailure_(username);
      return { error: 'Invalid credentials' };
    }
    clearLoginFailure_(username);
    const session = createSession_('hr', username);
    return { ok: true, token: session.token, role: 'hr' };
  } else {
    const row = findRow_(sheet, 'users');
    const users = row === -1 ? [] : JSON.parse(sheet.getRange(row, 2).getValue() || '[]');
    const user = users.filter(function (u) { return u.username === username && u.enabled !== false; })[0];
    if (!user) { recordLoginFailure_(username); return { error: 'Invalid credentials' }; }
    const hash = sha256Hex_(user.salt + ':' + password);
    if (hash !== user.hash) { recordLoginFailure_(username); return { error: 'Invalid credentials' }; }
    clearLoginFailure_(username);
    const session = createSession_('engineer', username);
    return { ok: true, token: session.token, role: 'engineer', displayName: user.displayName };
  }
}

// One-time bootstrap: only works if hr_password doesn't exist yet.
// After the first HR account is created, this always refuses.
function doSetupHr_(body) {
  const sheet = getSheet_();
  if (findRow_(sheet, 'hr_password') !== -1) {
    return { error: 'HR account already exists' };
  }
  sheet.appendRow(['hr_password', JSON.stringify(body.value)]);
  return { ok: true };
}

// Forgot-password step 1 of 3: reveal the question only. No auth needed —
// this is public info by nature (you have to know the answer to go further).
function doRecoverHr_(body) {
  const sheet = getSheet_();
  const row = findRow_(sheet, 'hr_password');
  if (row === -1) return { error: 'No HR account exists' };
  const rec = JSON.parse(sheet.getRange(row, 2).getValue());
  return { ok: true, question: rec.question };
}

// Forgot-password step 2 of 3: verify the answer server-side (the hash never
// leaves the server). On success, issue a short-lived recovery token — this
// keeps the existing two-screen UI (answer, then new password) working.
function doVerifyHrRecoveryAnswer_(body) {
  checkLoginLockout_('hr-recovery');
  const sheet = getSheet_();
  const row = findRow_(sheet, 'hr_password');
  if (row === -1) return { error: 'No HR account exists' };
  const rec = JSON.parse(sheet.getRange(row, 2).getValue());
  const answerHash = sha256Hex_(rec.recoverySalt + ':' + String(body.answer || '').trim().toLowerCase());
  if (answerHash !== rec.recoveryHash) {
    recordLoginFailure_('hr-recovery');
    return { error: "That answer doesn't match" };
  }
  clearLoginFailure_('hr-recovery');
  const session = createSession_('hr-recovery', rec.username, RECOVERY_TOKEN_TTL_MS);
  return { ok: true, recoveryToken: session.token };
}

// Forgot-password step 3 of 3: spend the recovery token to set a new password.
function doResetHrPasswordWithToken_(body) {
  const auth = validateSession_(body.recoveryToken);
  if (!auth || auth.role !== 'hr-recovery') return { error: 'Recovery session expired. Start over.' };
  const sheet = getSheet_();
  const row = findRow_(sheet, 'hr_password');
  if (row === -1) return { error: 'No HR account exists' };
  const rec = JSON.parse(sheet.getRange(row, 2).getValue());
  const newRec = {
    username: rec.username,
    salt: body.newSalt,
    hash: body.newHash,
    question: rec.question,
    recoverySalt: rec.recoverySalt,
    recoveryHash: rec.recoveryHash
  };
  sheet.getRange(row, 2).setValue(JSON.stringify(newRec));
  deleteSession_(body.recoveryToken);
  return { ok: true };
}

// Uploads a real file (PDF/photo/scan) to Drive — mirrors saveFile_ but for
// binary content sent as base64. This action was already being called by
// index.html but had no matching handler here, so uploads were silently failing.
function doUploadDocument_(body) {
  const folder = getOrCreateFolderPath_(body.folderPath || []);
  const existing = folder.getFilesByName(body.fileName);
  while (existing.hasNext()) { existing.next().setTrashed(true); }
  const bytes = Utilities.base64Decode(body.base64Data);
  const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', body.fileName);
  const file = folder.createFile(blob);
  return { ok: true, fileUrl: file.getUrl() };
}

// ===== one-off: file everything dated under its financial year =====
// Reports, generated letters and uploaded office documents used to be written
// straight under HR Management > Dashboard / Reports / Generator / Office
// Documents. They now go to HR Management > <financial year> > the same place.
// This walks the old locations and moves each file into the year it belongs
// to, so history sits alongside everything written from now on.
//
// Employee Documents is left where it is on purpose: a person's Aadhaar and
// photo belong to the person, not to a year, and the Left Employees archive
// moves an employee's whole folder in one step.
//
// Run it from the Apps Script editor: select organiseDriveByYear and press
// Run. Safe to run as often as you like — a file already in a year folder is
// never looked at, and one that would collide with a file of the same name
// already at the destination is left alone and reported. Nothing is deleted.
var YEAR_FILED_SECTIONS = ['Dashboard', 'Reports', 'Generator', 'Office Documents'];

// April to March, so January belongs to the year that opened the previous April.
function fyLabelFor_(year, mon) {
  var fyStart = mon >= 4 ? year : year - 1;
  return fyStart + '-' + ('0' + ((fyStart + 1) % 100)).slice(-2);
}

// The year a file belongs to. The filename is trusted first because it names
// the month the content is ABOUT — a March challan uploaded in April has to
// land in the year that is closing, not the one that just opened. Only when
// there is no date in the name does the file's own timestamp decide, which is
// still better than leaving it loose at the top where nobody looks.
function fyLabelForFile_(file) {
  var m = /(\d{4})-(\d{2})(?:-\d{2})?/.exec(file.getName());
  if (m) {
    var mon = parseInt(m[2], 10);
    if (mon >= 1 && mon <= 12) return { label: fyLabelFor_(parseInt(m[1], 10), mon), from: 'name' };
  }
  var d = file.getLastUpdated();
  return { label: fyLabelFor_(d.getFullYear(), d.getMonth() + 1), from: 'date' };
}

function organiseDriveByYear() {
  var root = getOrCreateFolderPath_(['HR Management']);
  var stats = { moved: 0, collided: 0, byDate: 0 };
  var log = [];

  YEAR_FILED_SECTIONS.forEach(function (section) {
    var it = root.getFoldersByName(section);
    while (it.hasNext()) {
      moveFolderIntoYears_(it.next(), [section], stats, log);
    }
  });

  // The Employee Handbook once went to a top-level "Office Documents" folder
  // rather than under HR Management, so it is swept in from there too.
  var stray = DriveApp.getFolderById(ROOT_FOLDER_ID).getFoldersByName('Office Documents');
  while (stray.hasNext()) {
    moveFolderIntoYears_(stray.next(), ['Office Documents'], stats, log);
  }

  var msg = 'Moved ' + stats.moved + ' file(s) (' + stats.byDate +
            ' placed by their upload date because the name carried no month). ' +
            stats.collided + ' left alone — a file of that name is already at the destination.';
  Logger.log(msg);
  log.forEach(function (l) { Logger.log(l); });
  return msg;
}

// Walks one section folder and everything under it, moving files into
// HR Management/<year>/<the same relative path>. Recurses, so a two-deep
// path like Office Documents > Payroll Documents > PF Challan is kept intact.
function moveFolderIntoYears_(folder, relPath, stats, log) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var fy = fyLabelForFile_(file);
    var target = getOrCreateFolderPath_(['HR Management', fy.label].concat(relPath));
    if (target.getId() === folder.getId()) continue;          // already in place
    if (target.getFilesByName(file.getName()).hasNext()) {
      stats.collided++;
      log.push('left: ' + file.getName() + ' — already in ' + fy.label + '/' + relPath.join('/'));
      continue;
    }
    file.moveTo(target);
    stats.moved++;
    if (fy.from === 'date') stats.byDate++;
    log.push('moved: ' + file.getName() + ' -> HR Management/' + fy.label + '/' + relPath.join('/'));
  }

  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    // Never walk into a year folder — that is where things are being put.
    if (/^\d{4}-\d{2}$/.test(sub.getName())) continue;
    moveFolderIntoYears_(sub, relPath.concat([sub.getName()]), stats, log);
  }
}

// Kept so an older bookmark of the function name still runs the organiser.
function organiseReportsByYear() {
  return organiseDriveByYear();
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== doGet / doPost: same actions as before, now gated by a session token =====

function doGet(e) {
  const action = e.parameter.action;
  const key = e.parameter.key;
  const token = e.parameter.token;

  // Deliberately public: only reveals whether setup has happened yet, so the
  // frontend knows whether to show "Set up HR account" or "Log in". No PII.
  if (action === 'hrAccountExists') {
    const sheet = getSheet_();
    return jsonOut_({ exists: findRow_(sheet, 'hr_password') !== -1 });
  }

  if (action === 'get') {
    const auth = validateSession_(token);
    if (!auth) return jsonOut_({ error: 'unauthorized' });
    const sheet = getSheet_();
    const row = findRow_(sheet, key);
    const value = row === -1 ? null : sheet.getRange(row, 2).getValue();
    return jsonOut_({ value: value });
  }

  return jsonOut_({ error: 'unknown action' });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  // Actions allowed WITHOUT an existing session (login itself, one-time
  // bootstrap, and password recovery — each is independently guarded above).
  if (body.action === 'login') {
    try { return jsonOut_(doLogin_(body)); }
    catch (err) { return jsonOut_({ error: err.message }); }
  }
  if (body.action === 'setupHr') return jsonOut_(doSetupHr_(body));
  if (body.action === 'recoverHr') return jsonOut_(doRecoverHr_(body));
  if (body.action === 'verifyHrRecoveryAnswer') return jsonOut_(doVerifyHrRecoveryAnswer_(body));
  if (body.action === 'resetHrPasswordWithToken') return jsonOut_(doResetHrPasswordWithToken_(body));
  if (body.action === 'logout') {
    deleteSession_(body.token);
    return jsonOut_({ ok: true });
  }

  // Everything else requires a valid, unexpired session token.
  const auth = validateSession_(body.token);
  if (!auth) return jsonOut_({ error: 'unauthorized' });

  if (body.action === 'moveEmployeeFolder') {
    // Files a leaver's document folder under Employee Documents > Left
    // Employees. The folder is moved, not copied and not deleted: documents may
    // still be wanted for a statutory return or a reference years later.
    var docsRoot = getOrCreateFolderPath_(['HR Management', 'Employee Documents']);
    var found = docsRoot.getFoldersByName(body.folderName);
    if (!found.hasNext()) return jsonOut_({ ok: true, moved: false, reason: 'no folder' });
    var leaverFolder = found.next();
    var archive = getOrCreateFolderPath_(['HR Management', 'Employee Documents', 'Left Employees']);
    archive.addFolder(leaverFolder);
    docsRoot.removeFolder(leaverFolder);
    return jsonOut_({ ok: true, moved: true });
  }

  if (body.action === 'getBatch') {
    // Many keys, one request. The client used to fetch attendance one employee
    // at a time, so a twenty-person report meant twenty round trips; the sheet
    // is read once here and every requested key answered from it.
    var sheetB = getSheet_();
    var rows = sheetB.getDataRange().getValues();
    var map = {};
    for (var i = 0; i < rows.length; i++) map[rows[i][0]] = rows[i][1];
    var keys = body.keys || [];
    var values = {};
    for (var j = 0; j < keys.length; j++) {
      values[keys[j]] = map[keys[j]] !== undefined ? map[keys[j]] : null;
    }
    return jsonOut_({ ok: true, batch: true, values: values });
  }

  if (body.action === 'uploadDocument') {
    return jsonOut_(doUploadDocument_(body));
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.action === 'set') {
      const sheet = getSheet_();
      const row = findRow_(sheet, body.key);
      if (row === -1) sheet.appendRow([body.key, body.value]);
      else sheet.getRange(row, 2).setValue(body.value);
    } else if (body.action === 'delete') {
      const sheet = getSheet_();
      const row = findRow_(sheet, body.key);
      if (row !== -1) sheet.deleteRow(row);
    } else if (body.action === 'setItem') {
      // Merge ONE record into a JSON array, server side, inside the script lock.
      // The client used to send the whole array: two people editing different
      // employees both read it, both wrote it back, and whoever saved second
      // erased the other's change. Merging here means each save touches only
      // its own record, and the read-modify-write cannot interleave.
      // Also far smaller on the wire than resending every employee.
      var sheetI = getSheet_();
      var rowI = findRow_(sheetI, body.key);
      var list = [];
      if (rowI !== -1) {
        try { list = JSON.parse(sheetI.getRange(rowI, 2).getValue() || '[]'); } catch (e) { list = []; }
      }
      if (!(list instanceof Array)) list = [];
      var idField = body.idField || 'id';
      var item = body.item;
      var found = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i][idField] === item[idField]) { found = i; break; }
      }
      if (found === -1) list.push(item); else list[found] = item;
      var outJson = JSON.stringify(list);
      if (rowI === -1) sheetI.appendRow([body.key, outJson]);
      else sheetI.getRange(rowI, 2).setValue(outJson);
      // `merged` tells the client this backend understands setItem. Without it
      // the client falls back to sending the whole array, so an app running
      // against an older deployment keeps working.
      return jsonOut_({ ok: true, merged: true, count: list.length });
    } else if (body.action === 'saveFile') {
      saveFile_(body.folderPath, body.fileName, body.content, body.mimeType);
    }
  } finally {
    lock.releaseLock();
  }

  return jsonOut_({ ok: true });
}

// ===== UNCHANGED: your one-time manual Drive-authorization run =====

function testDriveSave() {
  saveFile_(
    ['HR Management', 'Dashboard', 'Salary Sheet'],
    'TEST - authorization check.txt',
    'If you can see this file in Drive, Drive saving is now authorized and working correctly. You can delete this test file.',
    'text/plain'
  );
  Logger.log('Test file saved successfully — check HR Management > Dashboard > Salary Sheet in Drive.');
}

// Clears the brute-force lockout counters for every known account. Deliberately
// a plain function and NOT a doGet/doPost action: it can only be run by someone
// with editor access to this project, so it adds no public attack surface.
// Run this from the editor when someone is locked out and can't wait it out —
// note the failure count survives in cache for 6 hours, so after 5 bad attempts
// a single further wrong guess re-locks the account for another 5 minutes.
function clearLoginLockouts() {
  const sheet = getSheet_();
  const names = ['hr-recovery'];

  const hrRow = findRow_(sheet, 'hr_password');
  if (hrRow !== -1) {
    names.push(JSON.parse(sheet.getRange(hrRow, 2).getValue()).username);
  }

  const usersRow = findRow_(sheet, 'users');
  if (usersRow !== -1) {
    JSON.parse(sheet.getRange(usersRow, 2).getValue() || '[]').forEach(function (u) {
      names.push(u.username);
    });
  }

  CacheService.getScriptCache().removeAll(names.map(function (n) { return 'fail_' + n; }));
  Logger.log('Cleared login lockouts for: ' + names.join(', '));
}
