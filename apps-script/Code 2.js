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

  var html =
    '<div style="font-family:Arial,sans-serif;color:#16213E;font-size:14px;line-height:1.6;">' +
    '<h2 style="margin:0 0 4px;">R.S. Infotech — Daily HR Digest</h2>' +
    '<p style="margin:0 0 18px;color:#5A6270;">' + esc(niceDate) + '</p>' +
    '<h3 style="margin:0 0 6px;">Absent today (' + absent.length + ' of ' + active.length + ')</h3>' +
    '<p style="margin:0 0 16px;">' + listOrNone(absent) + '</p>' +
    (notMarked.length
      ? '<h3 style="margin:0 0 6px;">Attendance not marked yet (' + notMarked.length + ')</h3>' +
        '<p style="margin:0 0 16px;">' + listOrNone(notMarked) + '</p>'
      : '') +
    '<h3 style="margin:0 0 6px;">Activity log (' + todayLog.length + ')</h3>' +
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

  var plain = 'R.S. Infotech — Daily HR Digest — ' + niceDate + '\n\n' +
    'Absent today (' + absent.length + ' of ' + active.length + '): ' + listOrNone(absent) + '\n\n' +
    (notMarked.length ? 'Attendance not marked yet (' + notMarked.length + '): ' + listOrNone(notMarked) + '\n\n' : '') +
    'Activity log (' + todayLog.length + '):\n' +
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

// One-off, run once from this editor (function dropdown -> restorePayrollDocsPf202526
// -> Run), same as organiseDriveByYear/migrateAttendanceToFY. Not called by the web app.
//
// The FY 2025-26 migration-safety bug (see index.html's payrollDocsMergeFromValues_)
// overwrote payroll_docs:2025-26:<month> for April-December, February and March with
// a stale leftover snapshot, wiping whatever PF/ESI/PT/Wages/Payslip records had been
// added since. The underlying PF Challan PDFs themselves were never touched — they are
// still exactly where HR uploaded them, in HR Management/2025-26/Office Documents/
// Payroll Documents/PF Challan/ — only the tracker's pointer to each one was lost.
//
// This restores just that: for each month below, if no active PF Challan record exists
// yet, it adds one pointing at the file already in Drive. It only ever adds a record —
// it never removes or overwrites anything already in a month's key, so it's safe to
// run more than once and safe to run even if some months already have their PF Challan
// (or other) records back through the app's own "Link existing file" flow. ESI, PT,
// Wages and Payslip aren't touched here because no files for them turned up in Drive
// under this year's Payroll Documents folder — if HR remembers uploading any of those
// for 2025-26, they need to be found and linked separately; this script can't recover
// what it can't find.
function restorePayrollDocsPf202526() {
  var FY = '2025-26';
  // month -> [Drive file ID, calendar-month docDate] — found under HR Management/
  // 2025-26/Office Documents/Payroll Documents/PF Challan/ by title "PF Challan - <date>".
  // January (month 1) is deliberately left out — its record survived the bug untouched.
  var MONTH_FILES = {
    4:  ['16BRfznwbKVGaKYAhOjNZlxaqGx5aFQi7', '2025-04-01'],
    5:  ['1Zw3iWKLTlQjzVHpl3kFKSaNVmM5lXLRG', '2025-05-01'],
    6:  ['1qMk3wx-bxOw-4OY2VR8KMtJdRfeZhxai', '2025-06-01'],
    7:  ['1rYG5XxOcj4c6Jjdjd6loGvGo4zTwtUPW', '2025-07-01'],
    8:  ['1uGqdqm_YjzrAcRMc-g55Fe3QeUr58KP-', '2025-08-01'],
    9:  ['1WZ9f1w-JScJeUCOuTZl5JyCjah4BQwn9', '2025-09-01'],
    10: ['128n-h7DgAB5Ew1rpSS6jsY4J163jDZrt', '2025-10-01'],
    11: ['1ZYg2zKa32cwgF_dqxu7IaDVNQAl3Glwm', '2025-11-01'],
    12: ['1AotdiXPFOqTFMIrYycakH6qHarm2weNf', '2025-12-01'],
    2:  ['1a3caBsnAoD1cA53YNiN2YR3QftZy345F', '2026-02-01'],
    3:  ['1EZmEBQ6yJUBXfvNHoyeURlx2U8Z_lqMu', '2026-03-01'],
  };
  var MONTH_LABELS = { 4:'April', 5:'May', 6:'June', 7:'July', 8:'August', 9:'September',
    10:'October', 11:'November', 12:'December', 2:'February', 3:'March' };

  var sheet = getSheet_();
  var now = new Date().toISOString();
  var summary = [];

  Object.keys(MONTH_FILES).forEach(function (monthStr) {
    var month = Number(monthStr);
    var fileId = MONTH_FILES[month][0];
    var docDate = MONTH_FILES[month][1];
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

    var alreadyThere = records.some(function (r) {
      return r && r.status === 'active' && r.category === 'pf' && r.docType === 'pfChallan';
    });
    if (alreadyThere) {
      summary.push(MONTH_LABELS[month] + ': already has a PF Challan record, left alone.');
      return;
    }

    var url = 'https://drive.google.com/file/d/' + fileId + '/view?usp=drivesdk';
    records.unshift({
      id: Utilities.getUuid().slice(0, 6),
      fy: FY, month: month, monthLabel: MONTH_LABELS[month],
      category: 'pf', docType: 'pfChallan', docTypeLabel: 'PF Challan',
      docName: 'PF Challan', docDate: docDate, remarks: '',
      fileName: 'PF Challan', url: url, uploadedBy: 'HR', uploadedAt: now, status: 'active',
      history: [{ action: 'upload', at: now, by: 'HR',
        note: 'Restored — relinked to the existing Drive file after the migration-safety bug wiped this record' }],
    });

    var value = JSON.stringify({ savedAt: Date.now(), records: records });
    if (row > 0) {
      sheet.getRange(row, 2).setValue(value);
    } else {
      sheet.appendRow([key, value]);
    }
    summary.push(MONTH_LABELS[month] + ': PF Challan record restored.');
  });

  Logger.log(summary.join('\n'));
}
