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

// Guards employee:<id> rows against an out-of-order overwrite. Aborting a
// slow request client-side (see apiFetch in index.html) does not cancel it
// here — it keeps running. Pressing Save again after a "could not save"
// error, exactly what that message tells HR to do, starts a genuinely new
// request while the first may still be in flight; if a document finished
// uploading in between, the two carry different content, and nothing
// guarantees they reach this lock in the order they were sent. The older,
// less-complete one landing SECOND used to silently overwrite the newer,
// complete save. saveOneEmployee_ (index.html) stamps every employee record
// with savedAt right before sending it; this refuses to let a write with an
// older savedAt replace one that's already newer. Only applies to
// employee: keys — every other key in this sheet writes through exactly as
// before, since only that one form is known to retry itself this way.
// Malformed/non-JSON values (should not happen for an employee record) fail
// open, writing through as before rather than getting silently stuck.
function isStaleEmployeeWrite_(key, incomingValue, existingValue) {
  if (typeof key !== 'string' || key.indexOf('employee:') !== 0) return false;
  try {
    const existing = JSON.parse(existingValue);
    const incoming = JSON.parse(incomingValue);
    return !!(existing && incoming && Number(existing.savedAt) > Number(incoming.savedAt));
  } catch (e) {
    return false;
  }
}

// Same guard as isStaleEmployeeWrite_ above, for payroll_docs:<fy>:<month>
// keys. HR relinking several documents for one month in quick succession —
// exactly what recovering April's lost PF records needed — hits the
// identical out-of-order-write risk an employee save does: an earlier write
// that looked like it failed client-side ("Could not save — try again") can
// still be running here, and land AFTER a later write that already
// succeeded, silently erasing everything the later one added. That is
// exactly what happened to April: PF went from Complete back to Not
// Uploaded with no error shown, because the stale write that erased it
// still reported success. savePayrollDocsMonth_ (index.html) now stamps
// every month's write with savedAt inside {savedAt, records}, the same
// object shape employee: records already use; this refuses to let an older
// one replace one that's already newer. Fails open — writing through as
// before — for a bare pre-existing array (the shape every month key used
// before this guard existed) or malformed JSON, exactly like the employee
// guard's own fallback.
function isStalePayrollDocsWrite_(key, incomingValue, existingValue) {
  if (typeof key !== 'string' || key.indexOf('payroll_docs:') !== 0) return false;
  try {
    const existing = JSON.parse(existingValue);
    const incoming = JSON.parse(incomingValue);
    if (!existing || !incoming || existing.savedAt === undefined || incoming.savedAt === undefined) return false;
    return Number(existing.savedAt) > Number(incoming.savedAt);
  } catch (e) {
    return false;
  }
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

// For a document that must exist exactly once for its owner regardless of
// which financial year it was most recently (re)issued in — the Generator's
// one-time HR letters (Offer/Appointment/Experience/Relieving/Exit/No Dues/
// Full & Final Settlement). saveFile_ above only replaces a same-named file
// within the ONE folder it's given, and every folder here is a year folder
// (see hrYearPath) — so reissuing the same letter in a later financial year
// used to leave the old year's copy behind as an orphan instead of
// replacing it, the opposite of what re-saving the same letter should do.
// This walks every year folder directly under "HR Management" and removes
// any file at the same tail path (e.g. ['Generator', 'Appointment Letter'])
// with the same name, before saveFile_ writes the new one — so there is
// always exactly one copy, in whichever year folder the current issue date
// belongs to.
function deleteAcrossYearFolders_(pathTail, fileName) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const hrMgmtIt = root.getFoldersByName('HR Management');
  if (!hrMgmtIt.hasNext()) return;
  const yearFolders = hrMgmtIt.next().getFolders();
  while (yearFolders.hasNext()) {
    let folder = yearFolders.next();
    let ok = true;
    for (let i = 0; i < pathTail.length && ok; i++) {
      const it = folder.getFoldersByName(pathTail[i]);
      if (it.hasNext()) folder = it.next(); else ok = false;
    }
    if (!ok) continue;
    const files = folder.getFilesByName(fileName);
    while (files.hasNext()) files.next().setTrashed(true);
  }
}

// ===== NEW: sessions (replaces "trust anyone with the URL") =====

const SESSION_SHEET_NAME = 'SESSIONS';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// HR carries payroll, salary and every employee's personal data — a saved
// login on a shared or lost device staying open for a month was reported as
// a real concern. Engineers' tracking login (still SESSION_LIFETIME_MS) is
// deliberately left alone: re-entering a password daily just to check in
// from the field is exactly the friction the 30-day session exists to avoid.
const HR_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

function getSessionSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SESSION_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SESSION_SHEET_NAME);
    sheet.appendRow(['tokenHash', 'role', 'username', 'expiresAt']);
  }
  return sheet;
}

// The sheet stores only a hash of the token, never the token itself — the
// same reasoning as password storage. Anyone who can read the SESSIONS sheet
// (a Drive share, an HR account compromise) used to get a live bearer token
// good for 30 days; now they get a hash that's useless for calling the API.
// The plaintext token still goes to the client once, at login, same as before.
function createSession_(role, username, ttlMs) {
  const sheet = getSessionSheet_();
  const token = Utilities.getUuid() + '-' + Utilities.getUuid();
  const expiresAt = Date.now() + (ttlMs || SESSION_LIFETIME_MS);
  sheet.appendRow([sha256Hex_(token), role, username, expiresAt]);
  return { token: token, expiresAt: expiresAt };
}
const RECOVERY_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes to finish a password reset

function validateSession_(token) {
  if (!token) return null;
  const sheet = getSessionSheet_();
  const data = sheet.getDataRange().getValues();
  const now = Date.now();
  const tokenHash = sha256Hex_(token);
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === tokenHash) {
      if (Number(data[i][3]) < now) return null; // expired
      return { role: data[i][1], username: data[i][2] };
    }
  }
  return null;
}

function deleteSession_(token) {
  const sheet = getSessionSheet_();
  const data = sheet.getDataRange().getValues();
  const tokenHash = sha256Hex_(token);
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === tokenHash) sheet.deleteRow(i + 1);
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
    const session = createSession_('hr', username, HR_SESSION_LIFETIME_MS);
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

// Reads a document back out of Drive and hands its bytes to the app, so it
// can be shown inside the app itself instead of sending whoever's looking
// at it to a Drive link directly — which needs their own Google account
// with explicit sharing access to that one file. This script already has
// Drive access (it runs as whoever deployed it, regardless of who is
// calling the web app), so it reads the file on their behalf and returns
// it over the same session they are already using.
// Documents uploaded before uploadDocumentToDrive started compressing large
// photos (see index.html) can still be several megabytes each — base64
// adds another third on top of that, both in memory here and over the
// network to the client. A file past this is more likely to time out than
// actually arrive, and "check your connection" is the wrong thing to tell
// someone when the real problem is the file's own size. Checked via
// getSize() before ever reading the file's bytes, so an oversized file
// fails fast rather than after doing (and paying for) the expensive part
// anyway.
const DRIVE_FILE_VIEW_LIMIT_BYTES = 8 * 1024 * 1024; // 8MB
function doGetDriveFile_(body) {
  try {
    const file = DriveApp.getFileById(body.fileId);
    if (file.getSize() > DRIVE_FILE_VIEW_LIMIT_BYTES) {
      return { ok: false, error: 'This file is ' + (file.getSize() / (1024 * 1024)).toFixed(1) +
        ' MB — too large to open reliably here. Download it directly from Drive instead, or replace it with a smaller scan.' };
    }
    const blob = file.getBlob();
    return {
      ok: true,
      fileName: file.getName(),
      mimeType: blob.getContentType(),
      base64Data: Utilities.base64Encode(blob.getBytes())
    };
  } catch (err) {
    return { ok: false, error: 'Could not read that file from Drive.' };
  }
}

// The one Drive-backed document engineers may read the actual content of,
// not just its stored link (see ENGINEER_SHARED_READ's 'employee_handbook'
// entry) — every other document belongs to one specific employee and is
// HR's alone. Deliberately takes no fileId from the caller at all: it
// looks up whatever the CURRENT handbook actually is from the sheet
// itself, so this action can never be pointed at anything other than the
// one handbook on file, however it's called.
function doGetEmployeeHandbookFile_() {
  const sheet = getSheet_();
  const row = findRow_(sheet, 'employee_handbook');
  if (row === -1) return { ok: false, error: 'No handbook on file.' };
  let rec;
  try { rec = JSON.parse(sheet.getRange(row, 2).getValue() || '{}'); }
  catch (e) { return { ok: false, error: 'No handbook on file.' }; }
  const m = /\/d\/([^/]+)/.exec(rec.fileUrl || '');
  if (!m) return { ok: false, error: 'No handbook on file.' };
  try {
    const file = DriveApp.getFileById(m[1]);
    const blob = file.getBlob();
    return {
      ok: true,
      fileName: file.getName(),
      mimeType: blob.getContentType(),
      base64Data: Utilities.base64Encode(blob.getBytes())
    };
  } catch (err) {
    return { ok: false, error: 'Could not read the handbook from Drive.' };
  }
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

// ===== who may touch what =====
// validateSession_ has always returned {role, username}. Nothing ever read the
// role, so every request only proved you were logged in as SOMEBODY. A field
// engineer's tracking login could therefore read the whole payroll — and write
// the hr_password key, replacing HR's password with one of their own choosing.
//
// The rule below is deliberately a whitelist. A key nobody has thought about is
// refused to engineers rather than allowed, so adding a new payroll key cannot
// quietly open it up.

// Shared reference data. Policy and configuration, nothing about anybody's pay.
var ENGINEER_SHARED_READ = ['holidays', 'geofences', 'rate_per_km',
  'company_profile', 'employee_handbook', 'resident_policy_text'];

// Keys belonging to one engineer, addressed by their own username.
function engineerScopedKeys_(username) {
  return ['trips:' + username, 'checkins:' + username, 'active:' + username];
}

// Every employee, one per `employee:<id>` key, instead of the whole company
// sharing one `employees` cell — same reason and same shape as attendance's
// own `attendance:<id>:<financial-year>` split (see migrateAttendanceToFY /
// mergedAttendanceForId_). The legacy `employees` key is left untouched
// forever as a frozen pre-migration snapshot; nothing reads it after
// migrateEmployeesToPerRecordKeys has been run once. Shared by every
// function below that used to read `map['employees']` directly, so there is
// one place that knows what an employee key looks like, not four.
//
// `rows` is the whole KV sheet's getDataRange().getValues(), read once by
// the caller — same convention doGetAttendanceAll_/doGetAttendanceRange_
// already use for `map`, avoiding a second whole-sheet read for what is
// already in memory.
function allEmployeesFromRows_(rows) {
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var key = rows[i][0];
    if (typeof key !== 'string' || key.indexOf('employee:') !== 0) continue;
    try {
      var emp = JSON.parse(rows[i][1]);
      if (emp) list.push(emp);
    } catch (e) { /* one bad row skipped, not fatal to the rest */ }
  }
  return list;
}

// An engineer's own employee id, so they can read their own attendance and
// nobody else's. Cached briefly: this is on the path of every request they
// make, and it is a whole-sheet read otherwise.
function employeeIdForTrackingUser_(username) {
  if (!username) return null;
  var cache = CacheService.getScriptCache();
  var hit = cache.get('empid_' + username);
  if (hit) return hit === '-' ? null : hit;
  var sheet = getSheet_();
  var rows = sheet.getDataRange().getValues();
  var list = allEmployeesFromRows_(rows);
  var id = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].trackingUsername === username) { id = list[i].id; break; }
  }
  cache.put('empid_' + username, id || '-', 300);
  return id;
}

function engineerMayRead_(key, username) {
  if (!key) return false;
  if (ENGINEER_SHARED_READ.indexOf(key) !== -1) return true;
  if (engineerScopedKeys_(username).indexOf(key) !== -1) return true;
  // Leave applications are one shared list, so an engineer reading their own
  // sees colleagues' too. Accepted: it is not pay data, and splitting the list
  // per person is a larger change than this one. Revisit if it matters.
  if (key === 'leave_requests') return true;
  var empId = employeeIdForTrackingUser_(username);
  if (empId && (key === 'attendance:' + empId || key.indexOf('attendance:' + empId + ':') === 0)) return true;
  return false;
}

function engineerMayWrite_(key, username) {
  if (!key) return false;
  if (engineerScopedKeys_(username).indexOf(key) !== -1) return true;
  // Check-in/checkout mark the engineer's own attendance day. Read access for
  // this same key pattern already exists just above in engineerMayRead_ —
  // write was missing entirely, so every check-in's attendance write came
  // back forbidden and was silently dropped by safeSet's error-swallowing.
  var empId = employeeIdForTrackingUser_(username);
  if (empId && (key === 'attendance:' + empId || key.indexOf('attendance:' + empId + ':') === 0)) return true;
  return false;
}

function forbidden_() {
  return jsonOut_({ error: 'forbidden' });
}

// What the engineer app needs to know about its own employee record, and
// nothing else. It used to fetch the entire employees list — every salary, PAN
// and bank detail in the company — to find these six fields.
function doGetMyProfile_(auth) {
  var sheet = getSheet_();
  // One whole-sheet read serves both lookups below, instead of the two
  // separate findRow_ calls (each its own getDataRange()) this used to make.
  var rows = sheet.getDataRange().getValues();
  var list = allEmployeesFromRows_(rows);
  var emp = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].trackingUsername === auth.username) {
      emp = {
        id: list[i].id,
        name: list[i].name || '',
        employeeType: list[i].employeeType || '',
        elOpening: list[i].elOpening,
        slOpening: list[i].slOpening,
        leaveOpeningFrom: list[i].leaveOpeningFrom || ''
      };
      break;
    }
  }
  // Whether the tracking login is still switched on. The app used to answer
  // this by reading the whole users list, which carries everyone's password
  // salt and hash.
  var enabled = true, displayName = '';
  for (var r = 1; r < rows.length; r++) {
    if (rows[r][0] === 'users') {
      try {
        var users = JSON.parse(rows[r][1] || '[]');
        for (var j = 0; j < users.length; j++) {
          if (users[j] && users[j].username === auth.username) {
            enabled = users[j].enabled !== false;
            displayName = users[j].displayName || '';
            break;
          }
        }
      } catch (e) {}
      break;
    }
  }
  return { ok: true, enabled: enabled, displayName: displayName, employee: emp };
}

// ===== one-off: split attendance into one key per financial year =====
// Attendance has always been one key per employee — attendance:<id> — holding
// every day they have ever worked. A Sheets cell dies at 50,000 characters,
// and now that check-in/check-out times are recorded too that is roughly a
// 1.9 year problem. This splits each employee's record into
// attendance:<id>:<financial-year> (e.g. attendance:7:2026-27, using the same
// fyLabelFor_ that already names the Drive year folders), one key per year.
//
// Purely additive. attendance:<id> is left exactly as it is — nothing in
// doGet/doPost reads the new keys yet, so running this changes nothing about
// how the live app behaves. It only writes the new keys so they can be
// checked in the sheet before anything is switched over to read them.
//
// Safe to run again: every run recomputes every year bucket from the legacy
// record, so a re-run after more attendance has been saved just brings the
// split up to date. Does not need the script lock — it never writes
// attendance:<id>, so it cannot collide with a concurrent attendance save.
//
// Named without a trailing underscore, unlike this file's other internal
// helpers, because the Apps Script editor hides underscore-suffixed
// functions from the "run" dropdown — this one needs to show up there.
//
// Run it from the Apps Script editor: select migrateAttendanceToFY and
// press Run.
function migrateAttendanceToFY() {
  var sheet = getSheet_();
  var rows = sheet.getDataRange().getValues();
  var toWrite = {}; // 'attendance:<id>:<fy>' -> JSON string, applied in one pass
  var stats = { employees: 0, yearKeys: 0, days: 0, skippedEntries: 0 };

  for (var i = 0; i < rows.length; i++) {
    var key = rows[i][0];
    if (typeof key !== 'string' || key.indexOf('attendance:') !== 0) continue;
    var rest = key.slice('attendance:'.length);
    // A new-format key ends in a financial-year label, e.g. ":2026-27" — skip
    // those, only the legacy whole-history key is a migration source. This is
    // a suffix check rather than "no colon" because HR types employee ids by
    // hand on the form and one could in principle contain a colon.
    if (/:\d{4}-\d{2}$/.test(rest)) continue;
    var empId = rest;

    var raw = rows[i][1];
    var all = {};
    if (raw) { try { all = JSON.parse(raw); } catch (e) { continue; } }

    var byYear = {};
    for (var d in all) {
      var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(d);
      if (!m) { stats.skippedEntries++; continue; } // not a date-shaped entry
      var label = fyLabelFor_(parseInt(m[1], 10), parseInt(m[2], 10));
      (byYear[label] || (byYear[label] = {}))[d] = all[d];
      stats.days++;
    }

    stats.employees++;
    for (var label2 in byYear) {
      toWrite['attendance:' + empId + ':' + label2] = JSON.stringify(byYear[label2]);
      stats.yearKeys++;
    }
  }

  var index = {};
  for (var r = 1; r < rows.length; r++) index[rows[r][0]] = r + 1;
  for (var k in toWrite) {
    if (index[k]) sheet.getRange(index[k], 2).setValue(toWrite[k]);
    else sheet.appendRow([k, toWrite[k]]);
  }

  var msg = 'Split attendance for ' + stats.employees + ' employee(s) into ' +
    stats.yearKeys + ' year key(s), ' + stats.days + ' day(s) total' +
    (stats.skippedEntries ? ', ' + stats.skippedEntries + ' non-date entry(ies) left out of the split' : '') +
    '. attendance:<id> left untouched.';
  Logger.log(msg);
  return msg;
}

// One `employee:<id>` key per person instead of the whole company sharing
// one `employees` cell — the same fix as migrateAttendanceToFY above, for
// the same reason: one Sheets cell tops out at 50,000 characters, and that
// ceiling was being hit by the company's total headcount, not any one
// person's own data. Reads the current `employees` array once and writes
// each entry to its own key; `employees` itself is never touched, exactly
// like attendance:<id> stays in place as a frozen baseline after its own
// split — nothing reads it again once the app is deployed reading
// employee:<id> keys, but it remains the pre-migration backup forever.
// Safe to re-run: it always recomputes every employee:<id> key from
// whatever is currently in the legacy `employees` array.
//
// Run it from the Apps Script editor: select migrateEmployeesToPerRecordKeys
// and press Run. Run this AFTER deploying the updated Code.js (so
// getAllEmployees exists) and BEFORE pushing the updated frontend (so
// nothing reads employee:<id> keys before they exist).
function migrateEmployeesToPerRecordKeys() {
  var sheet = getSheet_();
  var row = findRow_(sheet, 'employees');
  var list = [];
  if (row !== -1) {
    try { list = JSON.parse(sheet.getRange(row, 2).getValue() || '[]') || []; }
    catch (e) { list = []; }
  }
  if (!(list instanceof Array)) list = [];

  var toWrite = {};
  var skipped = 0;
  for (var i = 0; i < list.length; i++) {
    var emp = list[i];
    if (!emp || !emp.id) { skipped++; continue; }
    toWrite['employee:' + emp.id] = JSON.stringify(emp);
  }

  var rows = sheet.getDataRange().getValues();
  var index = {};
  for (var r = 1; r < rows.length; r++) index[rows[r][0]] = r + 1;
  for (var k in toWrite) {
    if (index[k]) sheet.getRange(index[k], 2).setValue(toWrite[k]);
    else sheet.appendRow([k, toWrite[k]]);
  }

  var msg = 'Split ' + Object.keys(toWrite).length + ' employee(s) into their own employee:<id> key(s)' +
    (skipped ? ', ' + skipped + ' record(s) with no id left out of the split' : '') +
    '. employees left untouched as the pre-migration backup.';
  Logger.log(msg);
  return msg;
}

// ===== attendance for a date range =====
// Attendance is one value per employee, now split into one key per financial
// year — attendance:<id>:<year> — by migrateAttendanceToFY, with the legacy
// whole-history attendance:<id> key left in place as a baseline.

// Financial year label for a plain YYYY-MM-DD string, without going through
// Date() — a date-only string parsed with new Date() is UTC midnight, which
// in a timezone behind UTC can push 1 April into the previous day. Reuses
// fyLabelFor_, the same function that names the Drive year folders.
function fyLabelForDateStr_(dateStr) {
  var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateStr || ''));
  if (!m) return null;
  return fyLabelFor_(parseInt(m[1], 10), parseInt(m[2], 10));
}

// One employee's attendance, merged from their year keys and the legacy
// attendance:<id> key. Legacy is the baseline — migrateAttendanceToFY never
// deletes it, and nothing writes to it anymore once this is live — and any
// year key present overrides it, so a newer edit always wins over the frozen
// legacy snapshot for the same day.
//
// `map` is the whole KV sheet as key -> raw value, read once by the caller.
// `labels`: which year keys to look at. Omit (or pass null) to merge every
// year key this employee has, for a whole-history read.
function mergedAttendanceForId_(map, id, labels) {
  var merged = {};
  var legacyRaw = map['attendance:' + id];
  if (legacyRaw) {
    try { var legacy = JSON.parse(legacyRaw); for (var d0 in legacy) merged[d0] = legacy[d0]; }
    catch (e) {}
  }
  var prefix = 'attendance:' + id + ':';
  var wanted = labels;
  if (!wanted) {
    wanted = [];
    for (var k in map) {
      if (k.indexOf(prefix) === 0) wanted.push(k.slice(prefix.length));
    }
  }
  for (var i = 0; i < wanted.length; i++) {
    if (!wanted[i]) continue;
    var raw = map[prefix + wanted[i]];
    if (!raw) continue;
    try { var obj = JSON.parse(raw); for (var d in obj) merged[d] = obj[d]; }
    catch (e) {}
  }
  return merged;
}

// Drawing one month, or working out who is absent today, used to mean
// downloading everyone's whole history — around 620 KB for a dozen staff
// with two years behind them. Only the year key(s) the range actually spans
// (almost always one, occasionally two either side of 1 April) are read.
function doGetAttendanceRange_(body) {
  var sheet = getSheet_();
  var rows = sheet.getDataRange().getValues();
  var map = {};
  for (var i = 0; i < rows.length; i++) map[rows[i][0]] = rows[i][1];
  var from = String(body.from || ''), to = String(body.to || '');
  var ids = body.ids || [];
  var fyFrom = fyLabelForDateStr_(from), fyTo = fyLabelForDateStr_(to);
  var labels = (fyFrom && fyTo && fyFrom !== fyTo) ? [fyFrom, fyTo] : [fyFrom || fyTo];
  var out = {};
  for (var j = 0; j < ids.length; j++) {
    var all = mergedAttendanceForId_(map, ids[j], labels);
    var slice = {};
    // Dates are YYYY-MM-DD, so a string comparison is a date comparison.
    for (var d in all) { if (d >= from && d <= to) slice[d] = all[d]; }
    out[ids[j]] = slice;
  }
  return { ok: true, range: true, from: from, to: to, values: out };
}

// An employee's whole attendance history, merged across every year key they
// have. Used where a full history is genuinely needed — leave balances, PL
// encashment, reports that look back further than one year — instead of the
// range action, which only ever answers a bounded window.
function doGetAttendanceAll_(body) {
  var sheet = getSheet_();
  var rows = sheet.getDataRange().getValues();
  var map = {};
  for (var i = 0; i < rows.length; i++) map[rows[i][0]] = rows[i][1];
  var ids = body.ids || [];
  var out = {};
  for (var j = 0; j < ids.length; j++) out[ids[j]] = mergedAttendanceForId_(map, ids[j], null);
  return { ok: true, values: out };
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
    if (auth.role === 'engineer' && !engineerMayRead_(key, auth.username)) return forbidden_();
    const sheet = getSheet_();
    const row = findRow_(sheet, key);
    const value = row === -1 ? null : sheet.getRange(row, 2).getValue();
    return jsonOut_({ value: value });
  }

  // Every employee, one per `employee:<id>` key, in one call — the read side
  // of the same split attendance already went through (see
  // allEmployeesFromRows_). Never available to engineers: the plain
  // `employees` key never was either, and every field on an employee record
  // is pay data.
  if (action === 'getAllEmployees') {
    const auth = validateSession_(token);
    if (!auth) return jsonOut_({ error: 'unauthorized' });
    if (auth.role === 'engineer') return forbidden_();
    const sheet = getSheet_();
    const rows = sheet.getDataRange().getValues();
    return jsonOut_({ ok: true, employees: allEmployeesFromRows_(rows) });
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
  const isEngineer = auth.role === 'engineer';

  // The engineer app's own record, six fields, instead of the employees list.
  if (body.action === 'getMyProfile') return jsonOut_(doGetMyProfile_(auth));

  if (body.action === 'getAttendanceRange') {
    if (isEngineer) {
      // Only ever their own, whatever they ask for.
      var ownId = employeeIdForTrackingUser_(auth.username);
      var asked = body.ids || [];
      if (!ownId || asked.length !== 1 || asked[0] !== ownId) return forbidden_();
    }
    return jsonOut_(doGetAttendanceRange_(body));
  }

  if (body.action === 'getAttendanceAll') {
    if (isEngineer) {
      var ownId2 = employeeIdForTrackingUser_(auth.username);
      var asked2 = body.ids || [];
      if (!ownId2 || asked2.length !== 1 || asked2[0] !== ownId2) return forbidden_();
    }
    return jsonOut_(doGetAttendanceAll_(body));
  }

  if (body.action === 'deleteAttendanceAll') {
    if (isEngineer) return forbidden_();
    // Deletes attendance:<id> and every attendance:<id>:<year> key for one
    // employee. Used when an employee record is permanently deleted — now
    // that one person's attendance can be spread across several rows instead
    // of one, the old single remoteDelete('attendance:' + id) would have left
    // every year key behind.
    // Same fix as the main write lock below: fail fast and in JSON rather
    // than let an uncaught waitLock timeout come back as an unreadable
    // response and leave this execution running in the background anyway.
    var lockD = LockService.getScriptLock();
    try {
      lockD.waitLock(6000);
    } catch (lockErrD) {
      return jsonOut_({ error: 'busy', message: 'Server was busy with another save — please try again in a moment.' });
    }
    var deletedCount = 0;
    try {
      var sheetD = getSheet_();
      var dataD = sheetD.getDataRange().getValues();
      var prefixD = 'attendance:' + body.id + ':';
      for (var rIdx = dataD.length - 1; rIdx >= 1; rIdx--) {
        var kD = dataD[rIdx][0];
        if (kD === 'attendance:' + body.id || (typeof kD === 'string' && kD.indexOf(prefixD) === 0)) {
          sheetD.deleteRow(rIdx + 1);
          deletedCount++;
        }
      }
    } finally {
      lockD.releaseLock();
    }
    return jsonOut_({ ok: true, deleted: deletedCount });
  }

  if (body.action === 'moveEmployeeFolder') {
    if (isEngineer) return forbidden_();
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
    // One refused key refuses the whole call rather than quietly returning a
    // hole, so a screen that should not have asked fails loudly.
    if (isEngineer) {
      var wanted = body.keys || [];
      for (var g = 0; g < wanted.length; g++) {
        if (!engineerMayRead_(wanted[g], auth.username)) return forbidden_();
      }
    }
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
    // An engineer uploads exactly one kind of thing: the medical certificate
    // that a sick leave application needs. Anywhere else in Drive is HR's.
    if (isEngineer && (body.folderPath || []).indexOf('Medical Certificates') === -1) {
      return forbidden_();
    }
    return jsonOut_(doUploadDocument_(body));
  }

  if (body.action === 'getDriveFile') {
    // Employee documents (Aadhaar, PAN, cheques, ...) are HR data — the
    // engineer app has no legitimate reason to read any of them.
    if (isEngineer) return forbidden_();
    return jsonOut_(doGetDriveFile_(body));
  }

  if (body.action === 'getEmployeeHandbookFile') {
    // Allowed for both roles — see doGetEmployeeHandbookFile_'s own
    // comment for why this one is safe to leave open to engineers.
    return jsonOut_(doGetEmployeeHandbookFile_());
  }

  // Writes. An engineer may write their own trip, check-in and live-tracking
  // keys, and may add a leave application through setItem — which merges one
  // record server-side, so they cannot overwrite anybody else's. A wholesale
  // 'set' of leave_requests is refused: that would let one person replace the
  // entire queue. Everything else, including hr_password and employees, is HR.
  if (isEngineer) {
    if (body.action === 'set' || body.action === 'delete') {
      if (!engineerMayWrite_(body.key, auth.username)) return forbidden_();
    } else if (body.action === 'setMany') {
      var many = body.entries || {};
      for (var mk in many) {
        if (!engineerMayWrite_(mk, auth.username)) return forbidden_();
      }
    } else if (body.action === 'setItem') {
      if (body.key !== 'leave_requests') return forbidden_();
    } else if (body.action === 'saveFile') {
      return forbidden_();
    }
  }

  // Every write — from any device, any employee, any key — fights over this
  // one script-wide lock, so a burst of check-ins or edits arriving together
  // (a whole team clocking in within the same minute) can genuinely queue up
  // behind it. waitLock() used to be given 10s and nothing caught its
  // timeout: when it couldn't get the lock in time it threw, doPost() never
  // returned jsonOut_() at all, and Apps Script sent back its own default
  // error page instead of JSON — which the client can only see as "the
  // server sent back something unreadable," indistinguishable from a dead
  // network. Worse, the client's own retry budget aborts one attempt at 8s
  // and immediately fires another, but that first attempt keeps running here
  // regardless — Apps Script has no way to cancel it from an aborted HTTP
  // connection — so each retry added one more execution onto the same queue
  // instead of replacing the one still waiting. Waiting less than the
  // client's 8s attempt window (so a busy server fails fast, once, with a
  // real answer) and catching the timeout (so that answer is JSON the client
  // can actually read and retry against) breaks that pile-up.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(6000);
  } catch (lockErr) {
    return jsonOut_({ error: 'busy', message: 'Server was busy with another save — please try again in a moment.' });
  }
  try {
    if (body.action === 'set') {
      const sheet = getSheet_();
      const row = findRow_(sheet, body.key);
      if (row === -1) sheet.appendRow([body.key, body.value]);
      else if (!isStaleEmployeeWrite_(body.key, body.value, sheet.getRange(row, 2).getValue()) &&
               !isStalePayrollDocsWrite_(body.key, body.value, sheet.getRange(row, 2).getValue())) {
        sheet.getRange(row, 2).setValue(body.value);
      }
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
    } else if (body.action === 'setMany') {
      // Many keys, one request and one lock. Saving a month of attendance is
      // one write per employee, and the client sent them one at a time — a
      // dozen round trips to Apps Script, each paying script start-up and each
      // queueing for this lock. The sheet is read once here and written once.
      var sheetM = getSheet_();
      var dataM = sheetM.getDataRange().getValues();
      var indexM = {};
      for (var mi = 1; mi < dataM.length; mi++) indexM[dataM[mi][0]] = mi + 1;
      var entries = body.entries || {};
      var savedKeys = [];
      for (var k in entries) {
        if (!indexM[k]) {
          sheetM.appendRow([k, entries[k]]);
        } else if (!isStaleEmployeeWrite_(k, entries[k], dataM[indexM[k] - 1][1]) &&
                   !isStalePayrollDocsWrite_(k, entries[k], dataM[indexM[k] - 1][1])) {
          sheetM.getRange(indexM[k], 2).setValue(entries[k]);
        }
        savedKeys.push(k);
      }
      return jsonOut_({ ok: true, many: true, saved: savedKeys });
    } else if (body.action === 'saveFile') {
      // dedupeTail is only ever sent for the one-time HR letters — see
      // deleteAcrossYearFolders_ above. Every other caller omits it and this
      // is a no-op, unchanged from before.
      if (body.dedupeTail) deleteAcrossYearFolders_(body.dedupeTail, body.fileName);
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

// ===== NEW: daily HR digest email =====
// The frontend cannot send this itself — nothing in index.html runs unless
// somebody actually has the app open, so a "send every day at 9 PM" report
// has to live here, driven by a time-based trigger instead of a browser tab.
// Reads the same 'employees' and attendance:<id>:<year> keys the app itself
// reads (through the same mergedAttendanceForId_/fyLabelForDateStr_ helpers
// doGetAttendanceRange_ uses), so this can never show a different picture of
// today from what HR sees on screen.
//
// One-time setup: open this project in the Apps Script editor, select
// createDailyDigestTrigger from the function dropdown and press Run. That's
// the only step — from then on sendDailyDigestEmail fires on its own, once a
// day, with no browser or tab open anywhere. Re-running createDailyDigestTrigger
// is safe: it removes its own previous trigger first, so it never ends up
// sending two emails a day.
var DAILY_DIGEST_EMAIL = 'rasesh@rsinfotech.net';
var DAILY_DIGEST_HOUR = 21; // 9 PM. Apps Script fires a daily trigger sometime
                             // within the chosen hour, not to the exact minute.

function createDailyDigestTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendDailyDigestEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendDailyDigestEmail')
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_DIGEST_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Daily digest trigger created — sendDailyDigestEmail will now run once a day, around ' +
    DAILY_DIGEST_HOUR + ':00 IST, with nobody needing the app open.');
}

// Undoes createDailyDigestTrigger — stops the daily email without touching
// anything else. Run from the editor the same way.
function removeDailyDigestTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendDailyDigestEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' daily digest trigger(s).');
}

function todayIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
}

// The function the trigger actually calls. Also safe to run by hand from the
// editor at any time, to see today's digest immediately rather than waiting
// for the trigger.
function sendDailyDigestEmail() {
  var sheet = getSheet_();
  var rows = sheet.getDataRange().getValues();
  var map = {};
  for (var i = 0; i < rows.length; i++) map[rows[i][0]] = rows[i][1];

  var today = todayIso_();
  var employees = allEmployeesFromRows_(rows);
  // Resident Engineers sit outside the ordinary attendance rules everywhere
  // else in the app (see CLAUDE.md) — excluded here for the same reason a
  // "who is absent today" question does not apply to them.
  var active = employees.filter(function (e) {
    return e && e.employmentStatus !== 'left' && e.employeeType !== 'resident';
  });

  var fyLabel = fyLabelForDateStr_(today);
  var absent = [];
  var notMarked = [];
  active.forEach(function (e) {
    var att = mergedAttendanceForId_(map, e.id, [fyLabel]);
    var rec = att[today];
    var code = rec && rec.code;
    if (code === 'A') absent.push(e.name || e.id);
    else if (!code) notMarked.push(e.name || e.id);
  });

  // activity_log stores ts as toISOString() — UTC, not IST — so "today" has
  // to be compared in IST after parsing, not by matching the raw string
  // prefix, or entries logged in the first few hours of the IST day would be
  // silently dropped (their UTC date is still yesterday).
  var logRaw = map['activity_log'];
  var log = [];
  if (logRaw) { try { log = JSON.parse(logRaw) || []; } catch (e) { log = []; } }
  var todayLog = log.filter(function (l) {
    if (!l || !l.ts) return false;
    var d = new Date(l.ts);
    return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd') === today;
  });
  // addActivityLog unshifts (newest first); the email reads oldest first, the
  // order the day actually happened in.
  todayLog.reverse();

  var niceDate = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMMM yyyy');
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var listOrNone = function (names) {
    return names.length ? names.map(esc).join(', ') : 'None';
  };

  // Every section heading, from one place, so they cannot drift apart — the
  // whole point of the change was that each head reads the same and stands out
  // from the names underneath it.
  //
  // The size and weight are stated inline rather than left to <h3>. A bare <h3>
  // is sized by whatever is reading the mail, and Gmail and Outlook both
  // restyle it: the headings ended up barely larger than the body text, which
  // is what made "Absent today" hard to pick out at a glance. An explicit
  // font-size on the element itself is the only thing every client honours.
  var sectionHeading_ = function (text) {
    return '<h3 style="margin:22px 0 8px;font-family:Arial,sans-serif;font-size:19px;' +
      'font-weight:bold;color:#16213E;border-bottom:1px solid #E3E6EC;padding-bottom:5px;">' +
      esc(text) + '</h3>';
  };

  var html =
    '<div style="font-family:Arial,sans-serif;color:#16213E;font-size:14px;line-height:1.6;">' +
    '<h2 style="margin:0 0 4px;font-size:23px;font-weight:bold;color:#16213E;">' +
    'R.S. Infotech — Daily HR Digest</h2>' +
    '<p style="margin:0 0 18px;color:#5A6270;">' + esc(niceDate) + '</p>' +
    sectionHeading_('Absent today (' + absent.length + ' of ' + active.length + ')') +
    '<p style="margin:0 0 16px;">' + listOrNone(absent) + '</p>' +
    (notMarked.length
      ? sectionHeading_('Attendance not marked yet (' + notMarked.length + ')') +
        '<p style="margin:0 0 16px;">' + listOrNone(notMarked) + '</p>'
      : '') +
    sectionHeading_('Activity log (' + todayLog.length + ')') +
    (todayLog.length
      ? '<ul style="margin:0 0 16px;padding-left:18px;">' +
        todayLog.map(function (l) {
          var time = Utilities.formatDate(new Date(l.ts), 'Asia/Kolkata', 'HH:mm');
          return '<li>' + time + ' — ' + esc(l.text) + '</li>';
        }).join('') +
        '</ul>'
      : '<p style="margin:0 0 16px;color:#5A6270;">Nothing logged today.</p>') +
    '<p style="margin:20px 0 0;font-size:11px;color:#5A6270;">Sent automatically every day around ' +
    DAILY_DIGEST_HOUR + ':00 IST. Manage this from the Apps Script project — see createDailyDigestTrigger / removeDailyDigestTrigger.</p>' +
    '</div>';

  // The plain-text copy gets the same treatment in the only way plain text can:
  // the heading on its own line, in capitals, underlined. Some phone clients and
  // every "show original" view read this version, and a heading run into the
  // names after a colon is exactly as hard to scan there.
  var plainHeading_ = function (text) {
    return text.toUpperCase() + '\n' + new Array(text.length + 1).join('-') + '\n';
  };
  var plain = 'R.S. Infotech — Daily HR Digest — ' + niceDate + '\n\n' +
    plainHeading_('Absent today (' + absent.length + ' of ' + active.length + ')') +
    listOrNone(absent) + '\n\n' +
    (notMarked.length
      ? plainHeading_('Attendance not marked yet (' + notMarked.length + ')') +
        listOrNone(notMarked) + '\n\n'
      : '') +
    plainHeading_('Activity log (' + todayLog.length + ')') +
    (todayLog.length
      ? todayLog.map(function (l) {
          var time = Utilities.formatDate(new Date(l.ts), 'Asia/Kolkata', 'HH:mm');
          return '  ' + time + ' — ' + l.text;
        }).join('\n')
      : '  Nothing logged today.');

  MailApp.sendEmail({
    to: DAILY_DIGEST_EMAIL,
    subject: 'R.S. Infotech — Daily HR Digest — ' + niceDate,
    body: plain,
    htmlBody: html
  });
  Logger.log('Daily digest sent to ' + DAILY_DIGEST_EMAIL + ' — ' + absent.length + ' absent, ' +
    todayLog.length + ' activity log entr(y/ies).');
}

// ===== Monthly increment reminder =====
// "Whose increment is coming up next month", emailed on the 30th so there is
// a full month's notice to agree the figures and prepare the letters.
//
// One-time setup: open this project in the Apps Script editor, pick
// createIncrementReminderTrigger from the function dropdown and press Run.
// That is the only step. Re-running it is safe — it clears its own previous
// trigger first, so it can never end up sending twice.
// removeIncrementReminderTrigger undoes it.
//
// The trigger runs DAILY and the function returns immediately unless today
// is the send day. That is deliberate rather than lazy: Apps Script's
// onMonthDay(30) simply never fires in February, so one month would be
// silently skipped every year. isIncrementReminderSendDay_ sends on the
// 30th, or on the last day of the month when the month is shorter than
// that — one email a month, every month, February included.
var INCREMENT_REMINDER_EMAIL = 'rasesh@rsinfotech.net';
var INCREMENT_REMINDER_DAY = 30;
var INCREMENT_REMINDER_HOUR = 10; // 10 AM IST

function createIncrementReminderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendIncrementReminderEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendIncrementReminderEmail')
    .timeBased()
    .everyDays(1)
    .atHour(INCREMENT_REMINDER_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Increment reminder trigger created — sendIncrementReminderEmail now runs daily around ' +
    INCREMENT_REMINDER_HOUR + ':00 IST and emails only on day ' + INCREMENT_REMINDER_DAY +
    ' (or the last day of a shorter month).');
}

// Undoes createIncrementReminderTrigger — stops the monthly email without
// touching the daily digest or anything else. Run from the editor the same way.
function removeIncrementReminderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendIncrementReminderEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' increment reminder trigger(s).');
}

// The 30th, or the last day of the month when the month is shorter than that.
// m is 1-based; new Date(y, m, 0) is the last day of month m.
function isIncrementReminderSendDay_(y, m, d) {
  var lastDay = new Date(y, m, 0).getDate();
  return d === Math.min(INCREMENT_REMINDER_DAY, lastDay);
}

// 'YYYY-MM' of the month after the one given, rolling the year over in December.
function nextMonthYm_(y, m) {
  var ny = m === 12 ? y + 1 : y;
  var nm = m === 12 ? 1 : m + 1;
  return ny + '-' + (nm < 10 ? '0' + nm : String(nm));
}

// The function the trigger calls. Also safe to run by hand from the editor at
// any time to see the email immediately — pass true to skip the day check.
function sendIncrementReminderEmail(force) {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var y = Number(istToday.slice(0, 4));
  var m = Number(istToday.slice(5, 7));
  var d = Number(istToday.slice(8, 10));
  if (force !== true && !isIncrementReminderSendDay_(y, m, d)) return;

  var targetYm = nextMonthYm_(y, m);
  var sheet = getSheet_();
  var employees = allEmployeesFromRows_(sheet.getDataRange().getValues());

  var due = employees.filter(function (e) {
    if (!e || e.employmentStatus === 'left') return false;
    if (!e.nextIncrement) return false;
    if (String(e.nextIncrement).slice(0, 7) !== targetYm) return false;
    // Already dealt with through Record Increment — the same "Done" test the
    // employee's own screen uses: a salary history entry effective on or
    // after the due date means the increment has been recorded, so there is
    // nothing left to chase and it is left off the list.
    var latestFrom = '';
    var hist = (e.salaryHistory && e.salaryHistory.length) ? e.salaryHistory : [];
    for (var i = 0; i < hist.length; i++) {
      if (hist[i] && hist[i].from && hist[i].from > latestFrom) latestFrom = hist[i].from;
    }
    return !(latestFrom && latestFrom >= e.nextIncrement);
  }).sort(function (a, b) {
    return String(a.nextIncrement).localeCompare(String(b.nextIncrement));
  });

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  // dd/mm/yyyy, the same way every date is written everywhere else in the app.
  var niceDate = function (iso) {
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso);
  };
  var monthName = Utilities.formatDate(
    new Date(Number(targetYm.slice(0, 4)), Number(targetYm.slice(5, 7)) - 1, 1),
    'Asia/Kolkata', 'MMMM yyyy');

  var subject = 'R.S. Infotech — Increments due in ' + monthName + ' (' + due.length + ')';
  var html, plain;
  if (!due.length) {
    html = '<p>No increments are due in ' + esc(monthName) + '.</p>';
    plain = 'No increments are due in ' + monthName + '.';
  } else {
    html = '<p>' + due.length + ' increment' + (due.length === 1 ? ' is' : 's are') +
      ' due in <strong>' + esc(monthName) + '</strong>:</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><th align="left">Employee</th><th align="left">Designation</th>' +
      '<th align="left">Increment due</th></tr>' +
      due.map(function (e) {
        return '<tr><td>' + esc(e.name || e.id) + '</td><td>' + esc(e.designation || '') +
          '</td><td>' + esc(niceDate(e.nextIncrement)) + '</td></tr>';
      }).join('') +
      '</table>' +
      '<p style="color:#666;font-size:12px;">Anyone whose increment has already been recorded ' +
      'through Record Increment is left off this list.</p>';
    plain = due.length + ' increment(s) due in ' + monthName + ':\n\n' +
      due.map(function (e) {
        return '  ' + (e.name || e.id) + ' — ' + (e.designation || '') +
          ' — due ' + niceDate(e.nextIncrement);
      }).join('\n');
  }

  MailApp.sendEmail({ to: INCREMENT_REMINDER_EMAIL, subject: subject, body: plain, htmlBody: html });
  Logger.log('Increment reminder sent to ' + INCREMENT_REMINDER_EMAIL + ' — ' + due.length +
    ' due in ' + monthName + '.');
}

// ===== Birthday reminder, one day ahead =====
// Goes to HR, not to the employee: the subject carries the employee's own
// name and date, which is what someone ARRANGING the wish needs and not what
// the person having the birthday would be sent. Nothing here emails staff
// directly — no employee address is read or used. To turn this into a
// message to the employee instead, that is a deliberate change of recipient,
// not a setting.
//
// One-time setup: open this project in the Apps Script editor, pick
// createBirthdayReminderTrigger from the function dropdown and press Run.
// Re-running it is safe — it clears its own previous trigger first.
// removeBirthdayReminderTrigger undoes it, without touching the other two
// scheduled emails.
//
// One email per person, not one listing everybody: the subject line has to
// name the individual, so two birthdays on the same day are two emails.
var BIRTHDAY_REMINDER_EMAIL = 'rasesh@rsinfotech.net';
var BIRTHDAY_REMINDER_HOUR = 9; // 9 AM IST, the day before

function createBirthdayReminderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendBirthdayReminderEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendBirthdayReminderEmail')
    .timeBased()
    .everyDays(1)
    .atHour(BIRTHDAY_REMINDER_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Birthday reminder trigger created — sendBirthdayReminderEmail now runs daily around ' +
    BIRTHDAY_REMINDER_HOUR + ':00 IST and emails about tomorrow\'s birthdays.');
}

function removeBirthdayReminderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendBirthdayReminderEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' birthday reminder trigger(s).');
}

// Tomorrow, in IST, as {y, m, d} with m 1-based. Built from the IST date
// string rather than the server's own clock, and through a Date so the
// month and year roll over on their own at the 31st and at 31 December.
function tomorrowIstParts_() {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var t = new Date(Number(istToday.slice(0, 4)), Number(istToday.slice(5, 7)) - 1,
                   Number(istToday.slice(8, 10)) + 1);
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), date: t };
}

// The function the trigger calls. Safe to run by hand from the editor to see
// what would go out for tomorrow.
function sendBirthdayReminderEmail() {
  var tm = tomorrowIstParts_();
  var mm = tm.m < 10 ? '0' + tm.m : String(tm.m);
  var dd = tm.d < 10 ? '0' + tm.d : String(tm.d);
  var target = mm + '-' + dd;

  // Someone born on 29 February has no birthday at all in a common year.
  // Rather than skip them three years in four, they are wished on the 28th
  // in those years — so the reminder still goes out the day before.
  var isLeap = new Date(tm.y, 1, 29).getDate() === 29;
  var alsoFeb29 = !isLeap && target === '02-28';

  var sheet = getSheet_();
  var employees = allEmployeesFromRows_(sheet.getDataRange().getValues());
  var birthdays = employees.filter(function (e) {
    if (!e || e.employmentStatus === 'left') return false;
    if (!e.dob || String(e.dob).length < 10) return false;
    var md = String(e.dob).slice(5, 10);
    return md === target || (alsoFeb29 && md === '02-29');
  });

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var dateDisp = dd + '/' + mm + '/' + tm.y;                 // dd/mm/yyyy, as everywhere else
  var weekday = Utilities.formatDate(tm.date, 'Asia/Kolkata', 'EEEE');

  birthdays.forEach(function (e) {
    var name = e.name || e.id;
    var role = [e.designation, e.department].filter(function (x) { return !!x; }).join(', ');
    // Only when the year on file is a real one — a dob stored with a
    // placeholder year would otherwise announce a nonsense age.
    var birthYear = Number(String(e.dob).slice(0, 4));
    var turning = (birthYear > 1900 && birthYear < tm.y) ? (tm.y - birthYear) : null;

    var subject = 'R.S. Infotech — Upcoming birthday: ' + name + ' — ' + dateDisp;
    var line = name + (role ? ' (' + role + ')' : '') +
      (turning ? ' turns ' + turning : ' has a birthday') +
      ' tomorrow, ' + weekday + ' ' + dateDisp + '.';

    var html = '<p>' + esc(line) + '</p>' +
      '<p>Sent a day ahead so there is time to arrange a card, a message or a note to the team.</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><td><strong>Employee</strong></td><td>' + esc(name) + '</td></tr>' +
      '<tr><td><strong>Employee ID</strong></td><td>' + esc(e.id || '') + '</td></tr>' +
      (e.designation ? '<tr><td><strong>Designation</strong></td><td>' + esc(e.designation) + '</td></tr>' : '') +
      (e.department ? '<tr><td><strong>Department</strong></td><td>' + esc(e.department) + '</td></tr>' : '') +
      '<tr><td><strong>Birthday</strong></td><td>' + esc(weekday + ' ' + dateDisp) + '</td></tr>' +
      (turning ? '<tr><td><strong>Turning</strong></td><td>' + turning + '</td></tr>' : '') +
      '</table>';
    var plain = line + '\n\n' +
      'Sent a day ahead so there is time to arrange a card, a message or a note to the team.\n\n' +
      '  Employee   : ' + name + '\n' +
      '  Employee ID: ' + (e.id || '') + '\n' +
      (e.designation ? '  Designation: ' + e.designation + '\n' : '') +
      (e.department ? '  Department : ' + e.department + '\n' : '') +
      '  Birthday   : ' + weekday + ' ' + dateDisp + '\n' +
      (turning ? '  Turning    : ' + turning + '\n' : '');

    MailApp.sendEmail({ to: BIRTHDAY_REMINDER_EMAIL, subject: subject, body: plain, htmlBody: html });
  });

  Logger.log('Birthday reminder — ' + birthdays.length + ' birthday(ies) tomorrow (' + dateDisp +
    '), ' + birthdays.length + ' email(s) sent to ' + BIRTHDAY_REMINDER_EMAIL + '.');
}

// ===== Monthly report pack, emailed on the 1st for the month just ended =====
//
// This ATTACHES the CSVs the app already filed in Drive. It does not compute a
// single figure of its own, and it must never be changed to.
//
// Every number in these six reports comes out of index.html —
// computeSalaryForEmployee, calculatePfFor, computeEsi, monthlyPtFor, the
// attendance resolver, sandwich leave, loan and advance recovery. Working any
// of that out a second time here would be a second copy of the payroll
// arithmetic, which is the one thing this project has been bitten by
// repeatedly: three separate times HR reported the Add Employee form
// disagreeing with the Salary Sheet, and every time the cause was a screen
// that had grown its own copy of the sum. A fourth copy, in a different
// language, that nobody looks at because it arrives by email, would be the
// worst version of that bug — the figures would drift and the drift would be
// invisible until somebody's bank transfer was wrong.
//
// So the deal is: whatever HR saw on screen is exactly what gets attached,
// byte for byte, because it IS the file the report wrote when HR opened it.
// The consequence is that a report nobody opened for that month has no file to
// attach, and the email says so by name instead of quietly arriving one
// attachment short. Each attachment is also stamped with the date its Drive
// copy was last written, so a copy generated mid-month — before attendance was
// finished — is visible as stale rather than trusted silently.
var MONTHLY_REPORTS_EMAIL = 'rasesh@rsinfotech.net';
var MONTHLY_REPORTS_HOUR = 8; // 8 AM IST on the 1st

function createMonthlyReportsTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendMonthlyReportsEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendMonthlyReportsEmail')
    .timeBased()
    .everyDays(1)
    .atHour(MONTHLY_REPORTS_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Monthly report pack trigger created — sendMonthlyReportsEmail now runs daily around ' +
    MONTHLY_REPORTS_HOUR + ':00 IST and emails only on the 1st.');
}

// Undoes createMonthlyReportsTrigger — stops the monthly pack without touching
// the daily digest, the increment reminder or the birthday reminder.
function removeMonthlyReportsTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendMonthlyReportsEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' monthly report pack trigger(s).');
}

// 'YYYY-MM' of the month before today, in IST, rolling the year back in January.
function prevMonthYmIst_() {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var y = Number(istToday.slice(0, 4));
  var m = Number(istToday.slice(5, 7)) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return y + '-' + ('0' + m).slice(-2);
}

// Walks the folder path WITHOUT creating anything, unlike getOrCreateFolderPath_.
// This job runs every month whether or not HR opened a report, and a creating
// walk would leave a trail of empty folders behind for months that were never
// generated. Returns null the moment a segment is missing.
function findFolderPath_(pathParts) {
  var folder = DriveApp.getFolderById(ROOT_FOLDER_ID);
  for (var i = 0; i < pathParts.length; i++) {
    var it = folder.getFoldersByName(pathParts[i]);
    if (!it.hasNext()) return null;
    folder = it.next();
  }
  return folder;
}

// Where each report of the pack files itself, mirroring index.html's own
// hrYearPath(monthVal + '-01', ...) calls exactly — Salary Sheet, Final Salary
// Sheet and Attendance Sheet under Dashboard, PF, ESI and PT under Reports. The
// year folder is the financial year the month BELONGS to, not the one it was
// generated in, which is why March files land in the year that is closing.
function monthlyReportSpecs_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var fy = fyLabelFor_(y, m);
  var dashboard = ['HR Management', fy, 'Dashboard'];
  var reports = ['HR Management', fy, 'Reports'];
  return [
    { label: 'Salary Sheet',
      path: dashboard.concat(['Salary Sheet']),
      files: ['Salary Sheet - ' + ym + '.csv'],
      where: 'Dashboard > Salary Sheet' },
    // Two names, because this report was renamed. Months generated since the
    // rename are filed as "Final Salary Sheet for Accountant - <ym>.csv";
    // months generated before it are still sitting in the same folder under the
    // old "Final Salary Sheet - <ym>.csv", and August 2026 is one of them. The
    // folder deliberately kept its old name so nothing was orphaned by the
    // rename (see index.html's own note at the Final Salary Sheet stash), so
    // accepting both names here is what makes those earlier months attachable
    // instead of being reported missing when the file is right there.
    { label: 'Final Salary Sheet for Accountant',
      path: dashboard.concat(['Final Salary Sheet']),
      files: ['Final Salary Sheet for Accountant - ' + ym + '.csv',
              'Final Salary Sheet - ' + ym + '.csv'],
      where: 'Dashboard > Final Salary Sheet' },
    { label: 'Attendance Sheet',
      path: dashboard.concat(['Attendance Sheet']),
      files: ['Attendance Sheet - ' + ym + '.csv'],
      where: 'Dashboard > Attendance Sheet' },
    { label: 'PF Return',
      path: reports.concat(['PF']),
      files: ['PF Return - ' + ym + '.csv'],
      where: 'Reports > PF' },
    { label: 'ESI Return',
      path: reports.concat(['ESI']),
      files: ['ESI Return - ' + ym + '.csv'],
      where: 'Reports > ESI' },
    // Filed as "PT Report", not "PT Return" like its PF and ESI neighbours —
    // renderStatutoryReport builds the name from the label it is called with,
    // and the PT screen passes 'PT Report'.
    { label: 'PT Report',
      path: reports.concat(['PT Report']),
      files: ['PT Report - ' + ym + '.csv'],
      where: 'Reports > PT Report' }
  ];
}

// The newest file matching any of the accepted names. Two reasons it is not a
// simple single lookup: a report that has been renamed has copies under both
// names (see Final Salary Sheet above), and a folder can in principle hold more
// than one file of the same name. saveFile_ trashes same-named files before
// writing, so the duplicate case is rare — taking the most recently written is
// simply the right answer whenever it happens.
function newestFileNamed_(folder, fileNames) {
  var names = Array.isArray(fileNames) ? fileNames : [fileNames];
  var best = null;
  for (var n = 0; n < names.length; n++) {
    var it = folder.getFilesByName(names[n]);
    while (it.hasNext()) {
      var f = it.next();
      if (!best || f.getLastUpdated().getTime() > best.getLastUpdated().getTime()) best = f;
    }
  }
  return best;
}

// force=true sends regardless of the date, for testing from the editor.
function sendMonthlyReportsEmail(force) {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== 1) return;

  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var monthLabel = Utilities.formatDate(new Date(y, m - 1, 1), 'Asia/Kolkata', 'MMMM yyyy');
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  var specs = monthlyReportSpecs_(ym);
  var attachments = [], found = [], missing = [];
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    var folder = findFolderPath_(spec.path);
    var file = folder ? newestFileNamed_(folder, spec.files) : null;
    if (file) {
      attachments.push(file.getBlob());
      // file.getName(), not spec.files[0] — the name actually attached is the
      // one worth showing, so a month still filed under a report's old name
      // reads as what it is instead of as the new name it does not have.
      found.push({ label: spec.label, file: file.getName(), where: spec.where,
        updated: Utilities.formatDate(file.getLastUpdated(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm') });
    } else {
      missing.push({ label: spec.label, where: spec.where });
    }
  }

  var subject = 'R.S. Infotech — ' + monthLabel + ' reports (' + found.length + ' of ' +
    specs.length + ')' + (missing.length ? ' — ' + missing.length + ' missing' : '');

  var intro = found.length
    ? 'Attached are the ' + monthLabel + ' reports as they were last generated in the app.'
    : 'None of the ' + monthLabel + ' reports have been generated yet, so there is nothing to attach.';
  // Said plainly because it decides whether the attachment can be trusted: the
  // Drive copy is written when HR opens the report, so its date is the date the
  // figures were last worked out, not the date this email went out.
  var caveat = 'Each file is the copy written when that report was last opened in the app — the ' +
    '"generated" time below is when its figures were last worked out. Reopen a report in the app ' +
    'if anything has changed since.';
  var howTo = 'To produce a missing report, open it once in the app for ' + monthLabel +
    '; it files its own copy in Drive, and the next run of this email will pick it up.';

  var html = '<p>' + esc(intro) + '</p>';
  if (found.length) {
    html += '<p>' + esc(caveat) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><th align="left">Report</th><th align="left">File</th><th align="left">Generated</th></tr>';
    for (var a = 0; a < found.length; a++) {
      html += '<tr><td>' + esc(found[a].label) + '</td><td>' + esc(found[a].file) +
        '</td><td>' + esc(found[a].updated) + '</td></tr>';
    }
    html += '</table>';
  }
  if (missing.length) {
    html += '<p><strong>Not attached — never generated for ' + esc(monthLabel) + ':</strong></p><ul>';
    for (var b = 0; b < missing.length; b++) {
      html += '<li>' + esc(missing[b].label) + ' <span style="color:#666">(' + esc(missing[b].where) + ')</span></li>';
    }
    html += '</ul><p>' + esc(howTo) + '</p>';
  }

  var plain = intro + '\n\n';
  if (found.length) {
    plain += caveat + '\n\n';
    for (var c = 0; c < found.length; c++) {
      plain += '  ' + found[c].label + '\n' +
        '    File     : ' + found[c].file + '\n' +
        '    Generated: ' + found[c].updated + '\n';
    }
    plain += '\n';
  }
  if (missing.length) {
    plain += 'Not attached — never generated for ' + monthLabel + ':\n';
    for (var d = 0; d < missing.length; d++) {
      plain += '  - ' + missing[d].label + ' (' + missing[d].where + ')\n';
    }
    plain += '\n' + howTo + '\n';
  }

  MailApp.sendEmail({
    to: MONTHLY_REPORTS_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Monthly report pack for ' + monthLabel + ' sent to ' + MONTHLY_REPORTS_EMAIL +
    ' — ' + found.length + ' attached, ' + missing.length + ' missing.');
}

// ===== Loan & Advance Report, emailed separately on the 1st =====
//
// Its own email rather than a sixth attachment on the pack above, because it is
// a different kind of thing and reads wrongly filed next to the other five.
// Those are five views of one closed month; this is a running position that
// belongs to no month at all.
//
// The Loan & Advance Report is a snapshot of the day it is run, not of a chosen
// month — index.html files it as "Loan & Advance Report - <today>.csv" with the
// RUN date in the name, and every run leaves a new file rather than replacing
// the last one. So there is no such thing as "last month's" copy to fetch: what
// exists is however many snapshots HR happened to take. This attaches the most
// recent one and says, plainly and in the subject, what date it is a snapshot
// of and how many days stale that makes it.
//
// That date matters more here than anywhere else in these emails. A loan
// balance moves with every month's EMI, so a snapshot taken mid-August is not
// the 1 September position — the balances are a month behind and the report
// looks perfectly valid while being wrong for the day it arrives. Saying the
// snapshot date is what stops it being read as current. As everywhere else in
// these emails, nothing is recalculated here: loansOf, loanScheduleThrough and
// loanEmiRateAsOf live in index.html and stay the only place that arithmetic
// happens.
var LOAN_REPORT_EMAIL = 'rasesh@rsinfotech.net';
var LOAN_REPORT_HOUR = 8; // 8 AM IST on the 1st, alongside the report pack

function createLoanReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendLoanAdvanceReportEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendLoanAdvanceReportEmail')
    .timeBased()
    .everyDays(1)
    .atHour(LOAN_REPORT_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Loan & Advance report trigger created — sendLoanAdvanceReportEmail now runs daily around ' +
    LOAN_REPORT_HOUR + ':00 IST and emails only on the 1st.');
}

// Undoes createLoanReportTrigger — stops this email without touching the
// monthly pack, the daily digest, the increment reminder or the birthday one.
function removeLoanReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendLoanAdvanceReportEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' loan & advance report trigger(s).');
}

// The most recent snapshot across the financial years given, judged by the date
// in the FILENAME rather than the file's Drive timestamp: the name carries the
// day the position was taken, which is the date that means something here, and
// the two can differ if a file is ever moved or re-filed.
//
// Two years are searched, not one, because of the April boundary. This runs on
// the 1st, and on 1 April the newest snapshot was almost certainly taken on 31
// March — which sits in the year that just closed, while today's year folder is
// brand new and quite possibly empty. Looking only at today's year would report
// nothing available on exactly the morning the year-end position matters most.
function newestLoanAdvanceReport_(fyLabels) {
  var seen = {}, best = null;
  for (var i = 0; i < fyLabels.length; i++) {
    if (seen[fyLabels[i]]) continue;
    seen[fyLabels[i]] = true;
    var folder = findFolderPath_(['HR Management', fyLabels[i], 'Reports', 'Loan & Advance Report']);
    if (!folder) continue;
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var m = /(\d{4}-\d{2}-\d{2})\.csv$/.exec(f.getName());
      if (!m) continue;
      if (!best || m[1] > best.date) best = { file: f, date: m[1] };
    }
  }
  return best;
}

// Whole days between two 'YYYY-MM-DD' strings. Built from the parts rather than
// Date.parse because a date-only string parses as UTC midnight, which lands on
// the wrong day in IST — the same trap CLAUDE.md flags for financial years.
function daysBetweenYmd_(fromYmd, toYmd) {
  var a = new Date(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(5, 7)) - 1, Number(fromYmd.slice(8, 10)));
  var b = new Date(Number(toYmd.slice(0, 4)), Number(toYmd.slice(5, 7)) - 1, Number(toYmd.slice(8, 10)));
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// force=true sends regardless of the date, for testing from the editor.
function sendLoanAdvanceReportEmail(force) {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== 1) return;

  var y = Number(istToday.slice(0, 4)), m = Number(istToday.slice(5, 7));
  var prevM = m === 1 ? 12 : m - 1, prevY = m === 1 ? y - 1 : y;
  var thisFy = fyLabelFor_(y, m), prevFy = fyLabelFor_(prevY, prevM);
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var disp = function (ymd) { return ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4); };

  var hit = newestLoanAdvanceReport_([thisFy, prevFy]);
  var todayDisp = disp(istToday);

  var subject, plain, html, attachments = [];
  if (hit) {
    var age = daysBetweenYmd_(hit.date, istToday);
    var snapDisp = disp(hit.date);
    var ageText = age <= 0 ? 'taken today'
      : age === 1 ? 'taken yesterday'
      : 'taken ' + age + ' days ago';
    subject = 'R.S. Infotech — Loan & Advance Report — position as at ' + snapDisp +
      (age > 7 ? ' (' + age + ' days old)' : '');
    attachments.push(hit.file.getBlob());

    var lead = 'Attached is the Loan & Advance Report as it stood on ' + snapDisp + ', ' + ageText + '.';
    // The whole point of this email: a loan balance is only true for the day it
    // was taken, and an old snapshot reads as current unless it is labelled.
    var freshness = age > 0
      ? 'Balances move with each month’s EMI, so this is the position on ' + snapDisp +
        ', not on ' + todayDisp + '. Open the Loan & Advance Report in the app for a current one — ' +
        'it files its own copy, and the next run of this email will pick that up instead.'
      : 'This is today’s position.';

    html = '<p>' + esc(lead) + '</p><p>' + esc(freshness) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><td><strong>Position as at</strong></td><td>' + esc(snapDisp) + '</td></tr>' +
      '<tr><td><strong>Age</strong></td><td>' + esc(ageText) + '</td></tr>' +
      '<tr><td><strong>File</strong></td><td>' + esc(hit.file.getName()) + '</td></tr>' +
      '</table>';
    plain = lead + '\n\n' + freshness + '\n\n' +
      '  Position as at: ' + snapDisp + '\n' +
      '  Age           : ' + ageText + '\n' +
      '  File          : ' + hit.file.getName() + '\n';
  } else {
    subject = 'R.S. Infotech — Loan & Advance Report — none available';
    var none = 'The Loan & Advance Report has never been generated, so there is nothing to attach.';
    var fix = 'Open Reports > Loan & Advance Report in the app once; it files its own copy in Drive, ' +
      'and the next run of this email will attach it.';
    html = '<p>' + esc(none) + '</p><p>' + esc(fix) + '</p>';
    plain = none + '\n\n' + fix + '\n';
  }

  MailApp.sendEmail({
    to: LOAN_REPORT_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Loan & Advance report email sent to ' + LOAN_REPORT_EMAIL + ' — ' +
    (hit ? 'snapshot ' + hit.date : 'none available') + '.');
}

// ===== Monthly Leave Detail Report, emailed separately on the 1st =====
//
// Like the report pack this is a closed month's report, so there is a definite
// "last month's file" to look for — unlike the Loan & Advance Report, which is
// a running position with no month of its own. Its own email because that is
// what was asked for, and because leave detail is read by different people than
// the payroll sheets.
//
// The one thing to be careful about is the filename. Every other report is
// filed with a numeric month — "Salary Sheet - 2026-08.csv" — but this one is
// named with the month spelled out: "Monthly Leave Detail Report - August
// 2026.csv", because index.html builds it from MONTH_NAMES rather than the
// numeric string. Get that wrong and the lookup silently finds nothing.
var LEAVE_DETAIL_EMAIL = 'rasesh@rsinfotech.net';
var LEAVE_DETAIL_HOUR = 8; // 8 AM IST on the 1st

// Deliberately a hardcoded list rather than Utilities.formatDate(..., 'MMMM'),
// which formats in the SCRIPT's locale. These names are not decoration here —
// they are half of a filename that has to match what index.html wrote, byte for
// byte, and a script locale that is not English would quietly produce a name
// that matches no file at all. This mirrors index.html's own MONTH_NAMES.
var LEAVE_DETAIL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function createLeaveDetailReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendLeaveDetailReportEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendLeaveDetailReportEmail')
    .timeBased()
    .everyDays(1)
    .atHour(LEAVE_DETAIL_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Monthly Leave Detail report trigger created — sendLeaveDetailReportEmail now runs daily ' +
    'around ' + LEAVE_DETAIL_HOUR + ':00 IST and emails only on the 1st.');
}

// Undoes createLeaveDetailReportTrigger — stops this email without touching any
// of the others.
function removeLeaveDetailReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendLeaveDetailReportEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' monthly leave detail report trigger(s).');
}

// force=true sends regardless of the date, for testing from the editor.
function sendLeaveDetailReportEmail(force) {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== 1) return;

  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var fileName = 'Monthly Leave Detail Report - ' + monthLabel + '.csv';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  // Filed under the financial year the reported month belongs to, so March
  // lands in the year that is closing rather than the one just opened.
  var folder = findFolderPath_(['HR Management', fyLabelFor_(y, m), 'Reports', 'Monthly Leave Detail Report']);
  var file = folder ? newestFileNamed_(folder, [fileName]) : null;

  var subject, plain, html, attachments = [];
  if (file) {
    var updated = Utilities.formatDate(file.getLastUpdated(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm');
    attachments.push(file.getBlob());
    subject = 'R.S. Infotech — Monthly Leave Detail Report — ' + monthLabel;
    var lead = 'Attached is the Monthly Leave Detail Report for ' + monthLabel + '.';
    // Same caveat as the report pack, for the same reason: the Drive copy is
    // written when HR opens the report, so its date is when the figures were
    // last worked out, not when this email went out. A copy generated before
    // the month ended is missing the last of the month's leave.
    var caveat = 'This is the copy written when the report was last opened in the app, on ' + updated +
      '. Reopen it in the app if any leave has been recorded or corrected since.';
    html = '<p>' + esc(lead) + '</p><p>' + esc(caveat) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><td><strong>Month</strong></td><td>' + esc(monthLabel) + '</td></tr>' +
      '<tr><td><strong>File</strong></td><td>' + esc(file.getName()) + '</td></tr>' +
      '<tr><td><strong>Generated</strong></td><td>' + esc(updated) + '</td></tr>' +
      '</table>';
    plain = lead + '\n\n' + caveat + '\n\n' +
      '  Month    : ' + monthLabel + '\n' +
      '  File     : ' + file.getName() + '\n' +
      '  Generated: ' + updated + '\n';
  } else {
    subject = 'R.S. Infotech — Monthly Leave Detail Report — ' + monthLabel + ' not generated';
    var none = 'The Monthly Leave Detail Report has not been generated for ' + monthLabel +
      ', so there is nothing to attach.';
    var fix = 'Open Reports > Monthly Leave Detail Report in the app once for ' + monthLabel +
      '; it files its own copy in Drive, and the next run of this email will attach it.';
    html = '<p>' + esc(none) + '</p><p>' + esc(fix) + '</p>';
    plain = none + '\n\n' + fix + '\n';
  }

  MailApp.sendEmail({
    to: LEAVE_DETAIL_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Monthly Leave Detail report email for ' + monthLabel + ' sent to ' + LEAVE_DETAIL_EMAIL +
    ' — ' + (file ? 'attached' : 'not generated') + '.');
}

// ===== Consultant Report, emailed separately on the 2nd =====
//
// The 2nd rather than the 1st, which is what was asked for. It leaves a day
// after month end for the last attendance and payroll corrections to be made,
// and every report email here attaches the copy the app filed when HR last
// opened the report, so a later send makes it likelier that copy is the final
// one.
//
// Two files, not one. The Consultant Report and the Consultant Final Summary
// Report are a matched pair for the same reader — the per-employee detail and
// the totals that summarise it — and a consultant sent one without the other
// generally asks for the other. Both are attached when both exist; drop the
// summary from CONSULTANT_REPORT_SPECS_ if only the detail is wanted.
var CONSULTANT_REPORT_EMAIL = 'rasesh@rsinfotech.net';
var CONSULTANT_REPORT_DAY = 2;
var CONSULTANT_REPORT_HOUR = 8; // 8 AM IST on the 2nd

function createConsultantReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendConsultantReportEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendConsultantReportEmail')
    .timeBased()
    .everyDays(1)
    .atHour(CONSULTANT_REPORT_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Consultant report trigger created — sendConsultantReportEmail now runs daily around ' +
    CONSULTANT_REPORT_HOUR + ':00 IST and emails only on day ' + CONSULTANT_REPORT_DAY + '.');
}

// Undoes createConsultantReportTrigger — stops this email without touching any
// of the others.
function removeConsultantReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendConsultantReportEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' consultant report trigger(s).');
}

// Both consultant reports use the numeric month in their filenames, the same
// form as the Salary Sheet and unlike the Monthly Leave Detail Report, which
// spells the month out.
function consultantReportSpecs_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var reports = ['HR Management', fyLabelFor_(y, m), 'Reports'];
  return [
    { label: 'Consultant Report',
      path: reports.concat(['Consultant Report']),
      files: ['Consultant Report - ' + ym + '.csv'],
      where: 'Reports > Consultant Report' },
    { label: 'Consultant Final Summary Report',
      path: reports.concat(['Consultant Final Summary Report']),
      files: ['Consultant Final Summary Report - ' + ym + '.csv'],
      where: 'Reports > Consultant Final Summary Report' }
  ];
}

// force=true sends regardless of the date, for testing from the editor.
function sendConsultantReportEmail(force) {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== CONSULTANT_REPORT_DAY) return;

  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  var specs = consultantReportSpecs_(ym);
  var attachments = [], found = [], missing = [];
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    var folder = findFolderPath_(spec.path);
    var file = folder ? newestFileNamed_(folder, spec.files) : null;
    if (file) {
      attachments.push(file.getBlob());
      found.push({ label: spec.label, file: file.getName(), where: spec.where,
        updated: Utilities.formatDate(file.getLastUpdated(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm') });
    } else {
      missing.push({ label: spec.label, where: spec.where });
    }
  }

  var subject = 'R.S. Infotech — Consultant Report — ' + monthLabel +
    (missing.length ? ' (' + found.length + ' of ' + specs.length + ')' : '');

  var intro = found.length
    ? 'Attached ' + (found.length === 1 ? 'is the consultant report' : 'are the consultant reports') +
      ' for ' + monthLabel + '.'
    : 'The consultant reports have not been generated for ' + monthLabel + ', so there is nothing to attach.';
  var caveat = 'Each file is the copy written when that report was last opened in the app — the ' +
    '"generated" time below is when its figures were last worked out. Reopen a report in the app ' +
    'if anything has changed since.';
  var howTo = 'To produce a missing report, open it once in the app for ' + monthLabel +
    '; it files its own copy in Drive, and the next run of this email will pick it up.';

  var html = '<p>' + esc(intro) + '</p>';
  if (found.length) {
    html += '<p>' + esc(caveat) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><th align="left">Report</th><th align="left">File</th><th align="left">Generated</th></tr>';
    for (var a = 0; a < found.length; a++) {
      html += '<tr><td>' + esc(found[a].label) + '</td><td>' + esc(found[a].file) +
        '</td><td>' + esc(found[a].updated) + '</td></tr>';
    }
    html += '</table>';
  }
  if (missing.length) {
    html += '<p><strong>Not attached — never generated for ' + esc(monthLabel) + ':</strong></p><ul>';
    for (var b = 0; b < missing.length; b++) {
      html += '<li>' + esc(missing[b].label) + ' <span style="color:#666">(' + esc(missing[b].where) + ')</span></li>';
    }
    html += '</ul><p>' + esc(howTo) + '</p>';
  }

  var plain = intro + '\n\n';
  if (found.length) {
    plain += caveat + '\n\n';
    for (var c = 0; c < found.length; c++) {
      plain += '  ' + found[c].label + '\n' +
        '    File     : ' + found[c].file + '\n' +
        '    Generated: ' + found[c].updated + '\n';
    }
    plain += '\n';
  }
  if (missing.length) {
    plain += 'Not attached — never generated for ' + monthLabel + ':\n';
    for (var d = 0; d < missing.length; d++) {
      plain += '  - ' + missing[d].label + ' (' + missing[d].where + ')\n';
    }
    plain += '\n' + howTo + '\n';
  }

  MailApp.sendEmail({
    to: CONSULTANT_REPORT_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Consultant report email for ' + monthLabel + ' sent to ' + CONSULTANT_REPORT_EMAIL +
    ' — ' + found.length + ' attached, ' + missing.length + ' missing.');
}

// One-off, run once from this editor (function dropdown -> restorePayrollDocsPf202526
// -> Run), same as organiseDriveByYear/migrateAttendanceToFY. Not called by the web app.
//
// The FY 2025-26 migration-safety bug (see index.html's payrollDocsMergeFromValues_)
// overwrote payroll_docs:2025-26:<month> for April-December, February and March with
// a stale leftover snapshot, wiping every PF/ESI/Professional Tax/Wages/Payslip record
// added since. The underlying PDFs were never touched — every one of them is still
// exactly where HR uploaded it in Drive (HR Management/<year>/Office Documents/Payroll
// Documents/<Month>/<Category>/, though some months' files ended up filed under the
// 2026-27 year folder instead of 2025-26 by the app's own date-based filing — that's a
// separate, pre-existing quirk, not something this script needs to fix). Only each
// month's tracker record pointing at its files was lost.
//
// This restores all of it: for every (month, docType) pair below, if no active record
// of that type already exists, it adds one pointing at the file already in Drive. It
// only ever adds a record — it never removes or overwrites anything already in a
// month's key — so it's safe to run more than once and safe to run even if some records
// already came back through the app's own "Link existing file" flow. March's ESI
// Challan is the one exception: no such file turned up anywhere in Drive under any
// naming pattern searched, so it genuinely isn't here — if HR finds it, it needs linking
// separately.
function restorePayrollDocsPf202526() {
  var FY = '2025-26';
  var MONTH_LABELS = { 1:'January', 2:'February', 3:'March', 4:'April', 5:'May', 6:'June',
    7:'July', 8:'August', 9:'September', 10:'October', 11:'November', 12:'December' };
  // (month, category, docType) -> the Drive file already holding that document, found by
  // searching Drive for every "<FY>_<Month>_<DocType>_RS-Infotech_<hash>.<ext>" file this
  // year and taking the most recently created one per slot, in case of retry duplicates.
  var RECORDS = [
    { month: 2, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1mneVTCBQ2fN12ZV0VOmqWn0ApzoN7Sn0", docDate: "2026-02-01" },
    { month: 2, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1o-q9-XEu76jtTw1epbsJRtM27nJOFVYw", docDate: "2026-02-01" },
    { month: 2, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1DzEx8mfperluOUODUD4C-sR_-8O0tPVf", docDate: "2026-02-01" },
    { month: 2, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1LMgUlAlSqcKPnwKtaC57XsGFP25U0Jqq", docDate: "2026-02-01" },
    { month: 2, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1Fh_QIM84nWpnAwIJDoUgoqSO1qIQozaF", docDate: "2026-02-01" },
    { month: 2, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "16VgNqN8c_xVmhkJse8NTrUm-lXFfXWkt", docDate: "2026-02-01" },
    { month: 2, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1aq8O73s2pLm6zW9Jrj_5XBhVT25dcPB-", docDate: "2026-02-01" },
    { month: 2, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "11HqVYnIAd0iFJHv5QM-UXtCYEQvrWfBV", docDate: "2026-02-01" },
    { month: 2, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1rht9be4H8c8v63qS5bi2WPPvEFDYfSqV", docDate: "2026-02-01" },
    { month: 3, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1qf9ezXH3940WXZNK4CVZqBmuK0dYC8kk", docDate: "2026-03-01" },
    { month: 3, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1V8vyhqHyErZO0FJn5yHsECH_vImXF0cD", docDate: "2026-03-01" },
    { month: 3, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1HPjJnynENAbBDRkpDtyyLETyf0n4m3va", docDate: "2026-03-01" },
    { month: 3, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1PmWcqBGVztuZ9982dykYCKkRoQ_enHji", docDate: "2026-03-01" },
    { month: 3, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1_Be7IIZp0vTKQrGDb3ELqk9Lr7mBy6M4", docDate: "2026-03-01" },
    { month: 3, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1-xyFISX9iGccUnyyqe-ofKhv_5-dppdk", docDate: "2026-03-01" },
    { month: 3, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1ZwC9fZydOHkjb5IhKmcHMvkt5w93EFJe", docDate: "2026-03-01" },
    { month: 3, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1VqlwxbAW4TIW_zhHsf6f3ICDRUR4UljS", docDate: "2026-03-01" },
    { month: 4, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1qr70UVReg3pkGJq7jhVBb17KMWBV5G6u", docDate: "2025-04-01" },
    { month: 4, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "15MqNSidkAulCvcLeOynBSOqGTfr6vv5c", docDate: "2025-04-01" },
    { month: 4, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "13cYkBQxxm-e0CEddS1ajNDjHOMg6z-jk", docDate: "2025-04-01" },
    { month: 4, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "15nQbnXBfuzW-avhDGW3HjxOdmBcUTyUH", docDate: "2025-04-01" },
    { month: 4, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1D3y8y_TiYV5h7LjEfcjenel1Wvav6WeU", docDate: "2025-04-01" },
    { month: 4, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1KBfqqUsWcgSxGuzCHBmrsQWdYbKY-4ZX", docDate: "2025-04-01" },
    { month: 4, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1vWfU5Xd2rpjprFQDf_fM00xns1BFp6fu", docDate: "2025-04-01" },
    { month: 4, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1W-r7iulGGp5KIRtOFNewG615bsjrMFf2", docDate: "2025-04-01" },
    { month: 4, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "16JZevbBCnThTstUhXoSGRS-nLWayDBRO", docDate: "2025-04-01" },
    { month: 5, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1Rq264PPQIChsyzjFB_AB3hrAgVH46W_S", docDate: "2025-05-01" },
    { month: 5, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1fpskXMhrlYkPScjlMCnjw8sQL1qVEobX", docDate: "2025-05-01" },
    { month: 5, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1VLne4GLXqPwhqLJ_Cn_IeVz_qcUfXey1", docDate: "2025-05-01" },
    { month: 5, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1pVSyi5XBq0cDv1Fc_kXr3vnzT3a2e3LB", docDate: "2025-05-01" },
    { month: 5, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1paL_aknqx6A2aA0VpFTjNVgQx7N-1i16", docDate: "2025-05-01" },
    { month: 5, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "11fUYTrNkAoLM3YvtS-dDfVH_wTOoWEgO", docDate: "2025-05-01" },
    { month: 5, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1dVddITPF70S2UP9cl3uKezOpvV3GH8Qg", docDate: "2025-05-01" },
    { month: 5, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1rLFIyIPNxW-1xC4qy_1fDRz7lErhbCR5", docDate: "2025-05-01" },
    { month: 5, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1EUpllqnPFpZcuvWqxpnbiDybAf28xXum", docDate: "2025-05-01" },
    { month: 6, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "15wYbxQbJg87eCsIpr5j1yymRJdADN7WN", docDate: "2025-06-01" },
    { month: 6, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1a7s5OkZ7ST4EYl1Xy7-Esnub3klwuGAI", docDate: "2025-06-01" },
    { month: 6, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "175XZkTivOtDMTBXHOdE2gsWDnztK3OMP", docDate: "2025-06-01" },
    { month: 6, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1QoG8za2mcQUMTUxMfDB7sEBlSy5xVGnw", docDate: "2025-06-01" },
    { month: 6, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1lmjXhWav24T12DSTlCUKAyM3dxGGs54K", docDate: "2025-06-01" },
    { month: 6, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1b_Xv0Ip2jAZBn2o0srqAJypQ2enM3XMd", docDate: "2025-06-01" },
    { month: 6, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1TrrIwKxuVt6s9WeWYwOhsbpbSH_lxRhW", docDate: "2025-06-01" },
    { month: 6, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1PyyCQL1-HAApMmhGo1WFqtnJwjlxKYVY", docDate: "2025-06-01" },
    { month: 6, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "155GSLMzxS96pbIb3vhxU4u2UNI15FEq8", docDate: "2025-06-01" },
    { month: 7, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1Zei2QEwcSkSk_TgSC5n9NGlreoIZCtWT", docDate: "2025-07-01" },
    { month: 7, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1y4E9vigKImUJBR3Kb7bnhKtGL5hUfEKh", docDate: "2025-07-01" },
    { month: 7, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "18QMUSoFn_BJO1VMRVGotHfzzvbj-ikb9", docDate: "2025-07-01" },
    { month: 7, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1urma70yGoNz4aHp9mJW9Q9FKoov2uLUD", docDate: "2025-07-01" },
    { month: 7, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1vQZoH40tlvGJw0ojddHWISFL7PfLk8lD", docDate: "2025-07-01" },
    { month: 7, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1XT3lmAik7bNxyPYfcXt6i_-P37w4YWka", docDate: "2025-07-01" },
    { month: 7, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1vgqcMiurbPJJxmnGgVmqrH6CJGXNOS3M", docDate: "2025-07-01" },
    { month: 7, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1dV7Xxlw_OSTcmceNZILmS7gqjrY3-im4", docDate: "2025-07-01" },
    { month: 7, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1KifPYjTUrO2XL4cpY5dM_RDKI73ceUPJ", docDate: "2025-07-01" },
    { month: 8, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1uqTYY8MQ0OGaGI7xozBhfwWHmFsSfxQS", docDate: "2025-08-01" },
    { month: 8, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1gY1ay-_zsPFbr9j0_cW_N_1INzi7BxA1", docDate: "2025-08-01" },
    { month: 8, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1QTTAmiJ1rLX3KY_fxRpFAFBL5iLYNNBm", docDate: "2025-08-01" },
    { month: 8, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "13_NaLmoAhs1GTtKXB2eEpeUkuRtQ7QLi", docDate: "2025-08-01" },
    { month: 8, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1o-baR_8gBjdLwtRnvp-Rud_cPfUH7TsF", docDate: "2025-08-01" },
    { month: 8, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1ori7Ns3_JydoEWCqRoUIfh55-D2Sm8EI", docDate: "2025-08-01" },
    { month: 8, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1pkyzFjn_nZhQ0u-Gl2kEwe4CFc-Lf8Q4", docDate: "2025-08-01" },
    { month: 8, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1wcOpUZF1YKImk5S194Hb9sMFpIUv2YC9", docDate: "2025-08-01" },
    { month: 8, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1Vi7mV1GLROq45GC-M8F4voxl95RGtoRN", docDate: "2025-08-01" },
    { month: 9, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1fTYCVmFWqycp-4sb2_QWTHWfLaNgkd7G", docDate: "2025-09-01" },
    { month: 9, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "17IeM0FpODvVYB4P7mdW8pMZO0GiPJOB5", docDate: "2025-09-01" },
    { month: 9, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1kuzIP4yjAqZy8F1B9WCiQnxC7brk2uP8", docDate: "2025-09-01" },
    { month: 9, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1mov1yKzcpRY5cxgqsJApNjNRuDZh5nwf", docDate: "2025-09-01" },
    { month: 9, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "19Z9-e-yMDLWnxuUzYY8A5KjXaG6Y49kI", docDate: "2025-09-01" },
    { month: 9, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1SSzenWlC-M-Tvf0OFhbdnL5XGa15LDaE", docDate: "2025-09-01" },
    { month: 9, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1vQRrh9UGIA_ugz5R7gCkaBzFR01iNXGS", docDate: "2025-09-01" },
    { month: 9, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1L7CTjjTHCylCjM_uTikUhDfmG6gOGmN7", docDate: "2025-09-01" },
    { month: 9, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1eLmgUav4omGetEC-jlzoUJye5y8naZq6", docDate: "2025-09-01" },
    { month: 10, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1Timm62edNAtOcstcUk50M9XE_THNGRBj", docDate: "2025-10-01" },
    { month: 10, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "15JZH2FOHo3f5tdOZLWvFc8j8tNG8DrBv", docDate: "2025-10-01" },
    { month: 10, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1vMsmaQIP-qjW3g0XBc-JdG_WBUllyvDm", docDate: "2025-10-01" },
    { month: 10, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1KAlXlNe4YCrTFY2Cgch_nyu74FCXmepo", docDate: "2025-10-01" },
    { month: 10, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1POKbW9dlg1kB4cxeUBD23a4ij9uJI6jR", docDate: "2025-10-01" },
    { month: 10, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1rFrh7vpLBY3FsGViGKbhREIbtERZhS8q", docDate: "2025-10-01" },
    { month: 10, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1QcUKVfPNSTUgxzMax3elt1c6pX2G0u5C", docDate: "2025-10-01" },
    { month: 10, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1rraK6z-xhErgFi0Ob61iQ7j_mwqxgdzK", docDate: "2025-10-01" },
    { month: 10, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1GjlK_cBFvnWfbx5XOhG4oaz_gt3Hj2Og", docDate: "2025-10-01" },
    { month: 11, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "1znGaMltQuPa898eVALBhFwr-BjB9HFFS", docDate: "2025-11-01" },
    { month: 11, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1j5qkuiPFQ6-6HwYMljJzc4jBCam5C80F", docDate: "2025-11-01" },
    { month: 11, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1UJDwHgBt9jNWNY1NrwcMkxnxpjOFJHr7", docDate: "2025-11-01" },
    { month: 11, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1PSYyEv8fn-CgB0HfPj_lkD0LdiSpzLAc", docDate: "2025-11-01" },
    { month: 11, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1Xui1YvOl4aUWAFQPzFahSC6fHBimXOLT", docDate: "2025-11-01" },
    { month: 11, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "1TknkAyqLez5V8MP4sMZ0h-KnNfAgUa7r", docDate: "2025-11-01" },
    { month: 11, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1pwHTvHuD_rM_C7PsvEW7B8kpb8j0efOP", docDate: "2025-11-01" },
    { month: 11, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1eKN6WK6oKD_mvhuW_-wWhtoDGTMEypbf", docDate: "2025-11-01" },
    { month: 11, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "16fwGG-Y14douoyo4KXDTi3L4pdMp_OmR", docDate: "2025-11-01" },
    { month: 12, category: "esi", docType: "esiChallan", docTypeLabel: "ESI Challan", fileId: "11g7u7izaFvdWPovPmTTd3f757Se5usrl", docDate: "2025-12-01" },
    { month: 12, category: "esi", docType: "esiReceipt", docTypeLabel: "ESI Payment Receipt", fileId: "1c9bEYrwppyJ-nt8Ses35-llLN9Gzc2Ev", docDate: "2025-12-01" },
    { month: 12, category: "payslip", docType: "payslip", docTypeLabel: "Payslip", fileId: "1G1Sx4nIbupIKzq6-q33MYsEI8KLuSwkJ", docDate: "2025-12-01" },
    { month: 12, category: "pf", docType: "pfChallan", docTypeLabel: "PF Challan", fileId: "1BvkwqckHHeGcBRNIW_kk6B1IBeeKwpWP", docDate: "2025-12-01" },
    { month: 12, category: "pf", docType: "pfEcr", docTypeLabel: "PF ECR", fileId: "1xtoPbyWLQpFLYfhRfu01u-vaFBASD44H", docDate: "2025-12-01" },
    { month: 12, category: "pf", docType: "pfReceipt", docTypeLabel: "PF Payment Receipt", fileId: "10mF2d1MMQmtNgK-Grfmi4hgCAH45Oq_Y", docDate: "2025-12-01" },
    { month: 12, category: "pt", docType: "ptChallan", docTypeLabel: "Professional Tax Challan", fileId: "1PTmYAALxyKdjGlbE8G2fDJ0h_oy9XAXT", docDate: "2025-12-01" },
    { month: 12, category: "pt", docType: "ptReceipt", docTypeLabel: "Professional Tax Payment Receipt", fileId: "1abcWpfEdlGwwRzrcL0_Dp3Nx_ehWPqIv", docDate: "2025-12-01" },
    { month: 12, category: "wages", docType: "wagesRegister", docTypeLabel: "Wages Register", fileId: "1fJyXM3KQU_NqxpDeVPQ2QqMD_scxhu7S", docDate: "2025-12-01" },
  ];

  var sheet = getSheet_();
  var now = new Date().toISOString();
  var summary = [];

  var byMonth = {};
  RECORDS.forEach(function (r) { (byMonth[r.month] = byMonth[r.month] || []).push(r); });

  Object.keys(byMonth).forEach(function (monthStr) {
    var month = Number(monthStr);
    var key = 'payroll_docs:' + FY + ':' + month;
    var row = findRow_(sheet, key);
    var raw = row > 0 ? sheet.getRange(row, 2).getValue() : null;

    var records = [];
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.records) ? parsed.records : []);
      } catch (e) { records = []; }
    }

    var added = [], skipped = [];
    byMonth[month].forEach(function (r) {
      var alreadyThere = records.some(function (rec) {
        return rec && rec.status === 'active' && rec.category === r.category && rec.docType === r.docType;
      });
      if (alreadyThere) { skipped.push(r.docTypeLabel); return; }
      var url = 'https://drive.google.com/file/d/' + r.fileId + '/view?usp=drivesdk';
      records.unshift({
        id: Utilities.getUuid().slice(0, 6),
        fy: FY, month: month, monthLabel: MONTH_LABELS[month],
        category: r.category, docType: r.docType, docTypeLabel: r.docTypeLabel,
        docName: r.docTypeLabel, docDate: r.docDate, remarks: '',
        fileName: r.docTypeLabel, url: url, uploadedBy: 'HR', uploadedAt: now, status: 'active',
        history: [{ action: 'upload', at: now, by: 'HR',
          note: 'Restored — relinked to the existing Drive file after the migration-safety bug wiped this record' }],
      });
      added.push(r.docTypeLabel);
    });

    if (added.length) {
      var value = JSON.stringify({ savedAt: Date.now(), records: records });
      if (row > 0) { sheet.getRange(row, 2).setValue(value); } else { sheet.appendRow([key, value]); }
    }
    summary.push(MONTH_LABELS[month] + ': restored [' + added.join(', ') + ']' +
      (skipped.length ? '; already had [' + skipped.join(', ') + ']' : ''));
  });

  Logger.log(summary.join('\n'));
}


// ===== Send every email now, for testing =====
//
// Run this from the editor's function dropdown to receive all seven emails
// immediately, whatever today's date is.
//
// It exists because the Run button calls a function with NO arguments. Picking
// sendMonthlyReportsEmail from the dropdown therefore passes force = undefined,
// its date check sees a day that is not the 1st, and it returns silently having
// sent nothing — which looks exactly like a broken email. There is nowhere in
// that UI to type the argument, so a wrapper that passes it is the only way to
// test these by hand.
//
// The dated emails send the month they would normally send: on any day in
// September that is August, because they always report the month just gone.
// The birthday email is the one that can still legitimately send nothing — it
// has nothing to force, and only writes when somebody's birthday really is
// tomorrow.
//
// This sends real email to the real address. It is a test entry point, never
// something to put on a trigger.
function sendAllEmailsNow() {
  var results = [];
  var run = function (label, fn) {
    try {
      fn();
      results.push('  OK      ' + label);
    } catch (err) {
      // One failure must not stop the rest — the point of running this is to
      // find out which of the seven work, not to stop at the first that does not.
      results.push('  FAILED  ' + label + ' — ' + (err && err.message ? err.message : err));
    }
  };

  run('Daily HR Digest', function () { sendDailyDigestEmail(); });
  run('Increments due next month', function () { sendIncrementReminderEmail(true); });
  run('Birthday reminder (sends only if a birthday is tomorrow)', function () { sendBirthdayReminderEmail(); });
  run('Monthly report pack', function () { sendMonthlyReportsEmail(true); });
  run('Loan & Advance Report', function () { sendLoanAdvanceReportEmail(true); });
  run('Monthly Leave Detail Report', function () { sendLeaveDetailReportEmail(true); });
  run('Consultant Report', function () { sendConsultantReportEmail(true); });
  run('Salary advance alert (normally silent unless one was recorded)',
    function () { sendSalaryAdvanceAlertEmail(true); });
  run('Salary advances for the month', function () { sendMonthlyAdvanceSummaryEmail(true); });

  Logger.log('Sent every email now to ' + DAILY_DIGEST_EMAIL + ':\n' + results.join('\n'));
}

// Prints which of the seven scheduled emails actually have a trigger installed.
// The Triggers page in the sidebar says the same thing, but this reads the list
// against the seven expected handlers and names any that are missing, which the
// page cannot do.
function listReminderTriggers() {
  var expected = [
    ['sendDailyDigestEmail', 'Daily HR Digest — every day'],
    ['sendIncrementReminderEmail', 'Increments due next month — 30th'],
    ['sendBirthdayReminderEmail', 'Birthday reminder — day before'],
    ['sendMonthlyReportsEmail', 'Report pack — 1st'],
    ['sendLoanAdvanceReportEmail', 'Loan & Advance Report — 1st'],
    ['sendLeaveDetailReportEmail', 'Monthly Leave Detail Report — 1st'],
    ['sendConsultantReportEmail', 'Consultant Report — 2nd'],
    ['sendSalaryAdvanceAlertEmail', 'Salary advance taken — same evening'],
    ['sendMonthlyAdvanceSummaryEmail', 'Salary advances for the month — last day']
  ];
  var installed = {};
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    installed[fn] = (installed[fn] || 0) + 1;
  }
  var lines = [], missing = 0;
  for (var e = 0; e < expected.length; e++) {
    var name = expected[e][0];
    var count = installed[name] || 0;
    if (!count) missing++;
    lines.push('  ' + (count ? 'INSTALLED' : 'MISSING  ') + '  ' + expected[e][1] +
      '  (' + name + ')' + (count > 1 ? '  — ' + count + ' copies, run its remove trigger then its create trigger' : ''));
  }
  // Anything on a trigger that is not one of the seven is worth seeing too —
  // a hand-made trigger from the Add Trigger button would show up here.
  for (var k in installed) {
    var known = false;
    for (var x = 0; x < expected.length; x++) if (expected[x][0] === k) known = true;
    if (!known) lines.push('  OTHER      ' + k + '  (not one of the seven — added by hand?)');
  }
  Logger.log('Scheduled email triggers — ' + (expected.length - missing) + ' of ' + expected.length +
    ' installed' + (missing ? ', ' + missing + ' MISSING' : '') + ':\n' + lines.join('\n'));
}

// ===== Salary advance taken today, emailed the same evening =====
//
// Money left the company today and payroll will recover it later. This says so
// on the day, while it can still be questioned, instead of it surfacing weeks
// later as a deduction on a salary sheet.
//
// It reads emp.advanceHistory, whose entries index.html now stamps with
// `addedOn` — the day the figure was keyed in. That stamp had to be added for
// this to be possible at all: an advance entry carries `month`, which is the
// payroll month the money is recovered FROM and is routinely not today, so
// before the stamp nothing on the record said when an advance was actually
// taken. Both ways of recording one — the Dashboard shortcut and the employee's
// own record — set it, and collectAdvanceRows carries it through a later save.
//
// Entries made before the stamp existed simply never match today's date, so
// there is nothing to migrate and no risk of old advances being announced as
// new ones.
//
// Unlike the monthly report emails, this one stays SILENT when there is nothing
// to report. Those are reports whose absence would hide a problem; this is an
// alert about an event that most days does not happen, and a daily "no advances
// today" would train whoever reads it to stop looking. Silence here means
// nobody took an advance.
var SALARY_ADVANCE_ALERT_EMAIL = 'rasesh@rsinfotech.net';
var SALARY_ADVANCE_ALERT_HOUR = 20; // 8 PM IST, an hour before the daily digest

function createSalaryAdvanceAlertTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendSalaryAdvanceAlertEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendSalaryAdvanceAlertEmail')
    .timeBased()
    .everyDays(1)
    .atHour(SALARY_ADVANCE_ALERT_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Salary advance alert trigger created — sendSalaryAdvanceAlertEmail now runs daily around ' +
    SALARY_ADVANCE_ALERT_HOUR + ':00 IST and emails only on a day an advance was recorded.');
}

// Undoes createSalaryAdvanceAlertTrigger — stops this alert without touching
// any of the others.
function removeSalaryAdvanceAlertTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendSalaryAdvanceAlertEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' salary advance alert trigger(s).');
}

// Whole rupees, grouped the Indian way — 1,50,000 not 150,000. Every amount in
// this project is whole rupees with no paise, so this rounds rather than
// pretending to a precision the rest of the app does not carry.
function rupeesIn_(n) {
  var v = Math.round(Number(n) || 0);
  var neg = v < 0;
  var s = String(Math.abs(v));
  var last3 = s.length > 3 ? s.slice(-3) : s;
  var rest = s.length > 3 ? s.slice(0, -3) : '';
  if (rest) last3 = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  return (neg ? '-₹' : '₹') + last3;
}

// force=true sends even when nothing was recorded, so a test run visibly
// produces an email rather than looking like a failure.
function sendSalaryAdvanceAlertEmail(force) {
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var rows = getSheet_().getDataRange().getValues();
  var employees = allEmployeesFromRows_(rows);

  var taken = [];
  employees.forEach(function (e) {
    if (!e) return;
    var hist = e.advanceHistory;
    if (!hist || !hist.length) return;
    hist.forEach(function (h) {
      if (!h || h.addedOn !== today) return;
      var amount = Number(h.advance) || 0;
      if (amount <= 0) return;
      taken.push({
        name: e.name || e.id,
        id: e.id || '',
        designation: e.designation || '',
        amount: amount,
        // A month is required for the advance ever to be recovered, so an entry
        // saved without one is a mistake worth showing rather than hiding.
        month: h.month || '',
        left: e.employmentStatus === 'left'
      });
    });
  });

  if (!taken.length && !force) {
    Logger.log('Salary advance alert — nothing recorded on ' + today + ', no email sent.');
    return;
  }

  taken.sort(function (a, b) { return b.amount - a.amount; });
  var total = 0;
  taken.forEach(function (t) { total += t.amount; });

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var dateDisp = today.slice(8, 10) + '/' + today.slice(5, 7) + '/' + today.slice(0, 4);
  var monthDisp = function (ym) {
    if (!ym) return 'no month set';
    var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    return LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  };

  var subject, html, plain;
  if (!taken.length) {
    subject = 'R.S. Infotech — No salary advance recorded — ' + dateDisp;
    var none = 'No salary advance was recorded on ' + dateDisp + '.';
    var quiet = 'On an ordinary day this email is not sent at all — it only goes out when ' +
      'an advance is recorded. You are seeing it because it was run by hand.';
    html = '<p>' + esc(none) + '</p><p>' + esc(quiet) + '</p>';
    plain = none + '\n\n' + quiet + '\n';
  } else {
    subject = 'R.S. Infotech — Salary advance ' + dateDisp + ' — ' + rupeesIn_(total) +
      (taken.length === 1 ? ' to ' + taken[0].name : ' to ' + taken.length + ' people');
    var lead = taken.length === 1
      ? 'One salary advance was recorded today, ' + dateDisp + '.'
      : taken.length + ' salary advances were recorded today, ' + dateDisp +
        ', totalling ' + rupeesIn_(total) + '.';
    // Said plainly because the two dates in this email mean different things and
    // are routinely different months.
    var note = 'Recovered from the payroll month shown against each — that is the month the ' +
      'deduction appears on, not today. Nothing is deducted until that month’s Salary Sheet runs.';

    html = '<p style="font-size:15px;"><strong>' + esc(lead) + '</strong></p><p>' + esc(note) + '</p>' +
      '<table cellpadding="7" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><th align="left">Employee</th><th align="left">Amount</th><th align="left">Recovered from</th></tr>';
    plain = lead + '\n\n' + note + '\n\n';
    taken.forEach(function (t) {
      var who = t.name + (t.designation ? ' (' + t.designation + ')' : '') +
        (t.left ? ' — MARKED AS LEFT' : '');
      html += '<tr><td>' + esc(who) + '</td><td align="right"><strong>' + esc(rupeesIn_(t.amount)) +
        '</strong></td><td>' + esc(monthDisp(t.month)) + '</td></tr>';
      plain += '  ' + who + '\n' +
        '    Amount        : ' + rupeesIn_(t.amount) + '\n' +
        '    Recovered from: ' + monthDisp(t.month) + '\n';
    });
    if (taken.length > 1) {
      html += '<tr><td><strong>Total</strong></td><td align="right"><strong>' + esc(rupeesIn_(total)) +
        '</strong></td><td></td></tr>';
      plain += '\n  Total: ' + rupeesIn_(total) + '\n';
    }
    html += '</table>';
    var anyNoMonth = taken.some(function (t) { return !t.month; });
    if (anyNoMonth) {
      var warn = 'One or more entries have no payroll month set, so nothing will be recovered for them ' +
        'until a month is chosen on the employee’s record.';
      html += '<p style="color:#B00020;"><strong>' + esc(warn) + '</strong></p>';
      plain += '\n' + warn + '\n';
    }
  }

  MailApp.sendEmail({
    to: SALARY_ADVANCE_ALERT_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html
  });
  Logger.log('Salary advance alert for ' + dateDisp + ' sent to ' + SALARY_ADVANCE_ALERT_EMAIL +
    ' — ' + taken.length + ' advance(s), ' + rupeesIn_(total) + '.');
}

// ===== Every salary advance of the month, on the month's last day =====
//
// The month-end companion to the same-evening alert above: one email listing
// every advance of the month with the name, the amount and a total.
//
// It reports the month that is ENDING, not the previous one. Every other
// monthly email here runs on the 1st or 2nd and looks back a month; this one
// runs on the last day, so "this month" is the month it is about. Getting that
// backwards would report a month already covered and miss the one just closed.
//
// Two sections, because an advance has two months attached and they are
// routinely different: one is entered in August and recovered from September or
// October. Only showing one grouping would be misleading whichever was chosen —
// "what did we pay out this month" and "what comes off this month's payroll"
// are both real questions, and neither answers the other.
//
//   Paid out this month   — entries stamped addedOn within the month. This is
//                           the roll-up of the daily alerts: cash that left.
//   Recovered this month  — entries whose `month` is this month. This is what
//                           the Salary Sheet actually deducts.
//
// One caveat that matters for the first few months: `addedOn` only started
// being recorded when the same-evening alert was added, so "Paid out this
// month" is complete only from that point on. "Recovered this month" reads
// `month`, which has always been stored, so it is correct for any month
// including past ones. The email says so itself when it finds undated entries.
//
// Unlike the daily alert, this always sends, even with nothing to report. That
// alert is about an event most days do not have, where a daily "nothing today"
// would train the reader to stop looking. This is a month-end report, and "no
// advances were paid this month" is a fact worth confirming.
var ADVANCE_SUMMARY_EMAIL = 'rasesh@rsinfotech.net';
var ADVANCE_SUMMARY_HOUR = 20; // 8 PM IST on the last day of the month

function createAdvanceSummaryTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendMonthlyAdvanceSummaryEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendMonthlyAdvanceSummaryEmail')
    .timeBased()
    .everyDays(1)
    .atHour(ADVANCE_SUMMARY_HOUR)
    .inTimezone('Asia/Kolkata')
    .create();
  Logger.log('Monthly advance summary trigger created — sendMonthlyAdvanceSummaryEmail now runs daily ' +
    'around ' + ADVANCE_SUMMARY_HOUR + ':00 IST and emails only on the last day of the month.');
}

// Undoes createAdvanceSummaryTrigger — stops this summary without touching the
// same-evening alert or anything else.
function removeAdvanceSummaryTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendMonthlyAdvanceSummaryEmail') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' monthly advance summary trigger(s).');
}

// True on the final day of whatever month it is — 28, 29, 30 or 31 as the month
// and the leap year decide. new Date(y, m, 0) is the last day of month m, m
// being 1-based here.
function isLastDayOfMonth_(y, m, d) {
  return d === new Date(y, m, 0).getDate();
}

// force=true sends regardless of the date, for testing from the editor.
function sendMonthlyAdvanceSummaryEmail(force) {
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(today.slice(8, 10));
  if (!force && !isLastDayOfMonth_(y, m, d)) return;

  var ym = today.slice(0, 7);
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var rows = getSheet_().getDataRange().getValues();
  var employees = allEmployeesFromRows_(rows);

  var paidOut = [], recovered = [], undatedInMonth = 0;
  employees.forEach(function (e) {
    if (!e || !e.advanceHistory || !e.advanceHistory.length) return;
    e.advanceHistory.forEach(function (h) {
      if (!h) return;
      var amount = Number(h.advance) || 0;
      if (amount <= 0) return;
      var who = {
        name: e.name || e.id,
        designation: e.designation || '',
        amount: amount,
        month: h.month || '',
        addedOn: h.addedOn || '',
        left: e.employmentStatus === 'left'
      };
      if (h.addedOn && String(h.addedOn).slice(0, 7) === ym) paidOut.push(who);
      if (h.month === ym) {
        recovered.push(who);
        // An entry recovered this month that carries no addedOn predates the
        // stamp — worth counting so the email can say why the two sections may
        // not line up, rather than leaving it looking like a discrepancy.
        if (!h.addedOn) undatedInMonth++;
      }
    });
  });

  var byAmount = function (a, b) { return b.amount - a.amount; };
  paidOut.sort(byAmount);
  recovered.sort(byAmount);
  var sum = function (list) {
    var t = 0;
    list.forEach(function (x) { t += x.amount; });
    return t;
  };
  var paidTotal = sum(paidOut), recoveredTotal = sum(recovered);

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var monthDisp = function (v) {
    if (!v) return 'no month set';
    return LEAVE_DETAIL_MONTH_NAMES[Number(v.slice(5, 7)) - 1] + ' ' + Number(v.slice(0, 4));
  };
  var dayDisp = function (v) {
    return v ? v.slice(8, 10) + '/' + v.slice(5, 7) + '/' + v.slice(0, 4) : 'not recorded';
  };

  var heading = function (text) {
    return '<h3 style="margin:22px 0 8px;font-family:Arial,sans-serif;font-size:19px;font-weight:bold;' +
      'color:#16213E;border-bottom:1px solid #E3E6EC;padding-bottom:5px;">' + esc(text) + '</h3>';
  };
  var plainHeading = function (text) {
    return '\n' + text.toUpperCase() + '\n' + new Array(text.length + 1).join('-') + '\n';
  };

  // Each section names the column that is NOT its own grouping — the paid-out
  // list shows which month each will be recovered from, the recovered list
  // shows the day each was taken — so a figure can be traced from either side.
  var section = function (title, list, total, otherLabel, otherOf, emptyText) {
    var h = heading(title + ' (' + list.length + ')');
    var p = plainHeading(title + ' (' + list.length + ')');
    if (!list.length) {
      return { html: h + '<p style="margin:0 0 16px;color:#5A6270;">' + esc(emptyText) + '</p>',
               plain: p + emptyText + '\n' };
    }
    h += '<table cellpadding="7" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;margin:0 0 8px;">' +
      '<tr><th align="left">Employee</th><th align="left">Amount</th><th align="left">' +
      esc(otherLabel) + '</th></tr>';
    list.forEach(function (x) {
      var who = x.name + (x.designation ? ' (' + x.designation + ')' : '') +
        (x.left ? ' — MARKED AS LEFT' : '');
      h += '<tr><td>' + esc(who) + '</td><td align="right"><strong>' + esc(rupeesIn_(x.amount)) +
        '</strong></td><td>' + esc(otherOf(x)) + '</td></tr>';
      p += '  ' + who + '\n    Amount: ' + rupeesIn_(x.amount) +
        '\n    ' + otherLabel + ': ' + otherOf(x) + '\n';
    });
    h += '<tr><td><strong>Total</strong></td><td align="right"><strong>' + esc(rupeesIn_(total)) +
      '</strong></td><td></td></tr></table>';
    p += '\n  Total: ' + rupeesIn_(total) + '\n';
    return { html: h, plain: p };
  };

  var paidSection = section('Paid out in ' + monthLabel, paidOut, paidTotal,
    'Recovered from', function (x) { return monthDisp(x.month); },
    'No salary advance was paid out this month.');
  var recSection = section('Recovered from ' + monthLabel + ' payroll', recovered, recoveredTotal,
    'Taken on', function (x) { return dayDisp(x.addedOn); },
    'Nothing is being recovered from this month’s payroll.');

  var subject = 'R.S. Infotech — Salary advances ' + monthLabel + ' — ' +
    rupeesIn_(paidTotal) + ' paid out, ' + rupeesIn_(recoveredTotal) + ' recovered';

  var intro = 'Every salary advance on record for ' + monthLabel + '.';
  var note = 'The same advance appears in both lists only when it was taken and recovered in the ' +
    'same month. One entered this month for a later month’s payroll appears above but not below.';

  var html = '<div style="font-family:Arial,sans-serif;color:#16213E;font-size:14px;line-height:1.6;">' +
    '<h2 style="margin:0 0 4px;font-size:23px;font-weight:bold;color:#16213E;">' +
    'R.S. Infotech — Salary advances</h2>' +
    '<p style="margin:0 0 18px;color:#5A6270;">' + esc(monthLabel) + '</p>' +
    '<p>' + esc(intro) + '</p><p>' + esc(note) + '</p>' +
    paidSection.html + recSection.html;
  var plain = 'R.S. Infotech — Salary advances — ' + monthLabel + '\n\n' + intro + '\n\n' + note + '\n' +
    paidSection.plain + recSection.plain;

  if (undatedInMonth) {
    var why = undatedInMonth + ' of the entries recovered this month were recorded before the app ' +
      'started stamping the day an advance is taken, so they cannot appear in the paid-out list above. ' +
      'That is expected for older entries and resolves itself as new advances are recorded.';
    html += '<p style="margin:16px 0 0;font-size:12px;color:#5A6270;">' + esc(why) + '</p>';
    plain += '\n' + why + '\n';
  }
  html += '</div>';

  MailApp.sendEmail({
    to: ADVANCE_SUMMARY_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html
  });
  Logger.log('Monthly advance summary for ' + monthLabel + ' sent to ' + ADVANCE_SUMMARY_EMAIL +
    ' — ' + paidOut.length + ' paid out (' + rupeesIn_(paidTotal) + '), ' +
    recovered.length + ' recovered (' + rupeesIn_(recoveredTotal) + ').');
}
