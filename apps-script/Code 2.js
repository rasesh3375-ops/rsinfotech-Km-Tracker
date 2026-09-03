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

// Reads column A ONLY, not the whole sheet.
//
// This is the hottest function in the backend — every get, every set, every
// delete and the login path all start here, 17 call sites in all — and it used
// to call getDataRange().getValues(), which pulls every cell of every row
// across the wire into script memory. Column B is where the app keeps its JSON:
// an employee record, a year of one person's attendance, the whole payroll
// document tracker, the activity log. A single one of those cells runs to tens
// of thousands of characters, and the sheet holds one per employee per year
// plus the rest. All of it was being fetched and materialised to compare a key
// string in column A, and then thrown away.
//
// Reading one narrow column instead cuts what a save transfers by orders of
// magnitude, and the cost stops growing as the data does — which is why saving
// had been getting slower over time rather than being slow from the start.
//
// The contract is unchanged: 1-based row number, or -1.
function findRow_(sheet, key) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const keys = sheet.getRange(1, 1, lastRow, 1).getValues();
  for (let i = 1; i < keys.length; i++) {
    if (keys[i][0] === key) return i + 1;
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
    sheet.appendRow(['tokenHash', 'role', 'username', 'expiresAt', 'createdAt']);
  }
  return sheet;
}

// The sheet stores only a hash of the token, never the token itself — the
// same reasoning as password storage. Anyone who can read the SESSIONS sheet
// (a Drive share, an HR account compromise) used to get a live bearer token
// good for 30 days; now they get a hash that's useless for calling the API.
// The plaintext token still goes to the client once, at login, same as before.
// Drops rows whose expiry has already passed.
//
// Nothing ever removed them. A row was appended on every login and only ever
// deleted by an explicit logout, so the SESSIONS sheet grew by a row per login
// forever — HR's daily logins plus every engineer's — while validateSession_
// reads the whole sheet and scans it linearly on EVERY request. That is a cost
// every save and every page load pays, and it climbs steadily the longer the
// app is in use, which is exactly the shape of "it used to be quicker".
//
// Only already-expired rows go. validateSession_ rejects those anyway, so
// removing them cannot log anybody out — a live session is never touched.
//
// The kept rows are written back BEFORE the tail is cleared, deliberately. The
// other order leaves a window where a failure mid-way loses every session and
// signs everyone out at once. This order's worst case is stale rows left at the
// bottom, which are expired, harmless, and cleared on the next login.
// How many live sessions one person keeps. Enough for a phone, a tablet and a
// desktop with room to spare; past that they are logins nobody is using.
const MAX_SESSIONS_PER_USER = 5;

function purgeExpiredSessions_(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return 0;
  const now = Date.now();

  // Newest LOGIN first, so capping below keeps the most recent logins and drops
  // the oldest — the ones least likely to be a device anybody is still holding.
  //
  // This used to sort on expiresAt, which ranks logins by recency only while
  // every session has the same lifetime. HR's dropped to 24 hours while
  // engineers' stayed at 30 days, and legacy HR rows written before that change
  // still carry 30-day expiries. So a token created seconds ago expired soonest
  // of the lot, sorted last, and was the FIRST thing this dropped — the purge
  // deleted the session the very login that triggered it had just created, and
  // kept five stale August ones instead. HR was signed out minutes after
  // signing in, repeatedly, and apiFetch retrying a slow login made it worse by
  // running this again for each retry. The diagnosis was six live hr/admin rows
  // against a cap of five, none of them expiring within 24 hours.
  //
  // createdAt is written by createSession_ below. A row from before this
  // existed has none, reads as 0, sorts oldest and is evicted first — which is
  // exactly what should happen to the stale rows that caused this.
  const live = [];
  for (let i = 1; i < data.length; i++) {
    if (Number(data[i][3]) >= now) live.push(data[i]);
  }
  live.sort(function (a, b) { return (Number(b[4]) || 0) - (Number(a[4]) || 0); });

  // Expiry alone was not the problem. On the real sheet 322 of 330 rows were
  // LIVE — an engineer session lasts 30 days and every login appends another
  // row, so someone logging in daily carries thirty live tokens at once. That
  // is what validateSession_ reads and scans on EVERY request, and it grows
  // with every login ever made. Capping per person bounds it, and it is the
  // better security answer too: 322 outstanding bearer tokens on a payroll
  // system is a lot of keys to have lying around for no benefit.
  const perUser = {};
  const keep = [data[0]];
  for (let i = 0; i < live.length; i++) {
    // The separator is written as an escape, not the literal NUL byte that
    // used to sit in this source. The file is deployed by copying it into the
    // Apps Script editor, and a raw NUL does not survive a clipboard round
    // trip intact. Silently dropped, role+username would run together and
    // 'hr'+'admin' would collide with 'h'+'radmin', so the per-person cap
    // would count two people as one and prune a session it should keep.
    const who = String(live[i][1]) + '\u0000' + String(live[i][2]); // role + username
    perUser[who] = (perUser[who] || 0) + 1;
    if (perUser[who] <= MAX_SESSIONS_PER_USER) keep.push(live[i]);
  }

  const removed = data.length - keep.length;
  if (!removed) return 0;
  // Every row padded to the same width, or setValues rejects a ragged array —
  // rows written before createdAt existed are four wide, new ones are five.
  const WIDTH = 5;
  const rect = keep.map(function (r) {
    const out = [];
    for (let c = 0; c < WIDTH; c++) out.push(r[c] === undefined ? '' : r[c]);
    return out;
  });
  // The header only gets written when the sheet is first created, and this
  // sheet long predates createdAt — so label the new column here rather than
  // leaving a blank cell above real data for whoever reads it next.
  if (rect.length && !rect[0][4]) rect[0][4] = 'createdAt';
  sheet.getRange(1, 1, rect.length, WIDTH).setValues(rect);
  sheet.getRange(rect.length + 1, 1, data.length - rect.length, WIDTH).clearContent();
  return removed;
}

// Purges on login rather than on every request: logging in is rare, the person
// is already waiting on a round trip, and it keeps the cost off the save path
// that this is meant to make faster.
function createSession_(role, username, ttlMs) {
  const sheet = getSessionSheet_();
  try {
    purgeExpiredSessions_(sheet);
  } catch (err) {
    // Housekeeping must never stop somebody logging in.
    Logger.log('Session purge skipped: ' + err);
  }
  const token = Utilities.getUuid() + '-' + Utilities.getUuid();
  const createdAt = Date.now();
  const expiresAt = createdAt + (ttlMs || SESSION_LIFETIME_MS);
  // createdAt is what the purge ranks on. Expiry cannot stand in for it once
  // two roles have different lifetimes — see purgeExpiredSessions_.
  sheet.appendRow([sha256Hex_(token), role, username, expiresAt, createdAt]);
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

// Read-only. Says what state the SESSIONS sheet is actually in, so a spurious
// "Your session has expired" can be diagnosed instead of guessed at.
//
// Written after HR was logged out four minutes after logging in, twice, on a
// 24-hour session. Every 'unauthorized' the backend can return comes from
// validateSession_ failing to find the token, so the question is only ever
// "what does that sheet look like right now" — and there was no way to ask.
//
// Prints NO token hashes and NO usernames beyond a count per role. Safe to run
// and safe to paste back: pick it in the function dropdown and press Run, then
// read the log (View → Executions, or Ctrl+Enter).
function diagnoseSessions() {
  var sheet = getSessionSheet_();
  var data = sheet.getDataRange().getValues();
  var now = Date.now();
  Logger.log('SESSIONS sheet: ' + sheet.getName());
  Logger.log('rows incl. header: ' + data.length + '   columns: ' +
             (data[0] ? data[0].length : 0) + '   (5 once createdAt is in use)');
  if (data[0]) Logger.log('header: ' + JSON.stringify(data[0]));

  // The purge rewrites this sheet with a 4-column setValues. A sheet that is
  // not 4 columns wide makes that throw, createSession_ swallows it, and the
  // sheet then grows without limit — which is worth knowing about.
  if (data[0] && data[0].length > 5) {
    Logger.log('*** WIDTH MISMATCH — more than 5 columns; purgeExpiredSessions_ pads to 5');
    Logger.log('*** and would leave the extras behind.');
  }

  var live = 0, expired = 0, blank = 0, malformed = 0;
  var perRole = {};
  var newest = {};
  for (var i = 1; i < data.length; i++) {
    var h = data[i][0], role = String(data[i][1] || ''), who = String(data[i][2] || '');
    var exp = Number(data[i][3]);
    if (!h && !role && !who) { blank++; continue; }
    if (!h || !isFinite(exp) || exp <= 0) { malformed++; continue; }
    var key = role + ' / ' + who;
    perRole[key] = (perRole[key] || 0) + 1;
    if (exp < now) { expired++; } else {
      live++;
      if (!newest[key] || exp > newest[key]) newest[key] = exp;
    }
  }
  Logger.log('live: ' + live + '   expired-but-still-present: ' + expired +
             '   blank rows: ' + blank + '   malformed: ' + malformed);
  Logger.log('cap is ' + MAX_SESSIONS_PER_USER + ' live session(s) per person');
  Object.keys(perRole).forEach(function (k) {
    var n = newest[k];
    Logger.log('  ' + k + ' — ' + perRole[k] + ' row(s)' +
      (n ? ', newest expires ' + new Date(n).toString() +
           ' (' + Math.round((n - now) / 60000) + ' min from now)'
         : ', NONE live'));
  });
  if (expired > 0) {
    Logger.log('NOTE: expired rows are only cleared on login. Rows above the cap are');
    Logger.log('      dropped oldest-first, so a 6th login evicts the 1st.');
  }
  Logger.log('now: ' + new Date(now).toString());
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

// Passwords are stretched, not hashed once.
//
// A single salted SHA-256 is fast, and fast is the whole problem: if the KV
// sheet were ever exposed, an ordinary password falls to a dictionary run in
// minutes. Apps Script has no bcrypt or scrypt, so this iterates SHA-256
// instead — the same idea PBKDF2 uses, which is to make each guess cost the
// attacker as much as it costs us.
//
// The number of rounds is set for Apps Script's speed, not a laptop's.
// Utilities.computeDigest carries real per-call overhead — measured in Node
// the same loop runs in well under a second at 60,000 rounds, and on Apps
// Script that would be ten seconds or more and could hit the execution limit.
// A login that times out is a worse outcome than the weakness this fixes.
//
// Measured, not guessed. benchmarkPasswordHashing on the live project reports
// 0.7773 ms per round — Utilities.computeDigest is nearly all per-call
// overhead, so an iteration count that would be trivial anywhere else is
// expensive here. That put the previous 5,000 rounds at 4,823 ms of hashing on
// every single login, against an 8,000 ms cap (below), leaving about three
// seconds for the network. Fine on office wifi, which is why a real login felt
// normal; a coin flip on a phone on mobile data, where losing the toss means
// an aborted login into payroll with nothing on screen to explain it.
//
// So this went DOWN, not up: 1,000 rounds is 811 ms, leaving roughly seven
// seconds of the cap for the trip. The honest trade is 5x less attacker work
// than the setting it replaces. It is worth taking — the file's own older note
// had it right, that a login which times out is worse than the weakness this
// fixes — but it should be read for what it is: modest hardening on a salted
// hash that already sits in a private sheet behind a gated backend, not a
// strong key-derivation function. Apps Script cannot offer one of those at a
// price a login can pay.
//
// Two things that matter before this number is moved again:
//
//   - The limit that bites is NOT Apps Script's execution limit. A login goes
//     through apiFetch, which aborts each attempt at BACKEND_ATTEMPT_MS (8s)
//     inside a BACKEND_BUDGET_MS (9s) total. Hashing that overruns 8s gets the
//     attempt aborted and retried, and every retry hashes again — so the
//     budget is spent without a single login ever completing. Keep hashing
//     near a second, not near thirty.
//
//   - Changing this number DOES now re-hash everyone, one account at a time,
//     at their next login — see needsPasswordRehash_. That was not true when
//     the upgrade fired on isLegacyPasswordHash_ alone: a row already written
//     as v2$5000$... would have kept verifying at its own recorded 5,000
//     forever, and this change would have improved nothing for anybody who had
//     already logged in once.
//
// benchmarkPasswordHashing() measures the real per-round cost on this project.
// Run it before moving this number, and read the verdict column rather than
// judging a login by feel — a login that felt "fast, normal speed" was in fact
// spending 4.8 of its 8 available seconds inside this loop.
var PASSWORD_HASH_ROUNDS = 1000;
var PASSWORD_HASH_PREFIX = 'v2';

// "v2$<rounds>$<hex>". The scheme is stored beside the hash rather than
// assumed, so the rounds can be raised later without a second migration and
// without guessing what an old row was made with.
function hashPassword_(salt, password, rounds) {
  var n = rounds || PASSWORD_HASH_ROUNDS;
  var h = sha256Hex_(String(salt) + ':' + String(password));
  for (var i = 0; i < n; i++) h = sha256Hex_(h);
  return PASSWORD_HASH_PREFIX + '$' + n + '$' + h;
}

// True when `stored` matches, whichever scheme it was written with. Legacy
// rows are a bare hex digest of salt:password with no prefix; they keep
// working, and upgradePasswordHash_ below rewrites them the first time their
// owner logs in, so nobody has to reset anything.
function passwordMatches_(stored, salt, password) {
  var str = String(stored || '');
  if (str.indexOf(PASSWORD_HASH_PREFIX + '$') === 0) {
    var parts = str.split('$');
    var rounds = Number(parts[1]) || PASSWORD_HASH_ROUNDS;
    return hashPassword_(salt, password, rounds) === str;
  }
  return sha256Hex_(String(salt) + ':' + String(password)) === str;
}

function isLegacyPasswordHash_(stored) {
  return String(stored || '').indexOf(PASSWORD_HASH_PREFIX + '$') !== 0;
}

// Should this stored hash be rewritten at the next successful login? Two
// cases: a legacy row carrying no scheme prefix at all, and a v2 row whose
// recorded rounds are not the number now in force.
//
// The second case is the one that makes the work factor actually movable.
// Storing the rounds beside the hash was meant to let the factor change
// without a migration, but nothing ever compared them, so every v2 row stayed
// frozen at whatever it was first written with — the setting could be edited
// and no existing account would ever feel it.
//
// Compared with !== rather than <, because the factor has had to move DOWN as
// well as up: measurement put 5,000 rounds at 4.8s of an 8s cap. A row left at
// the old higher count would go on paying exactly the cost this change exists
// to remove, which is the failure it is meant to prevent.
//
// One login pays for the move: the old count to verify, the new count to
// rewrite. At the numbers involved here that is 4.8s + 0.8s, once, still
// inside the cap — and every login after it is 0.8s.
function needsPasswordRehash_(stored) {
  if (isLegacyPasswordHash_(stored)) return true;
  var parts = String(stored || '').split('$');
  return Number(parts[1]) !== PASSWORD_HASH_ROUNDS;
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
    if (rec.username !== username || !passwordMatches_(rec.hash, rec.salt, password)) {
      recordLoginFailure_(username);
      return { error: 'Invalid credentials' };
    }
    // The password was just proved correct, so this is the one moment the
    // plaintext is available to re-hash with. Wrapped: a failure to upgrade
    // must never stop somebody logging in.
    if (needsPasswordRehash_(rec.hash)) {
      try {
        rec.hash = hashPassword_(rec.salt, password);
        sheet.getRange(row, 2).setValue(JSON.stringify(rec));
      } catch (err) { Logger.log('HR password hash upgrade skipped: ' + err); }
    }
    clearLoginFailure_(username);
    const session = createSession_('hr', username, HR_SESSION_LIFETIME_MS);
    return { ok: true, token: session.token, role: 'hr' };
  } else {
    const row = findRow_(sheet, 'users');
    const users = row === -1 ? [] : JSON.parse(sheet.getRange(row, 2).getValue() || '[]');
    const user = users.filter(function (u) { return u.username === username && u.enabled !== false; })[0];
    if (!user) { recordLoginFailure_(username); return { error: 'Invalid credentials' }; }
    if (!passwordMatches_(user.hash, user.salt, password)) {
      recordLoginFailure_(username); return { error: 'Invalid credentials' };
    }
    if (needsPasswordRehash_(user.hash)) {
      try {
        user.hash = hashPassword_(user.salt, password);
        sheet.getRange(row, 2).setValue(JSON.stringify(users));
      } catch (err) { Logger.log('Engineer password hash upgrade skipped: ' + err); }
    }
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

// The one answer the frontend cannot interpret on its own.
//
// An empty roster is either a company with no staff yet or a sheet where
// migrateEmployeesToPerRecordKeys has never been run — and from the browser
// those are the same response. {ok:true, employees:[]} is a SUCCESS, so
// getEmployeesOrThrow_ has nothing to throw about, softly() has nothing to
// mark degraded, and the Dashboard paints a calm, wrong "Employee Master: 0"
// with no error banner at all. That is not hypothetical: it is what the live
// site showed, with all ~40 records sitting safely in the legacy `employees`
// row the whole time, and every report, sheet and export downstream of the
// roster silently empty with it. The Birthday Report reading "No data yet"
// was this, one screen along.
//
// The sheet itself can tell the two cases apart, because only the un-migrated
// one still has a populated legacy `employees` array next to zero
// employee:<id> rows. So it is reported as a real error, which is what turns
// the silent 0 into "Some figures couldn't be loaded" naming the fix.
//
// Both getAllEmployees handlers (doGet and doPost) return this, so the guard
// cannot be true on one door and not the other.
function employeesResponse_(rows) {
  var list = allEmployeesFromRows_(rows);
  if (list.length) return { ok: true, employees: list };

  // Read from the rows already in hand — no second whole-sheet read.
  var legacyCount = 0;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] !== 'employees') continue;
    try {
      var legacy = JSON.parse(rows[i][1] || '[]');
      if (legacy instanceof Array) legacyCount = legacy.length;
    } catch (e) { /* unparseable legacy row: treat as no evidence either way */ }
    break;
  }
  if (legacyCount > 0) {
    // Kept under 180 characters on purpose: the Dashboard's degraded banner
    // prints lastBackendError sliced to 180, and a message cut off mid-
    // sentence would lose the one instruction that fixes it.
    return { error: 'migration required',
             message: legacyCount + ' record(s) still in the old format, none migrated yet. ' +
               'Nothing is lost. In the sheet: Extensions > Apps Script > run ' +
               'migrateEmployeesToPerRecordKeys, then reload this app.' };
  }
  // Genuinely nobody on file. A real, correct zero.
  return { ok: true, employees: [] };
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

// What password hashing actually costs on this project, so the work factor is
// chosen from a measurement rather than from how a login felt.
//
// Read-only in every sense that matters: it hashes a throwaway string, touches
// no account, reads no employee data and writes nothing. Safe to run whenever.
//
// The number it is looking for is not the Apps Script execution limit but
// BACKEND_ATTEMPT_MS in index.html — 8 seconds, after which apiFetch aborts the
// login and retries, re-hashing each time. A login also has to carry real
// network latency on a phone, so hashing gets a budget of about 1.5s and the
// rest is left for the trip.
function benchmarkPasswordHashing() {
  var ATTEMPT_CAP_MS = 8000;   // BACKEND_ATTEMPT_MS in index.html
  var HASH_BUDGET_MS = 1500;   // what hashing may take, leaving room for the network
  var LEVELS = [1000, 5000, 20000, 50000, 100000, 200000];

  // The first digest of a run pays one-off costs that would otherwise be
  // charged to the smallest level and skew the per-round figure.
  sha256Hex_('warm-up');

  var out = ['Password hashing on this project', ''];
  out.push('  ' + 'rounds'.padStart(8) + '  ' + 'time'.padStart(9) + '   verdict');
  out.push('  ' + '-'.repeat(46));

  var perRound = 0;
  for (var i = 0; i < LEVELS.length; i++) {
    var n = LEVELS[i];
    var t0 = Date.now();
    hashPassword_('benchmark-salt', 'not-a-real-password', n);
    var ms = Math.round(Date.now() - t0);
    perRound = ms / n;
    var verdict = ms <= HASH_BUDGET_MS ? 'comfortable'
      : ms <= ATTEMPT_CAP_MS / 2 ? 'usable, less room for the network'
      : ms < ATTEMPT_CAP_MS ? 'TOO SLOW — no room for the network'
      : 'WOULD FAIL — past the ' + (ATTEMPT_CAP_MS / 1000) + 's attempt cap';
    out.push('  ' + String(n).padStart(8) + '  ' + (ms + ' ms').padStart(9) + '   ' + verdict);
    // No point timing anything heavier once a level is already unusable.
    if (ms >= ATTEMPT_CAP_MS) { out.push('  (stopped here — heavier settings can only be worse)'); break; }
  }

  var suggested = Math.floor((HASH_BUDGET_MS / perRound) / 1000) * 1000;
  out.push('');
  out.push('  cost per round      : ' + perRound.toFixed(4) + ' ms');
  out.push('  currently set to    : ' + PASSWORD_HASH_ROUNDS + ' rounds (~' +
    Math.round(PASSWORD_HASH_ROUNDS * perRound) + ' ms)');
  out.push('  fits a ' + HASH_BUDGET_MS + 'ms budget : ' + suggested + ' rounds');
  out.push('  would hit the ' + (ATTEMPT_CAP_MS / 1000) + 's cap : ' +
    Math.round(ATTEMPT_CAP_MS / perRound) + ' rounds');
  out.push('');
  out.push('  Changing PASSWORD_HASH_ROUNDS re-hashes each account at its own');
  out.push('  next login (needsPasswordRehash_). The first login after a change');
  out.push('  pays the old count to verify plus the new one to rewrite, so keep');
  out.push('  that sum under the ' + (ATTEMPT_CAP_MS / 1000) + 's cap as well.');

  var text = out.join('\n');
  Logger.log(text);
  return text;
}

// Read-only. Answers "where is the roster, then?" when both the per-employee
// keys and the legacy `employees` row come back empty — which is the one
// situation neither getAllEmployees nor the migration above can explain by
// itself, because each of them only ever looks at the place it expects the
// data to be.
//
// Logs key NAMES and value LENGTHS only, never a value: this output is meant
// to be read off a screen or sent in a message, and the KV sheet holds
// employee records and a password hash. (Session tokens are not here at all —
// they live in the separate SESSIONS tab — but the same rule is applied
// anyway rather than relying on that staying true.) Keys whose name alone
// looks sensitive are counted, not named.
//
// Run it from the Apps Script editor: pick diagnoseEmployeeStorage from the
// function list and press Run, then open the execution log.
function diagnoseEmployeeStorage() {
  var out = [];
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  out.push('Spreadsheet: "' + ss.getName() + '"');
  out.push('Id: ' + SPREADSHEET_ID);
  out.push('Tabs: ' + ss.getSheets().map(function (s) {
    return s.getName() + ' (' + s.getLastRow() + ' rows)';
  }).join(', '));

  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    out.push('!! There is no "' + SHEET_NAME + '" tab in this spreadsheet.');
    Logger.log(out.join('\n'));
    return out.join('\n');
  }

  var rows = sheet.getDataRange().getValues();
  var perEmployee = 0, legacyLen = -1, sensitive = 0, groups = {};
  for (var i = 1; i < rows.length; i++) {
    var k = String(rows[i][0] == null ? '' : rows[i][0]);
    if (!k) continue;
    var len = String(rows[i][1] == null ? '' : rows[i][1]).length;
    if (k.indexOf('employee:') === 0) { perEmployee++; continue; }
    if (k === 'employees') { legacyLen = len; continue; }
    if (/pass|token|secret|hash|cred/i.test(k)) { sensitive++; continue; }
    // Grouped by prefix so one line covers forty attendance keys.
    var g = k.indexOf(':') > 0 ? k.slice(0, k.indexOf(':') + 1) + '*' : k;
    groups[g] = (groups[g] || 0) + 1;
  }

  out.push(SHEET_NAME + ' holds ' + Math.max(0, rows.length - 1) + ' key(s) in total.');
  out.push('employee:<id> rows : ' + perEmployee);
  out.push('legacy `employees`  : ' +
    (legacyLen < 0 ? 'NOT PRESENT' : legacyLen + ' characters'));
  var names = [];
  for (var g2 in groups) names.push(g2 + (groups[g2] > 1 ? ' x' + groups[g2] : ''));
  names.sort();
  out.push('other keys: ' + (names.join(', ') || '(none)'));
  if (sensitive) out.push('(' + sensitive + ' key name(s) withheld as sensitive)');

  var text = out.join('\n');
  Logger.log(text);
  return text;
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
    return jsonOut_(employeesResponse_(rows));
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

  // `get` and `getAllEmployees` over POST as well as GET. A GET carries the
  // session token in the query string, and a URL is written to the Apps Script
  // execution log and the browser's history in a way a request body is not —
  // so a token that should live for 24 hours was being recorded in two places
  // that outlive it. Every other call already used POST; these two were the
  // last on GET.
  //
  // The doGet versions stay for now, deliberately. The frontend and this file
  // deploy at different moments — index.html is live within a minute of a push
  // and this has to be pasted by hand — so removing them here would break
  // every read for however long that gap is.
  if (body.action === 'get') {
    if (isEngineer && !engineerMayRead_(body.key, auth.username)) return forbidden_();
    const sheetG = getSheet_();
    const rowG = findRow_(sheetG, body.key);
    return jsonOut_({ value: rowG === -1 ? null : sheetG.getRange(rowG, 2).getValue() });
  }
  if (body.action === 'getAllEmployees') {
    if (isEngineer) return forbidden_();
    return jsonOut_(employeesResponse_(getSheet_().getDataRange().getValues()));
  }

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
    } else if (body.action === 'setSequence') {
      // The roster's display order is HR's, like every other employee: field.
      // Named explicitly rather than left to fall through — a write action
      // nobody has listed is refused, not allowed.
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
      else {
        // Read the existing cell ONCE. Both staleness guards want the same
        // value, and each getValue() is its own round trip to the Sheets
        // service — on an employee record or a payroll-document tracker that is
        // the same tens of thousands of characters fetched twice, on the save
        // path, for no gain.
        const existing = sheet.getRange(row, 2).getValue();
        if (!isStaleEmployeeWrite_(body.key, body.value, existing) &&
            !isStalePayrollDocsWrite_(body.key, body.value, existing)) {
          sheet.getRange(row, 2).setValue(body.value);
        }
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
      // queueing for this lock.
      //
      // The sheet is read once. It is now WRITTEN once too, or close to it:
      // this used to be a setValue per key, so a ten-employee attendance save
      // was ten round trips to the Sheets service, all of them holding the
      // script-wide lock that every other write in this app queues on with a
      // six-second patience. setSequence had the identical shape and it is
      // what made HR's save fail with "the server did not respond" on a
      // record that was perfectly fine. Same fix here, before it does the same
      // thing on a busy attendance day: rows that already exist are grouped
      // into contiguous runs and written a run at a time, and brand-new keys
      // are appended together in one block instead of an appendRow each.
      var sheetM = getSheet_();
      var dataM = sheetM.getDataRange().getValues();
      var indexM = {};
      for (var mi = 1; mi < dataM.length; mi++) indexM[dataM[mi][0]] = mi + 1;
      var entries = body.entries || {};
      var savedKeys = [];
      var skippedKeys = [];
      var updatesM = [];
      var appendsM = [];
      for (var k in entries) {
        if (!indexM[k]) {
          appendsM.push([k, entries[k]]);
          savedKeys.push(k);
        } else if (!isStaleEmployeeWrite_(k, entries[k], dataM[indexM[k] - 1][1]) &&
                   !isStalePayrollDocsWrite_(k, entries[k], dataM[indexM[k] - 1][1])) {
          updatesM.push({ row: indexM[k], value: entries[k] });
          savedKeys.push(k);
        } else {
          // A key the staleness guard refused. This used to be pushed into
          // savedKeys anyway, alongside the rows that really were written —
          // so saveEmployees' deliberate "every key requested must actually
          // come back confirmed" check (index.html), which exists precisely
          // to catch a partial bulk save, could never see it. A sequence
          // change that skipped somebody reported complete success and left
          // the roster with gaps and duplicates, and the next renumber built
          // on that. Report it separately and let the client say so.
          skippedKeys.push(k);
        }
      }
      // Existing rows, a contiguous run at a time.
      updatesM.sort(function (a, b) { return a.row - b.row; });
      var runFrom = 0;
      for (var ui = 1; ui <= updatesM.length; ui++) {
        if (ui < updatesM.length && updatesM[ui].row === updatesM[ui - 1].row + 1) continue;
        var runM = updatesM.slice(runFrom, ui);
        sheetM.getRange(runM[0].row, 2, runM.length, 1)
              .setValues(runM.map(function (u) { return [u.value]; }));
        runFrom = ui;
      }
      // New keys, all in one block below the last row. dataM was read inside
      // this same lock, so nothing can have appended underneath us since.
      if (appendsM.length) {
        sheetM.getRange(dataM.length + 1, 1, appendsM.length, 2).setValues(appendsM);
      }
      return jsonOut_({ ok: true, many: true, saved: savedKeys, skipped: skippedKeys });
    } else if (body.action === 'setSequence') {
      // The central sequence, and nothing else. applySequenceChange_ used to
      // send each moved employee's WHOLE record back just to change seqNo,
      // which put a display-order change in front of the staleness guard that
      // protects real edits: if another device had saved that employee since
      // this browser last read the roster, the write was refused and the
      // person silently kept their old number. Worse, had the guard let it
      // through, a forty-field record read minutes ago would have overwritten
      // that other device's edit.
      //
      // Merging the one field here, inside the lock, against whatever the row
      // holds right now, removes both problems at once: nothing else in the
      // record is touched, so there is nothing to clobber and nothing to be
      // stale about. It also makes true what index.html has always claimed —
      // "the only field written is seqNo. That is why it is safe to run on
      // every save."
      var sheetQ = getSheet_();
      var dataQ = sheetQ.getDataRange().getValues();
      var indexQ = {};
      for (var qi = 1; qi < dataQ.length; qi++) indexQ[dataQ[qi][0]] = qi + 1;
      var seqs = body.sequence || {};
      var seqSaved = [];
      var seqMissing = [];
      var seqRows = [];
      for (var sid in seqs) {
        var rowKey = 'employee:' + sid;
        if (!indexQ[rowKey]) { seqMissing.push(sid); continue; }
        var recQ;
        try { recQ = JSON.parse(dataQ[indexQ[rowKey] - 1][1]); } catch (eQ) { recQ = null; }
        // A row that will not parse is left exactly as it is rather than
        // replaced with a record built from nothing — the same fail-open the
        // staleness guards use.
        if (!recQ || typeof recQ !== 'object') { seqMissing.push(sid); continue; }
        var wantN = Number(seqs[sid]);
        if (!isFinite(wantN) || wantN <= 0) { seqMissing.push(sid); continue; }
        recQ.seqNo = wantN;
        seqRows.push({ row: indexQ[rowKey], value: JSON.stringify(recQ) });
        seqSaved.push(sid);
      }
      // Written in contiguous runs, one setValues per run, NOT one setValue
      // per employee. Moving somebody near the top of a roster of forty
      // renumbers nearly all of them, and a setValue each was forty separate
      // round trips to the Sheets service — held, the whole time, inside the
      // script-wide lock every other write in the app is waiting on. That lock
      // only waits 6 seconds, so the next save (HR pressing Save again, an
      // engineer checking in) came back 'busy' and surfaced in the app as
      // "Could not save — the server did not respond". Employee rows are
      // created together and so are almost always adjacent, which makes this
      // one write in practice; scattered rows degrade to one write per run
      // rather than per row.
      seqRows.sort(function (a, b) { return a.row - b.row; });
      var runStart = 0;
      for (var ri = 1; ri <= seqRows.length; ri++) {
        if (ri < seqRows.length && seqRows[ri].row === seqRows[ri - 1].row + 1) continue;
        var run = seqRows.slice(runStart, ri);
        sheetQ.getRange(run[0].row, 2, run.length, 1)
              .setValues(run.map(function (r) { return [r.value]; }));
        runStart = ri;
      }
      return jsonOut_({ ok: true, sequenced: true, saved: seqSaved, missing: seqMissing });
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

// Who counts as not at work, and why. These two maps mirror
// ABSENT_TODAY_CODES and ON_LEAVE_TODAY_CODES in index.html and have to stay
// in step with them: the digest and the Dashboard's Absent Today card answer
// the same question a few hours apart, and an evening email disagreeing with
// what HR saw on screen all day is worse than either being wrong on its own.
//
// "Absent" here means not at work, approved leave included. The digest used to
// count only code 'A' — narrower even than the Dashboard, which at least
// counted unpaid leave — so a day somebody was on EL, or on leave without pay,
// reported nobody absent at all. The reason travels with each name instead of
// deciding whether the name appears.
var DIGEST_ABSENT_CODES = { A: 'Absent', LP: 'Leave without pay', HLP: 'Half day (LP)' };
var DIGEST_ON_LEAVE_CODES = { EL: 'Earned Leave', SL: 'Sick Leave',
                              HEL: 'Half day — EL', HSL: 'Half day — SL' };

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
    var why = DIGEST_ABSENT_CODES[code] || DIGEST_ON_LEAVE_CODES[code];
    // Each name carries the reason it is on the list, so "3 absent" can be
    // read without opening the app to find out which of them were on leave.
    if (why) absent.push((e.name || e.id) + ' — ' + why);
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
    // One per line rather than a comma-separated run: every name now carries
    // its reason, and "Asha Patel — Earned Leave, Ravi Shah — Absent" run
    // together reads as one muddle.
    (absent.length
      ? '<p style="margin:0 0 6px;color:#5A6270;font-size:12px;">Everybody not at work, approved leave included.</p>' +
        '<ul style="margin:0 0 16px;padding-left:18px;">' +
        absent.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('') + '</ul>'
      : '<p style="margin:0 0 16px;">Everybody is at work today.</p>') +
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
    (absent.length
      ? 'Everybody not at work, approved leave included.\n' +
        absent.map(function (line) { return '  ' + line; }).join('\n')
      : 'Everybody is at work today.') + '\n\n' +
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
// The trigger runs DAILY and the function returns immediately unless today is
// MONTHLY_EMAIL_DAY, the same shape every other monthly email here uses. It
// used to send on the 30th about the month ahead, which needed a "or the last
// day of a shorter month" rule because Apps Script's onMonthDay(30) never fires
// in February. An early day of the month exists in every month, so that rule is
// gone with it.
//
// Note this one alone reports the month it is SENT in, not the month before:
// the monthly reports are a record of a finished month, but this is a list of
// what falls due in the month now starting, so HR has the whole of it to act.
// Which day of the month every month-end email goes out on.
//
// It was hard-coded as 1 in six separate date checks, and the labels and log
// lines describing it drifted out of step more than once — listReminderTriggers
// was still announcing the 30th and the 2nd long after both had moved. One
// constant now, and every gate, label and log line reads from it, so the day
// and what the script says about the day cannot disagree again.
//
// Deliberately a day-of-month check inside each function rather than an Apps
// Script monthly trigger: onMonthDay(30) never fires in February, so a monthly
// trigger silently skips a month. Every one of these is a DAILY trigger whose
// function returns immediately unless today is this day.
//
// Changing this number moves all six emails together and needs no trigger to be
// recreated — the triggers only decide the hour.
var MONTHLY_EMAIL_DAY = 2;

// "2nd", for the log lines and labels that say when these go out.
function monthlyEmailDayLabel_() {
  var d = MONTHLY_EMAIL_DAY, r = d % 10, t = d % 100;
  var suffix = (r === 1 && t !== 11) ? 'st'
             : (r === 2 && t !== 12) ? 'nd'
             : (r === 3 && t !== 13) ? 'rd' : 'th';
  return d + suffix;
}

var INCREMENT_REMINDER_EMAIL = 'rasesh@rsinfotech.net';
var INCREMENT_REMINDER_HOUR = 10; // 10 AM IST on MONTHLY_EMAIL_DAY, for this month's increments

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
    INCREMENT_REMINDER_HOUR + ':00 IST and emails only on the ' + monthlyEmailDayLabel_() +
    ', listing the increments ' +
    'due in the month then starting.');
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

// The function the trigger calls. Also safe to run by hand from the editor at
// any time to see the email immediately — pass true to skip the day check.
function sendIncrementReminderEmail(force) {
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (force !== true && Number(istToday.slice(8, 10)) !== MONTHLY_EMAIL_DAY) return;

  // The month being sent in, not the one before it — see the note above the
  // trigger. Taken off the IST date string rather than worked out from a Date's
  // own month, so it cannot land in the wrong month in a timezone behind UTC.
  var targetYm = istToday.slice(0, 7);
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

// ===== Monthly report pack, emailed on MONTHLY_EMAIL_DAY for the month just ended =====
//
// This builds the six reports at send time from shared/report-logic.js, and
// does not compute a single figure of its own — it must never be changed to.
//
// Every number in these six reports comes out of that shared file —
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
// So the deal is: whatever HR sees on screen is what gets attached, because
// both come out of the same functions over the same records. An earlier version
// attached whichever CSV the app had last filed in Drive, which made an emailed
// report only as fresh as the last time somebody happened to open it — and
// silently one attachment short if nobody ever had. See "Fresh report
// generation" below for how it works now.
// ===== Fresh report generation =====
//
// Every report email below builds its own figures at the moment it runs. It
// does NOT attach whatever CSV the app last filed in Drive, which is what
// these emails used to do and why an emailed report silently depended on
// somebody having opened it in the app first — a report nobody opened was a
// month out of date or missing altogether.
//
// The calculations are not reimplemented here. shared/report-logic.js on the
// live site holds the one copy of them; the app loads it with a <script src>
// and this fetches the same URL and evaluates it, so the figure in an
// attachment is produced by the same lines as the figure on screen. Copying
// any of that arithmetic into this file would recreate exactly the drift it
// was written to end.
//
// SHARED_LOGIC_URL only needs filling in to pin a specific address. Left
// empty, it uses the origin the app records for itself each time HR opens it
// (see noteSiteOrigin_ in index.html), so this normally configures itself.
var SHARED_LOGIC_URL = '';

// The evaluated shared logic, for the length of ONE execution only. Deliberately
// not cached in Script Properties or CacheService between runs: a cached copy
// is a stale copy, and the whole point of this is that a run uses what is
// deployed right now.
var SHARED_LOGIC_ = null;

function sharedLogicUrl_(map) {
  if (SHARED_LOGIC_URL) return SHARED_LOGIC_URL;
  var origin = map && map['site_origin'];
  if (!origin) return '';
  return String(origin).replace(/\/+$/, '') + '/shared/report-logic.js';
}

// Fetches shared/report-logic.js and evaluates it into an object holding every
// function it declares. Throws rather than returning something half-built —
// every caller treats a failure here as "this report could not be generated",
// which is reported, never papered over with an older file.
function loadSharedReportLogic_(map) {
  if (SHARED_LOGIC_) return SHARED_LOGIC_;
  var url = sharedLogicUrl_(map);
  if (!url) {
    throw new Error('No address for shared/report-logic.js. Open the HR app once so it can ' +
      'record its own address, or set SHARED_LOGIC_URL at the top of this file to ' +
      'https://<your site>/shared/report-logic.js');
  }
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Could not fetch ' + url + ' — HTTP ' + code +
      '. The report figures come from that file, so nothing was generated.');
  }
  var body = res.getContentText();
  // A Vercel error page or an SPA fallback returns 200 with HTML in it. Catch
  // that here rather than let eval throw something unreadable.
  if (!body || body.indexOf('computeSalaryFromAttendance') === -1) {
    throw new Error('The file at ' + url + ' does not look like shared/report-logic.js ' +
      '(no computeSalaryFromAttendance in it), so nothing was generated.');
  }
  var box = {};
  // Evaluated into a function scope, then the declarations are picked out by
  // name. eval is the only way Apps Script can run code it fetched, and this
  // is our own file from our own site over HTTPS.
  var names = ['computeSalaryFromAttendance', 'computeAttendanceSummary', 'LEAVE_DETAIL_METRICS',
    'resolvedAttendanceCode_', 'loansOf', 'loanBalanceAfter', 'loanEmiRateAsOf',
    'computeLoanEmiForMonth', 'loanBalanceAfterMonth', 'advanceBalanceAfterMonth',
    'salaryAdvanceForMonth', 'advanceTempForMonth', 'diwaliBonusFor', 'monthlyPayFor',
    'financialYearLabel', 'calculatePfFor', 'computeEsi', 'monthlyPtFor', 'ratePayAsOf',
    'SALARY_HEADINGS', 'PF_RULES', 'ESI_RULES', 'LEAVE_POLICY',
    'leaveWorkingDays', 'applyAlwaysPresentFill', 'leaveDetailRowFor',
    'leaveDetailReportRows', 'leaveDetailCsvHeader', 'leaveDetailCsvRows',
    'loanLedgerRows', 'loanLedgerCsvHeader', 'loanLedgerCsvRows',
    'loanLedgerTotals', 'loanLedgerCsvTotalRow',
    'employedDuringPeriod_', 'salarySheetCsv', 'finalSalarySheetCsv', 'attendanceSheetCsv',
    'statutoryReportData', 'pfReturnCsv', 'esiReturnCsv', 'statutoryAmountCsv',
    'policyRowsFor', 'attCodeText_', 'SALARY_HEADING_ORDER',
    'consultantReportEmployees', 'consultantReportRows', 'consultantCsvRows',
    'excelIdNumber', 'employeesInSequence', 'seqNoOf',
    'consultantSummaryEmployees', 'consultantSummaryTotals', 'consultantSummaryCsv',
    'WAGE_REGISTER_COLS', 'wageRegisterRows', 'wageRegisterCsvRows',
    'withSalaryCache'];
  var collect = new Function(body + '\nreturn (function(){ var o = {};' +
    names.map(function (n) { return 'try{ o[' + JSON.stringify(n) + '] = ' + n + '; }catch(e){}'; }).join('') +
    'return o; })();');
  box = collect();
  var missing = [];
  for (var i = 0; i < names.length; i++) if (box[names[i]] === undefined) missing.push(names[i]);
  if (missing.length) {
    throw new Error('shared/report-logic.js loaded but is missing: ' + missing.join(', ') +
      '. Nothing was generated rather than guess at the figures.');
  }
  SHARED_LOGIC_ = box;
  return SHARED_LOGIC_;
}

// The whole sheet as a key/value map plus the employee list, read once and
// passed around — every report below works from the same snapshot of the
// live data, taken at email time.
function reportDataSnapshot_() {
  var rows = getSheet_().getDataRange().getValues();
  var map = {};
  for (var i = 0; i < rows.length; i++) map[rows[i][0]] = rows[i][1];
  // Put in the central sequence once, here, so every emailed report lists
  // people in the same order the screen does — and so a report added later
  // inherits that without being told.
  //
  // Sorted here rather than inside allEmployeesFromRows_ because that is also
  // on the engineer request path, where loading the shared logic would add a
  // network round trip to every call; an engineer reading their own attendance
  // does not care what order the roster is in. Every caller of this function is
  // a report that loads the shared logic anyway, and loadSharedReportLogic_
  // caches it for the execution, so this costs nothing.
  var logic = loadSharedReportLogic_(map);
  return { map: map, rows: rows,
           employees: logic.employeesInSequence(allEmployeesFromRows_(rows)) };
}

// Every date in a month, as the app builds it for a report.
function monthDateList_(y, m) {
  var days = new Date(y, m, 0).getDate();
  var out = [];
  for (var d = 1; d <= days; d++) {
    out.push(y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2));
  }
  return out;
}

// The Holiday List as the shared logic expects it: { 'YYYY-MM-DD': true }.
function holidayMapFromSheet_(map) {
  var raw = map['holidays'];
  var out = {};
  if (!raw) return out;
  var list = [];
  try { list = JSON.parse(raw) || []; } catch (e) { return out; }
  for (var i = 0; i < list.length; i++) {
    var h = list[i];
    var d = h && (h.date || h.d || h);
    if (d) out[String(d)] = true;
  }
  return out;
}

// Whether an employee was on the books during a month — the same test the
// app's own period reports use, so a leaver still appears in the months they
// actually worked.
function employedInMonth_(e, startStr, endStr) {
  if (!e) return false;
  if (e.doj && e.doj > endStr) return false;
  if (e.employmentStatus === 'left' && e.leftDate && e.leftDate < startStr) return false;
  return true;
}

// Attendance for a set of employees over one month, shaped exactly as the app
// shapes it: merged across financial-year keys, then the "Always mark
// Present" fill applied through the shared function. Anything less and the
// email would run the same arithmetic over different input.
function attendanceForMonth_(map, employees, y, m, holidayMap, logic) {
  var fyLabel = fyLabelFor_(y, m);
  // A month can only belong to one financial year, but the legacy whole-record
  // key and the neighbouring year are merged in too, exactly as
  // getAttendanceAll does for the app.
  var labels = [fyLabel, fyLabelFor_(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1)];
  var byId = {};
  for (var i = 0; i < employees.length; i++) {
    byId[employees[i].id] = mergedAttendanceForId_(map, employees[i].id, labels);
  }
  var withFrom = employees.filter(function (e) { return e && e.alwaysPresentFrom; });
  if (withFrom.length) {
    byId = logic.applyAlwaysPresentFill(byId, withFrom, holidayMap, null, null, todayIso_());
  }
  return byId;
}

// ---- Monthly Leave Detail Report, generated here and now ----
// Returns the same rows the report screen shows, because it calls the same
// function. Throws rather than returning something partial: a report that
// cannot be built is reported as such, never replaced with an older file.
function buildLeaveDetailReport_(snap, y, m) {
  var logic = loadSharedReportLogic_(snap.map);
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  // Same roster rule as the report screen: current staff.
  var employees = snap.employees.filter(function (e) {
    return e && e.employmentStatus !== 'left';
  });
  var dateList = monthDateList_(y, m);
  var holidayMap = holidayMapFromSheet_(snap.map);
  var attByEmpId = attendanceForMonth_(snap.map, employees, y, m, holidayMap, logic);
  var built = logic.leaveDetailReportRows(employees, attByEmpId, dateList, holidayMap);
  // sheet is what goes in the file, in either format: the flat CSV shape of the
  // rows, not the objects in built.rows that the email prose counts.
  var sheet = { header: logic.leaveDetailCsvHeader(), rows: logic.leaveDetailCsvRows(built.rows) };
  return {
    label: 'Monthly Leave Detail Report',
    monthLabel: monthLabel,
    fileName: 'Monthly Leave Detail Report - ' + monthLabel + '.csv',
    header: sheet.header,
    rows: built.rows,
    onRoll: built.all.length,
    sheet: sheet,
    csv: toCsv_(sheet.header, sheet.rows)
  };
}

// ---- Loan and EMI Report, generated here and now ----
// A running position rather than a closed month: reported as it stands at the
// END of the month being reported on, which is the moment the payroll for that
// month was finished.
function buildLoanAdvanceReport_(snap, y, m) {
  var logic = loadSharedReportLogic_(snap.map);
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var employees = snap.employees.filter(function (e) {
    return e && e.employmentStatus !== 'left';
  });
  var ledger = logic.loanLedgerRows(employees, y, m);
  var stalled = 0;
  for (var i = 0; i < ledger.length; i++) {
    if (ledger[i].stalled) stalled++;
  }
  // Same totals function the report tab uses, so the Grand Total in the
  // attachment is the report's own arithmetic and not a second version of it
  // added up here.
  var totals = logic.loanLedgerTotals(ledger);
  var sheet = { header: logic.loanLedgerCsvHeader(),
                rows: logic.loanLedgerCsvRows(ledger).concat([logic.loanLedgerCsvTotalRow(ledger)]) };
  return {
    label: 'Loan and EMI Report',
    monthLabel: monthLabel,
    fileName: 'Loan and EMI Report - ' + monthLabel + '.csv',
    rows: ledger,
    outstanding: Math.round(totals.balance),
    monthlyRecovery: Math.round(totals.emiThisMonth),
    stalled: stalled,
    sheet: sheet,
    csv: toCsv_(sheet.header, sheet.rows)
  };
}

// One report in a pack, in the two forms it has to exist in: the CSV that the
// freshness checks, the attachment size budget and the Drive copies read, and
// the header and rows the workbook builder lays out column widths from. Built
// from one pair of arrays, so the file that is checked and the file that is
// sent can never hold different figures.
function packReport_(label, monthVal, header, rows) {
  return {
    label: label,
    fileName: label + ' - ' + monthVal + '.csv',
    sheet: { header: header, rows: rows },
    csv: toCsv_(header, rows)
  };
}

// ---- The monthly report pack, all six generated here and now ----
// One snapshot of the sheet, one load of the shared logic, one set of
// attendance reads, then six reports off the same figures — so the Salary Sheet
// and the PF return in the same email cannot disagree about anyone's basic.
function buildMonthlyReportPack_(snap, y, m) {
  var startedAt = Date.now();
  var logic = loadSharedReportLogic_(snap.map);
  var monthVal = y + '-' + ('0' + m).slice(-2);
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var dateList = monthDateList_(y, m);
  var monthDays = dateList.length;
  var holidayMap = holidayMapFromSheet_(snap.map);
  var start = dateList[0], end = dateList[dateList.length - 1];

  // Anyone whose tenure overlaps the month, which is what every period report
  // in the app uses — a leaver still belongs on the months they worked.
  var employees = snap.employees.filter(function (e) {
    return logic.employedDuringPeriod_(e, start, end);
  });
  var att = attendanceForMonth_(snap.map, employees, y, m, holidayMap, logic);

  // Built inside one withSalaryCache block, so each employee's salary is
  // worked out once for the whole pack instead of once per report — six
  // reports were asking for it 4.3 times each. Same figures, since the
  // calculation is pure; measurably less work.
  var salary, finalSal, attendance, pf, esi, pt, pfCsv, esiCsv, ptCsv;
  logic.withSalaryCache(function () {
    salary = logic.salarySheetCsv(employees, att, dateList, monthDays, holidayMap);
    finalSal = logic.finalSalarySheetCsv(employees, att, dateList, monthDays, holidayMap);
    attendance = logic.attendanceSheetCsv(employees, att, dateList, holidayMap);
    pf = logic.statutoryReportData(employees, att, dateList, monthDays, holidayMap, 'pf');
    esi = logic.statutoryReportData(employees, att, dateList, monthDays, holidayMap, 'esi');
    pt = logic.statutoryReportData(employees, att, dateList, monthDays, holidayMap, 'pt');
    pfCsv = logic.pfReturnCsv(pf.pfRows, pf.pfTot, pf.pfExcluded);
    esiCsv = logic.esiReturnCsv(esi.esiRows, esi.esiTot, esi.esiExcluded);
    ptCsv = logic.statutoryAmountCsv(pt.rows, pt.grandTotal, 'pt');
  });
  assertWithinBudget_(startedAt, 'Building the monthly report pack');

  // The names are the ones the app files under, so an attachment and the Drive
  // copy of the same report are the same file by name as well as by content.
  return {
    monthLabel: monthLabel,
    employees: employees.length,
    reports: [
      packReport_('Salary Sheet', monthVal, salary.cols, salary.rows),
      packReport_('Final Salary Sheet for Accountant', monthVal, finalSal.cols, finalSal.rows),
      packReport_('Attendance Sheet', monthVal, attendance.header, attendance.rows),
      packReport_('PF Return', monthVal, pfCsv.header, pfCsv.rows),
      packReport_('ESI Return', monthVal, esiCsv.header, esiCsv.rows),
      packReport_('PT Report', monthVal, ptCsv.header, ptCsv.rows)
    ]
  };
}

// How long each report email actually took, on the real sheet.
//
// The build was measured at about 30ms for a 200-person roster before this
// shipped, which is why it is not split across executions — but that was a
// bench, not this company's data. Every run now says how long it took in the
// Apps Script log, so the question is answered by observation rather than by
// anybody's estimate. If "took Ns" ever creeps toward the budget below, that
// is the signal to revisit it, and there will be a number to revisit it with.
function elapsedNote_(startedAt) {
  var ms = Date.now() - startedAt;
  return ms < 1000 ? ms + 'ms' : (Math.round(ms / 100) / 10) + 's';
}

// Apps Script kills an execution at six minutes with no warning and no email,
// so HR would simply never hear from it. These two stop that being the way
// anybody finds out.
//
// The build itself is not the risk: six reports for a 200-person roster is
// about 30ms of arithmetic, measured. What can genuinely run long is reading a
// very large sheet, and what can genuinely fail is Gmail refusing an
// over-sized attachment. Both are caught here and reported as "could not be
// generated" with the reason, rather than the run dying quietly.
var REPORT_BUILD_BUDGET_MS = 240000;   // 4 minutes of the 6, leaving room to send
var MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;   // Gmail's own limit is 25MB

function assertWithinBudget_(startedAt, what) {
  var spent = Date.now() - startedAt;
  if (spent > REPORT_BUILD_BUDGET_MS) {
    throw new Error(what + ' took ' + Math.round(spent / 1000) + 's, past the ' +
      Math.round(REPORT_BUILD_BUDGET_MS / 1000) + 's budget. Stopped before Apps Script ' +
      'would have killed the run without sending anything.');
  }
}

function describeBytes_(n) {
  if (n >= 1048576) return (Math.round(n / 104857.6) / 10) + 'MB';
  if (n >= 1024) return Math.round(n / 1024) + 'KB';
  return n + ' bytes';
}

// Bytes, not characters — a name in a non-Latin script is several bytes a
// letter, and the mail limit is on the wire, not on the string. Counted
// directly rather than by building a Blob just to measure it: measuring should
// not allocate, and this way the guard is plain arithmetic that runs and can be
// tested anywhere, with no Apps Script behind it.
function utf8Bytes_(str) {
  var s = String(str == null ? '' : str), n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }  // surrogate pair
    else n += 3;
  }
  return n;
}

function assertAttachmentsFit_(reports) {
  var total = 0, biggest = null;
  for (var i = 0; i < reports.length; i++) {
    var bytes = utf8Bytes_(reports[i].csv);
    total += bytes;
    if (!biggest || bytes > biggest.bytes) biggest = { label: reports[i].label, bytes: bytes };
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error('The attachments come to ' + describeBytes_(total) + ', over the ' +
      describeBytes_(MAX_ATTACHMENT_BYTES) + ' limit — the largest is ' + biggest.label +
      ' at ' + describeBytes_(biggest.bytes) +
      '. Nothing was sent rather than have the whole email bounce.');
  }
  return total;
}

// Every report in a pack has to be for the month asked for and have something
// in it. One bad report fails the whole pack rather than sending five good
// ones and one that quietly is not what its heading says.
function validateFreshPack_(pack, expectedMonthLabel) {
  if (!pack) throw new Error('The pack builder returned nothing.');
  if (pack.monthLabel !== expectedMonthLabel) {
    throw new Error('Built for ' + pack.monthLabel + ' but ' + expectedMonthLabel + ' was asked for.');
  }
  if (!pack.reports || !pack.reports.length) throw new Error('The pack contains no reports.');
  pack.totalBytes = assertAttachmentsFit_(pack.reports);
  for (var i = 0; i < pack.reports.length; i++) {
    var r = pack.reports[i];
    if (!r.csv || r.csv.split('\n').length < 2) {
      throw new Error(r.label + ' generated with no rows in it.');
    }
    if (r.fileName.indexOf(monthValOf_(expectedMonthLabel)) === -1) {
      throw new Error(r.label + ' would be attached as ' + r.fileName + ', which is not ' + expectedMonthLabel + '.');
    }
  }
  return pack;
}

// 'August 2026' -> '2026-08', for checking a file name against a month label.
function monthValOf_(monthLabel) {
  var parts = String(monthLabel).split(' ');
  var mi = LEAVE_DETAIL_MONTH_NAMES.indexOf(parts[0]);
  return parts[1] + '-' + ('0' + (mi + 1)).slice(-2);
}

// ---- Consultant Report and its Final Summary, generated here and now ----
function buildConsultantPack_(snap, y, m) {
  var startedAt = Date.now();
  var logic = loadSharedReportLogic_(snap.map);
  var monthVal = y + '-' + ('0' + m).slice(-2);
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var dateList = monthDateList_(y, m);
  var monthDays = dateList.length;
  var holidayMap = holidayMapFromSheet_(snap.map);

  // Two different populations on purpose: the wage register is R.S. Infotech's
  // own three headings, the summary adds R.S.IT Solution because PT covers it.
  var detailEmps = logic.consultantReportEmployees(snap.employees, dateList);
  var summaryEmps = logic.consultantSummaryEmployees(snap.employees, dateList);
  var everyone = summaryEmps.slice();
  for (var i = 0; i < detailEmps.length; i++) {
    if (everyone.indexOf(detailEmps[i]) === -1) everyone.push(detailEmps[i]);
  }
  var att = attendanceForMonth_(snap.map, everyone, y, m, holidayMap, logic);

  // Same reason as the pack: the register and the summary both need every
  // salary, and the two populations overlap.
  var detail, totals, register;
  logic.withSalaryCache(function () {
    detail = logic.consultantReportRows(detailEmps, att, dateList, monthDays, holidayMap, y, m);
    totals = logic.consultantSummaryTotals(summaryEmps, att, dateList, monthDays, holidayMap);
    // The wage register in the consultant's own column order, on the same
    // population as the Consultant Report — his register covers the core three
    // headings, not the wider PT group the summary totals.
    register = logic.wageRegisterRows(detailEmps, att, dateList, monthDays, holidayMap, y, m);
  });
  var summary = logic.consultantSummaryCsv(totals);
  assertWithinBudget_(startedAt, 'Building the consultant reports');

  return {
    monthLabel: monthLabel,
    employees: detailEmps.length,
    reports: [
      // consultantCsvRows, not detail.rows: the identifier columns need their
      // Excel marker, and the emailed copy is the one HR opens in Excel. The
      // workbook builder reads that same marker and lays the digits out as
      // text; the CSV keeps the ="..." form, which is what Excel needs there.
      packReport_('Consultant Report', monthVal, detail.cols, logic.consultantCsvRows(detail.rows)),
      packReport_('Consultant Final Summary Report', monthVal, register.cols,
                  consultantSummarySheetRows_(logic, register, summary))
    ]
  };
}

// The Final Summary carries two blocks in one sheet: the wage register, then
// the account-wise summary under it, which is the order the consultant's own
// document puts them in — register pages first, summary last. The register is
// thirty-eight columns and the summary three, so the register sets the width
// and every summary row is padded out to it; otherwise the workbook builder
// sees rows shorter than the header and lays the cells out ragged.
function consultantSummarySheetRows_(logic, register, summary) {
  var width = register.cols.length;
  function pad(row) {
    var out = (row || []).slice();
    while (out.length < width) out.push('');
    return out;
  }
  var rows = logic.wageRegisterCsvRows(register.rows).map(pad);
  rows.push(pad(register.total));
  rows.push(pad([]));
  rows.push(pad(summary.header));
  for (var i = 0; i < summary.rows.length; i++) rows.push(pad(summary.rows[i]));
  return rows;
}

// ---- what every report email checks before it sends anything ----
// The rules, in one place, so a report added later cannot quietly skip them:
// the period is the one that was asked for, the figures were built during this
// run, the file is named for that same period, and there is something in it.
// A failure throws, and the caller reports the error instead of attaching an
// older file.
function validateFreshReport_(report, expectedMonthLabel, expectedFileName) {
  if (!report) throw new Error('The report builder returned nothing.');
  if (report.monthLabel !== expectedMonthLabel) {
    throw new Error('Built for ' + report.monthLabel + ' but ' + expectedMonthLabel + ' was asked for.');
  }
  if (report.fileName !== expectedFileName) {
    throw new Error('Attachment would be named ' + report.fileName + ', expected ' + expectedFileName + '.');
  }
  if (!report.csv || !report.csv.length) throw new Error('The generated report was empty.');
  assertAttachmentsFit_([{ label: expectedFileName, csv: report.csv }]);
  var lines = report.csv.split('\n');
  if (lines.length < 1 || !lines[0]) throw new Error('The generated report has no header row.');
  if (report.csv.indexOf(expectedMonthLabel) === -1 && report.fileName.indexOf(expectedMonthLabel) === -1) {
    throw new Error('Neither the file name nor the contents mention ' + expectedMonthLabel + '.');
  }
  return report;
}

function csvEscape_(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// The leading \uFEFF is a UTF-8 byte order mark, and it is load-bearing on
// Windows. Without it Excel opens a .csv in the system codepage, not UTF-8, so
// every rupee sign arrives as "a,1" and every em dash as "a\u20ac\"" -- which is
// what made the PF and ESI returns unreadable in the Rule Applied column. The
// mark costs three bytes and every other reader ignores it.
function toCsv_(header, rows) {
  var out = [header.map(csvEscape_).join(',')];
  for (var i = 0; i < rows.length; i++) out.push(rows[i].map(csvEscape_).join(','));
  return '\uFEFF' + out.join('\n');
}

// ---- The same figures, as a real Excel workbook ----
//
// A CSV cannot carry a column width. There is nowhere in the format to put one,
// so every report arrived with all twenty columns at Excel's default and the
// consultant widened them by hand, every month, before a single name was
// readable. Nor can a CSV say "this cell is text" except by the ="..." trick
// below, or "this cell is a number Excel may sum".
//
// So the emailed copy is now an .xlsx, built here. The OOXML parts are written
// out and zipped rather than round-tripping through a temporary Google Sheet:
// no temp file to create, delete, and leak in Drive if a run dies halfway, no
// extra Drive scope on this script, and milliseconds instead of seconds apiece
// across ten attachments inside a six-minute budget.
//
// The CSV is still built for every report, unchanged \u2014 it is what the freshness
// checks, the size budget and the Drive copies read. One header and one set of
// rows feed both, so the file that is checked and the file that is sent cannot
// hold different figures.

function xlsxEscape_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Excel refuses to open a file containing raw control characters.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function xlsxColName_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

// A cell the shared logic marked as an identifier by putting it through
// excelIdNumber, which wraps a long digit string as ="102057612761". In a CSV
// that wrapper is the only form Excel reads back as text with the digits
// intact; in an xlsx the cell carries a real text number format, so the wrapper
// would be shown literally and the UAN column would read ="102057612761" \u2014
// worse than the scientific notation it exists to prevent. One marker, two
// renderers: the shared logic goes on saying "this is an identifier" in exactly
// one place, and neither file format has to be told again.
function xlsxUnwrapId_(v) {
  var m = /^="(\d+)"$/.exec(String(v === null || v === undefined ? '' : v));
  return m ? m[1] : null;
}

// A number for Excel only when the cell really is one, so the consultant can
// sum a column of rupees. Blank stays blank, and anything with a letter, a
// comma or a leading zero stays text \u2014 an employee code of 007 must not arrive
// as 7.
function xlsxIsNumber_(v) {
  if (typeof v === 'number') return isFinite(v);
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return false;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return false;
  if (/^-?0\d/.test(s)) return false;
  return String(Number(s)) === s;
}

// Column width in Excel's units, from the widest thing actually in the column.
// Clamped so one long Rule Applied sentence cannot push a column off the screen
// and a one-character column is still wide enough to click.
function xlsxColWidths_(header, rows, minW, maxW) {
  var widths = [];
  var consider = function (i, v) {
    var id = xlsxUnwrapId_(v);
    var len = String(id === null ? (v === null || v === undefined ? '' : v) : id).length;
    if (!(widths[i] > len)) widths[i] = len;
  };
  (header || []).forEach(function (h, i) { consider(i, h); });
  (rows || []).forEach(function (r) { (r || []).forEach(function (c, i) { consider(i, c); }); });
  return widths.map(function (w) {
    return Math.min(maxW, Math.max(minW, (w || 0) + 2));
  });
}

// header: array of column names. rows: array of arrays. Returns the OOXML parts
// of a one-sheet workbook, each { path, content }, in the order they must be
// zipped. Identifier columns need no argument here \u2014 they are recognised by
// excelIdNumber's own marker, whichever column they land in.
function xlsxParts_(sheetName, header, rows) {
  var widths = xlsxColWidths_(header, rows, 8, 60);

  var cols = widths.map(function (w, i) {
    return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w.toFixed(2) +
           '" customWidth="1"/>';
  }).join('');

  var cell = function (rowNum, colIdx, value, styleId) {
    var ref = xlsxColName_(colIdx + 1) + rowNum;
    var id = xlsxUnwrapId_(value);
    if (id !== null) { value = id; styleId = 2; }   // style 2 = text format
    var s = styleId ? ' s="' + styleId + '"' : '';
    if (value === null || value === undefined || value === '') return '<c r="' + ref + '"' + s + '/>';
    if (id === null && xlsxIsNumber_(value)) {
      return '<c r="' + ref + '"' + s + '><v>' + Number(value) + '</v></c>';
    }
    // Inline strings, so there is no sharedStrings.xml to keep in step.
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' +
           xlsxEscape_(value) + '</t></is></c>';
  };

  var body = '<row r="1">' + (header || []).map(function (h, i) {
    return cell(1, i, h, 1);                        // style 1 = bold header
  }).join('') + '</row>';

  (rows || []).forEach(function (r, ri) {
    var n = ri + 2;
    body += '<row r="' + n + '">' + (r || []).map(function (c, i) {
      return cell(n, i, c, 0);
    }).join('') + '</row>';
  });

  var lastCol = xlsxColName_(Math.max(1, (header || []).length));
  var sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:' + lastCol + Math.max(1, (rows || []).length + 1) + '"/>' +
    '<sheetViews><sheetView workbookViewId="0">' +
    // The header stays put while a 200-row sheet scrolls, so column 14 is still
    // identifiable at row 150.
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? '<cols>' + cols + '</cols>' : '') +
    '<sheetData>' + body + '</sheetData></worksheet>';

  var styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // Excel's own limits on a sheet tab name: 31 characters, and none of \ / ? * [ ] :
  var safeName = String(sheetName || 'Sheet1').replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Sheet1';

  return [
    { path: '[Content_Types].xml', content:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>' },
    { path: '_rels/.rels', content:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>' },
    { path: 'xl/workbook.xml', content:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + xlsxEscape_(safeName) + '" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>' },
    { path: 'xl/_rels/workbook.xml.rels', content:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>' },
    { path: 'xl/styles.xml', content: styles },
    { path: 'xl/worksheets/sheet1.xml', content: sheet }
  ];
}

// An .xlsx is a zip of those parts, and Utilities.zip takes each blob's name as
// its entry path \u2014 slashes included \u2014 which is the whole reason this can be
// done without a library. [Content_Types].xml goes first because some readers
// expect it there.
function xlsxBytes_(sheetName, header, rows) {
  var parts = xlsxParts_(sheetName, header, rows);
  var blobs = [];
  for (var i = 0; i < parts.length; i++) {
    blobs.push(Utilities.newBlob(parts[i].content, 'application/xml', parts[i].path));
  }
  return Utilities.zip(blobs).getBytes();
}

var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// The name the attachment actually arrives under. report.fileName stays the
// .csv name every report has always filed under in Drive, so the Drive copy and
// the emailed copy are still recognisably the same report \u2014 only the extension
// differs, because only one of the two can carry column widths.
function attachmentName_(report) {
  return String(report.fileName).replace(/\.csv$/i, '') + '.xlsx';
}

// If anything goes wrong assembling the workbook, attach the CSV instead of
// letting the whole email fail. This runs OUTSIDE the try/catch that guards the
// report build, so an exception here would mean HR got no email at all on the
// month-end run — not even the "could not be generated" one that names the reason. A CSV
// with unhelpful column widths is a far better outcome than silence, and the
// reason is in the log either way.
function reportAttachment_(report) {
  try {
    return Utilities.newBlob(xlsxBytes_(report.label, report.sheet.header, report.sheet.rows),
                             XLSX_MIME, attachmentName_(report));
  } catch (e) {
    Logger.log('The workbook for ' + report.label + ' could not be built (' +
      (e && e.message ? e.message : e) + '), so the CSV was attached instead.');
    return Utilities.newBlob(report.csv, 'text/csv', report.fileName);
  }
}

var MONTHLY_REPORTS_EMAIL = 'rasesh@rsinfotech.net';
var MONTHLY_REPORTS_HOUR = 8; // 8 AM IST on MONTHLY_EMAIL_DAY

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
    MONTHLY_REPORTS_HOUR + ':00 IST and emails only on the ' + monthlyEmailDayLabel_() + '.');
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

// force=true sends regardless of the date, for testing from the editor.
function sendMonthlyReportsEmail(force) {
  var runStartedAt = Date.now();
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== MONTHLY_EMAIL_DAY) return;

  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  // All six built here, from the live sheet. This used to walk Drive for
  // whichever CSV each report had last filed when HR opened it, attach what it
  // found and list by name what it did not — so the pack was only as complete,
  // and only as current, as HR's habit of opening reports.
  var pack = null, failure = null;
  try {
    pack = validateFreshPack_(buildMonthlyReportPack_(reportDataSnapshot_(), y, m), monthLabel);
  } catch (e) {
    failure = e && e.message ? e.message : String(e);
    Logger.log('Monthly report pack for ' + monthLabel + ' could not be generated: ' + failure);
  }

  var subject, plain, html, attachments = [];
  if (pack) {
    for (var i = 0; i < pack.reports.length; i++) {
      attachments.push(reportAttachment_(pack.reports[i]));
    }
    subject = 'R.S. Infotech — Monthly Reports — ' + monthLabel;
    var generatedAt = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm');
    var intro = 'Attached are the ' + pack.reports.length + ' monthly reports for ' + monthLabel +
      ', covering ' + pack.employees + ' employee(s) on roll during that month.';
    // All six off one set of figures, so the Salary Sheet and the PF return in
    // this email cannot disagree about anybody's basic.
    var same = 'All six were generated together at ' + generatedAt + ' from the current records, ' +
      'off the same salary calculation, so they agree with each other and with what the app shows.';
    html = '<p>' + esc(intro) + '</p><p>' + esc(same) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><th align="left">Report</th><th align="left">File</th><th align="right">Rows</th></tr>';
    for (var j = 0; j < pack.reports.length; j++) {
      html += '<tr><td>' + esc(pack.reports[j].label) + '</td><td>' + esc(attachments[j].getName()) +
        '</td><td align="right">' + (pack.reports[j].csv.split('\n').length - 1) + '</td></tr>';
    }
    html += '</table>';
    plain = intro + '\n\n' + same + '\n\n';
    for (var k = 0; k < pack.reports.length; k++) {
      plain += '  ' + pack.reports[k].label + '\n    ' + pack.reports[k].fileName + '\n';
    }
  } else {
    // No partial pack and no older copies. Five right reports and one stale
    // one is worse than none, because nothing on the email says which is which.
    subject = 'R.S. Infotech — Monthly Reports — ' + monthLabel + ' could not be generated';
    var none = 'The monthly reports for ' + monthLabel + ' could not be generated, so nothing is ' +
      'attached. No older copies have been sent in their place.';
    var why = 'Reason: ' + failure;
    html = '<p>' + esc(none) + '</p><p>' + esc(why) + '</p>';
    plain = none + '\n\n' + why + '\n';
  }

  MailApp.sendEmail({
    to: MONTHLY_REPORTS_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Monthly report pack for ' + monthLabel + ' sent to ' + MONTHLY_REPORTS_EMAIL +
    ' — ' + (pack ? pack.reports.length + ' generated fresh and attached, ' +
      describeBytes_(pack.totalBytes) : 'FAILED: ' + failure) +
    ', in ' + elapsedNote_(runStartedAt) + '.');
}

// ===== Loan and EMI Report, emailed separately on MONTHLY_EMAIL_DAY =====
//
// Its own email rather than a sixth attachment on the pack above, because it is
// a different kind of thing and reads wrongly filed next to the other five.
// Those are five views of one closed month; this is a running position that
// belongs to no month at all.
//
// A loan balance moves with every month's EMI, so which day it is a position
// FOR matters more here than anywhere else in these emails. This one is built
// at send time for the end of the month just ended — the moment that month's
// payroll was finished — rather than being whatever snapshot HR last happened
// to take in the app. That is what it used to attach, and why a report could
// arrive looking perfectly valid while its balances were a month behind.
//
// The app still files its own copy under "Loan & Advance Report - <date>.csv",
// with the run date in the name, and that name is unchanged. Only what HR
// receives by email is called the Loan and EMI Report.
//
// As everywhere else in these emails, nothing is recalculated here: loansOf,
// loanScheduleThrough and loanEmiRateAsOf live in shared/report-logic.js and
// stay the only place that arithmetic happens.
var LOAN_REPORT_EMAIL = 'rasesh@rsinfotech.net';
var LOAN_REPORT_HOUR = 8; // 8 AM IST, alongside the report pack

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
    LOAN_REPORT_HOUR + ':00 IST and emails only on the ' + monthlyEmailDayLabel_() + '.');
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

// force=true sends regardless of the date, for testing from the editor.
function sendLoanAdvanceReportEmail(force) {
  var runStartedAt = Date.now();
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== MONTHLY_EMAIL_DAY) return;

  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var fileName = 'Loan and EMI Report - ' + monthLabel + '.csv';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  // Worked out here from the live records. This used to hunt Drive for the
  // newest CSV the app had filed and attach that, labelled with how many days
  // old it was — because a loan balance is only true for the day it was taken
  // and an old one reads as current. There is no old one now: it is the
  // position at the end of the month being reported on, computed at send time.
  var report = null, failure = null;
  try {
    report = validateFreshReport_(buildLoanAdvanceReport_(reportDataSnapshot_(), y, m), monthLabel, fileName);
  } catch (e) {
    failure = e && e.message ? e.message : String(e);
    Logger.log('Loan and EMI Report for ' + monthLabel + ' could not be generated: ' + failure);
  }

  var subject, plain, html, attachments = [];
  if (report) {
    attachments.push(reportAttachment_(report));
    subject = 'R.S. Infotech — Loan and EMI Report — ' + monthLabel;
    var generatedAt = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm');
    var lead = 'Attached is the Loan and EMI Report for ' + monthLabel + ' — the position as it ' +
      'stood at the end of that month, once that month\u2019s instalments had come off.';
    var figures = rupeesIn_(report.outstanding) + ' outstanding across ' + report.rows.length + ' loan(s).';
    var warn = report.stalled
      ? report.stalled + ' active loan(s) have no recovery month set, so no instalment is coming off ' +
        'the Salary Sheet for them. Set one on the employee record to start recovery.'
      : '';
    var freshness = 'Generated ' + generatedAt + ' from the current records.';
    html = '<p>' + esc(lead) + '</p><p>' + esc(figures) + '</p>' +
      (warn ? '<p style="color:#B00020"><strong>' + esc(warn) + '</strong></p>' : '') +
      '<p>' + esc(freshness) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><td><strong>Month</strong></td><td>' + esc(monthLabel) + '</td></tr>' +
      '<tr><td><strong>File</strong></td><td>' + esc(attachments[0].getName()) + '</td></tr>' +
      '<tr><td><strong>Loans</strong></td><td>' + report.rows.length + '</td></tr>' +
      '<tr><td><strong>Outstanding</strong></td><td>' + esc(rupeesIn_(report.outstanding)) + '</td></tr>' +
      '<tr><td><strong>Generated</strong></td><td>' + esc(generatedAt) + '</td></tr>' +
      '</table>';
    plain = lead + '\n\n' + figures + '\n' + (warn ? warn + '\n' : '') + '\n' + freshness + '\n\n' +
      '  Month      : ' + monthLabel + '\n' +
      '  File       : ' + attachments[0].getName() + '\n' +
      '  Loans      : ' + report.rows.length + '\n' +
      '  Outstanding: ' + rupeesIn_(report.outstanding) + '\n' +
      '  Generated  : ' + generatedAt + '\n';
  } else {
    subject = 'R.S. Infotech — Loan and EMI Report — ' + monthLabel + ' could not be generated';
    var none = 'The Loan and EMI Report for ' + monthLabel + ' could not be generated, so nothing ' +
      'is attached. No older snapshot has been sent in its place — an out-of-date loan balance reads ' +
      'as a current one.';
    var why = 'Reason: ' + failure;
    html = '<p>' + esc(none) + '</p><p>' + esc(why) + '</p>';
    plain = none + '\n\n' + why + '\n';
  }

  MailApp.sendEmail({
    to: LOAN_REPORT_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Loan and EMI Report email for ' + monthLabel + ' sent to ' + LOAN_REPORT_EMAIL +
    ' — ' + (report ? 'generated fresh and attached' : 'FAILED: ' + failure) +
    ', in ' + elapsedNote_(runStartedAt) + '.');
}

// ===== Monthly Leave Detail Report, emailed separately on MONTHLY_EMAIL_DAY =====
//
// Like the report pack this is a closed month's report, so there is a definite
// "last month's file" to look for — unlike the Loan and EMI Report, which is
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
var LEAVE_DETAIL_HOUR = 8; // 8 AM IST on MONTHLY_EMAIL_DAY

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
    'around ' + LEAVE_DETAIL_HOUR + ':00 IST and emails only on the ' + monthlyEmailDayLabel_() + '.');
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
  var runStartedAt = Date.now();
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== MONTHLY_EMAIL_DAY) return;

  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var fileName = 'Monthly Leave Detail Report - ' + monthLabel + '.csv';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  // Built here, from the live sheet, every time this runs. It used to attach
  // whichever CSV the app had last filed in Drive, which meant the email was
  // only as fresh as the last time somebody happened to open the report — and
  // said nothing at all if nobody ever had.
  var report = null, failure = null;
  try {
    report = validateFreshReport_(buildLeaveDetailReport_(reportDataSnapshot_(), y, m), monthLabel, fileName);
  } catch (e) {
    failure = e && e.message ? e.message : String(e);
    Logger.log('Monthly Leave Detail report for ' + monthLabel + ' could not be generated: ' + failure);
  }

  var subject, plain, html, attachments = [];
  if (report) {
    attachments.push(reportAttachment_(report));
    subject = 'R.S. Infotech — Monthly Leave Detail Report — ' + monthLabel;
    var generatedAt = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm');
    var lead = 'Attached is the Monthly Leave Detail Report for ' + monthLabel + '.';
    var note = report.rows.length
      ? report.rows.length + ' of ' + report.onRoll + ' on-roll employees had leave, a half day, ' +
        'short leave or late coming in ' + monthLabel + '. Anyone with a clean month is not listed.'
      : 'Nobody took any leave, half day, short leave or late coming in ' + monthLabel +
        ' — all ' + report.onRoll + ' on-roll employees were clear.';
    // No "reopen it in the app" caveat any more: this was worked out just now
    // from the live records, so it already includes every correction made up
    // to this minute.
    var freshness = 'Generated ' + generatedAt + ' from the current records, so it includes any ' +
      'leave recorded or corrected since the month ended.';
    html = '<p>' + esc(lead) + '</p><p>' + esc(note) + '</p><p>' + esc(freshness) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><td><strong>Month</strong></td><td>' + esc(monthLabel) + '</td></tr>' +
      '<tr><td><strong>File</strong></td><td>' + esc(attachments[0].getName()) + '</td></tr>' +
      '<tr><td><strong>Employees listed</strong></td><td>' + report.rows.length + ' of ' + report.onRoll + '</td></tr>' +
      '<tr><td><strong>Generated</strong></td><td>' + esc(generatedAt) + '</td></tr>' +
      '</table>';
    plain = lead + '\n\n' + note + '\n\n' + freshness + '\n\n' +
      '  Month            : ' + monthLabel + '\n' +
      '  File             : ' + attachments[0].getName() + '\n' +
      '  Employees listed : ' + report.rows.length + ' of ' + report.onRoll + '\n' +
      '  Generated        : ' + generatedAt + '\n';
  } else {
    // Deliberately no fallback to an older file. Sending last month's figures
    // under this month's heading is worse than sending nothing, because it
    // looks right.
    subject = 'R.S. Infotech — Monthly Leave Detail Report — ' + monthLabel + ' could not be generated';
    var none = 'The Monthly Leave Detail Report for ' + monthLabel + ' could not be generated, so ' +
      'nothing is attached. No older report has been sent in its place.';
    var why = 'Reason: ' + failure;
    html = '<p>' + esc(none) + '</p><p>' + esc(why) + '</p>';
    plain = none + '\n\n' + why + '\n';
  }

  MailApp.sendEmail({
    to: LEAVE_DETAIL_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Monthly Leave Detail report email for ' + monthLabel + ' sent to ' + LEAVE_DETAIL_EMAIL +
    ' — ' + (report ? 'generated fresh and attached' : 'FAILED: ' + failure) +
    ', in ' + elapsedNote_(runStartedAt) + '.');
}

// ===== Consultant Report, emailed separately on MONTHLY_EMAIL_DAY =====
//
// Sent with every other month-end email on MONTHLY_EMAIL_DAY. That day is a
// clear one after month end, which leaves room for the last attendance and
// payroll corrections before anything reaches the consultant — the figures are
// built fresh at send time, so a later day means later corrections are in them.
//
// Two files, not one. The Consultant Report and the Consultant Final Summary
// Report are a matched pair for the same reader — the per-employee detail and
// the totals that summarise it — and a consultant sent one without the other
// generally asks for the other. Both are attached when both exist; drop the
// summary from CONSULTANT_REPORT_SPECS_ if only the detail is wanted.
var CONSULTANT_REPORT_EMAIL = 'rasesh@rsinfotech.net';
// This had a CONSULTANT_REPORT_DAY of its own, from when it was the only one
// that did not go out with the rest. It moves with them now, so the day comes
// from MONTHLY_EMAIL_DAY and there is one number to change rather than two that
// can disagree.
var CONSULTANT_REPORT_HOUR = 8; // 8 AM IST on MONTHLY_EMAIL_DAY

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
    CONSULTANT_REPORT_HOUR + ':00 IST and emails only on the ' + monthlyEmailDayLabel_() +
    ', reporting the previous month.');
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

// force=true sends regardless of the date, for testing from the editor.
function sendConsultantReportEmail(force) {
  var runStartedAt = Date.now();
  var istToday = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(istToday.slice(8, 10)) !== MONTHLY_EMAIL_DAY) return;

  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var monthLabel = LEAVE_DETAIL_MONTH_NAMES[m - 1] + ' ' + y;
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  // Both built here from the live sheet. They used to be whatever the app had
  // last filed in Drive, so the consultant's wage register could be a month
  // behind the payroll it was supposed to describe.
  var pack = null, failure = null;
  try {
    pack = validateFreshPack_(buildConsultantPack_(reportDataSnapshot_(), y, m), monthLabel);
  } catch (e) {
    failure = e && e.message ? e.message : String(e);
    Logger.log('Consultant reports for ' + monthLabel + ' could not be generated: ' + failure);
  }

  var subject, plain, html, attachments = [];
  if (pack) {
    for (var i = 0; i < pack.reports.length; i++) {
      attachments.push(reportAttachment_(pack.reports[i]));
    }
    subject = 'R.S. Infotech — Consultant Reports — ' + monthLabel;
    var generatedAt = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm');
    var intro = 'Attached are the Consultant Report and its Final Summary for ' + monthLabel +
      ', covering ' + pack.employees + ' employee(s) on the R.S. Infotech payroll headings.';
    var same = 'Both were generated at ' + generatedAt + ' from the current records, off the same ' +
      'salary calculation the app uses, so the wage register and the summary agree with each ' +
      'other and with the Salary Sheet.';
    html = '<p>' + esc(intro) + '</p><p>' + esc(same) + '</p>' +
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;' +
      'font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><th align="left">Report</th><th align="left">File</th><th align="right">Rows</th></tr>';
    for (var j = 0; j < pack.reports.length; j++) {
      html += '<tr><td>' + esc(pack.reports[j].label) + '</td><td>' + esc(attachments[j].getName()) +
        '</td><td align="right">' + (pack.reports[j].csv.split('\n').length - 1) + '</td></tr>';
    }
    html += '</table>';
    plain = intro + '\n\n' + same + '\n\n';
    for (var k = 0; k < pack.reports.length; k++) {
      plain += '  ' + pack.reports[k].label + '\n    ' + pack.reports[k].fileName + '\n';
    }
  } else {
    subject = 'R.S. Infotech — Consultant Reports — ' + monthLabel + ' could not be generated';
    var none = 'The Consultant Report and Final Summary for ' + monthLabel + ' could not be ' +
      'generated, so nothing is attached. No older copies have been sent in their place — a ' +
      'wage register for the wrong month is worse than none, because it looks right.';
    var why = 'Reason: ' + failure;
    html = '<p>' + esc(none) + '</p><p>' + esc(why) + '</p>';
    plain = none + '\n\n' + why + '\n';
  }

  MailApp.sendEmail({
    to: CONSULTANT_REPORT_EMAIL,
    subject: subject,
    body: plain,
    htmlBody: html,
    attachments: attachments
  });
  Logger.log('Consultant reports for ' + monthLabel + ' sent to ' + CONSULTANT_REPORT_EMAIL +
    ' — ' + (pack ? pack.reports.length + ' generated fresh and attached, ' +
      describeBytes_(pack.totalBytes) : 'FAILED: ' + failure) +
    ', in ' + elapsedNote_(runStartedAt) + '.');
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
// its date check sees a day that is not MONTHLY_EMAIL_DAY, and it returns silently having
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
  run('Increments due this month', function () { sendIncrementReminderEmail(true); });
  run('Birthday reminder (sends only if a birthday is tomorrow)', function () { sendBirthdayReminderEmail(); });
  run('Monthly report pack', function () { sendMonthlyReportsEmail(true); });
  run('Loan and EMI Report', function () { sendLoanAdvanceReportEmail(true); });
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
    ['sendIncrementReminderEmail', 'Increments due this month — ' + monthlyEmailDayLabel_()],
    ['sendBirthdayReminderEmail', 'Birthday reminder — day before'],
    ['sendMonthlyReportsEmail', 'Report pack — ' + monthlyEmailDayLabel_()],
    ['sendLoanAdvanceReportEmail', 'Loan and EMI Report — ' + monthlyEmailDayLabel_()],
    ['sendLeaveDetailReportEmail', 'Monthly Leave Detail Report — ' + monthlyEmailDayLabel_()],
    ['sendConsultantReportEmail', 'Consultant Report — ' + monthlyEmailDayLabel_()],
    ['sendSalaryAdvanceAlertEmail', 'Salary advance taken — same evening'],
    ['sendMonthlyAdvanceSummaryEmail', 'Salary advances for last month — ' + monthlyEmailDayLabel_()]
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
// monthly email here runs on MONTHLY_EMAIL_DAY and looks back a month; this one
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
var ADVANCE_SUMMARY_HOUR = 20; // 8 PM IST on MONTHLY_EMAIL_DAY, for the month just ended

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
    'around ' + ADVANCE_SUMMARY_HOUR + ':00 IST and emails only on the ' + monthlyEmailDayLabel_() +
    ', for the month just gone.');
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

// force=true sends regardless of the date, for testing from the editor.
//
// MONTHLY_EMAIL_DAY, for the month just gone, in line with every other report.
// This used to send on the LAST day of the month about that same month, which
// meant it went out before the month had finished — an advance paid on the 31st
// after the 8 AM run missed its own summary and never appeared in a later one.
// Reporting the completed month a day later cannot miss anything.
function sendMonthlyAdvanceSummaryEmail(force) {
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  if (!force && Number(today.slice(8, 10)) !== MONTHLY_EMAIL_DAY) return;

  // prevMonthYmIst_ is the one place every monthly email works out its period,
  // so this cannot drift from the others or get the December rollover wrong.
  var ym = prevMonthYmIst_();
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
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
      // Paid out in this month: by the day it was entered where that is
      // recorded, and otherwise by the month it belongs to. The fallback
      // matters -- an advance carrying no addedOn (entered before the stamp
      // existed) was counted under Recovered but not under Paid out, so the
      // same 3,000 made the email's own two halves disagree. Same money, two
      // sections, one of them silently short.
      var addedYm = h.addedOn ? String(h.addedOn).slice(0, 7) : '';
      if (addedYm ? addedYm === ym : h.month === ym) paidOut.push(who);
      if (h.month === ym) {
        recovered.push(who);
        // Still counted, so the email can say how many entries are dated only
        // by their month rather than by the day they were entered.
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

// ===== Performance diagnosis =====
//
// Run from the editor and read the log. It measures the real sheet rather than
// guessing: how many rows, how much text, which keys are the heavy ones, how
// many stale sessions have piled up, and how long the operations on the save
// path actually take against this data.
//
// Everything here is read-only — it changes nothing and is safe to run at any
// time, including while HR is working.
function diagnosePerformance() {
  var out = [];
  var t0 = Date.now();

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  out.push('Opened spreadsheet in ' + (Date.now() - t0) + ' ms');

  // ---- The KV sheet: rows, total size, and the worst offenders ----
  var sheet = ss.getSheetByName(SHEET_NAME);
  var tRead = Date.now();
  var data = sheet.getDataRange().getValues();
  var fullReadMs = Date.now() - tRead;

  var totalChars = 0, sizes = [];
  for (var i = 1; i < data.length; i++) {
    var len = String(data[i][1] == null ? '' : data[i][1]).length;
    totalChars += len;
    sizes.push({ key: String(data[i][0]), len: len });
  }
  sizes.sort(function (a, b) { return b.len - a.len; });

  out.push('');
  out.push('KV sheet');
  out.push('  Rows                : ' + (data.length - 1));
  out.push('  Total value size    : ' + Math.round(totalChars / 1024) + ' KB');
  out.push('  Whole-sheet read    : ' + fullReadMs + ' ms   <- what findRow_ used to cost, per call');

  var tCol = Date.now();
  var lastRow = sheet.getLastRow();
  sheet.getRange(1, 1, lastRow, 1).getValues();
  var colReadMs = Date.now() - tCol;
  out.push('  Key-column read     : ' + colReadMs + ' ms   <- what findRow_ costs now');
  if (fullReadMs > 0) {
    out.push('  Saved per lookup    : ' + (fullReadMs - colReadMs) + ' ms (' +
      Math.round((1 - (colReadMs / fullReadMs)) * 100) + '% less)');
  }

  out.push('');
  out.push('  Ten largest values:');
  for (var s = 0; s < Math.min(10, sizes.length); s++) {
    out.push('    ' + (Math.round(sizes[s].len / 1024) + ' KB').padStart(8) + '  ' + sizes[s].key);
  }
  // The one hard ceiling in this design: a Sheets cell holds 50,000 characters.
  // Only worth warning about for a key the app still WRITES — a dead key cannot
  // grow, so reporting it as "about to fail to save" is a false alarm.
  // DEAD_KEYS are ones nothing reads or writes any more; they still cost on
  // every whole-sheet read, which is why they are reported separately.
  var DEAD_KEYS = { 'employees': 'replaced by the employee:<id> keys at migration' };
  var nearLimit = sizes.filter(function (x) { return x.len > 40000 && !DEAD_KEYS[x.key]; });
  if (nearLimit.length) {
    out.push('');
    out.push('  WARNING — ' + nearLimit.length + ' live value(s) are over 40,000 of the');
    out.push('  50,000 characters a cell can hold. These will start failing to save:');
    nearLimit.forEach(function (x) { out.push('    ' + x.len + '  ' + x.key); });
  }
  var dead = sizes.filter(function (x) { return DEAD_KEYS[x.key]; });
  if (dead.length) {
    var deadChars = 0;
    dead.forEach(function (x) { deadChars += x.len; });
    out.push('');
    out.push('  Dead weight — ' + Math.round(deadChars / 1024) + ' KB (' +
      Math.round(deadChars / totalChars * 100) + '% of the sheet) nothing reads or writes.');
    out.push('  Costs nothing on a save, but is carried by every whole-sheet read:');
    dead.forEach(function (x) {
      out.push('    ' + (Math.round(x.len / 1024) + ' KB').padStart(8) + '  ' + x.key +
        '  — ' + DEAD_KEYS[x.key]);
    });
    out.push('  Remove with removeLegacyEmployeesKey (checks first, keeps a backup).');
  }

  // ---- The SESSIONS sheet: the cost every single request pays ----
  var sess = ss.getSheetByName(SESSION_SHEET_NAME);
  if (sess) {
    var tSess = Date.now();
    var sdata = sess.getDataRange().getValues();
    var sessReadMs = Date.now() - tSess;
    var now = Date.now(), live = 0, expired = 0;
    for (var j = 1; j < sdata.length; j++) {
      if (Number(sdata[j][3]) >= now) live++; else expired++;
    }
    out.push('');
    out.push('SESSIONS sheet   (read and scanned on EVERY request)');
    out.push('  Rows                : ' + (sdata.length - 1));
    out.push('  Live                : ' + live);
    out.push('  Expired, removable  : ' + expired);
    out.push('  Read time           : ' + sessReadMs + ' ms');
    if (expired > 50) {
      out.push('  These are cleared on the next login, or run purgeExpiredSessionsNow.');
    }
  }

  // ---- What a single save costs end to end ----
  var probeKey = 'hr_password';
  var tFind = Date.now();
  var rowFound = findRow_(sheet, probeKey);
  var findMs = Date.now() - tFind;
  out.push('');
  out.push('Save path');
  out.push('  findRow_ (one key)  : ' + findMs + ' ms');
  if (rowFound !== -1) {
    var tCell = Date.now();
    sheet.getRange(rowFound, 2).getValue();
    out.push('  read one cell       : ' + (Date.now() - tCell) + ' ms');
  }
  out.push('');
  out.push('Total diagnosis time  : ' + (Date.now() - t0) + ' ms');

  Logger.log(out.join('\n'));
}

// Prunes the SESSIONS sheet immediately instead of waiting for the next login:
// every expired row, plus any login beyond the newest MAX_SESSIONS_PER_USER a
// person holds. Expired rows are already refused, so those cost nobody
// anything; someone over the cap on a device they have not used lately signs in
// again once. Run it now to get the benefit without waiting.
function purgeExpiredSessionsNow() {
  var removed = purgeExpiredSessions_(getSessionSheet_());
  Logger.log('Removed ' + removed + ' session row(s) — expired, plus any past the newest ' +
    MAX_SESSIONS_PER_USER + ' per person.');
}

// Removes the pre-migration `employees` row: one 40 KB blob holding every
// employee record, from before they were split into employee:<id> keys.
//
// Nothing reads it — index.html intercepts a read of 'employees' and serves it
// from the per-record keys instead — and nothing writes it, so it is stale the
// moment any employee is edited. It still gets fetched by every whole-sheet
// read in the backend: getAllEmployees, setMany, the attendance range reads,
// the digest and every report email.
//
// Refuses to run unless the per-record keys are actually there and at least as
// numerous, so it cannot delete the only copy of anything, and writes what it
// removed to a `employees_backup_removed` row rather than dropping it outright.
function removeLegacyEmployeesKey() {
  var sheet = getSheet_();
  var rows = sheet.getDataRange().getValues();
  var legacyRow = -1, legacyValue = '', perRecord = 0;
  for (var i = 1; i < rows.length; i++) {
    var k = String(rows[i][0]);
    if (k === 'employees') { legacyRow = i + 1; legacyValue = String(rows[i][1] || ''); }
    else if (k.indexOf('employee:') === 0) perRecord++;
  }
  if (legacyRow === -1) { Logger.log('No legacy `employees` row — nothing to do.'); return; }

  var legacyCount = 0;
  try { legacyCount = (JSON.parse(legacyValue) || []).length; } catch (e) { legacyCount = -1; }
  if (perRecord === 0 || (legacyCount > 0 && perRecord < legacyCount)) {
    Logger.log('REFUSED — the legacy row holds ' + legacyCount + ' employee(s) but only ' +
      perRecord + ' employee:<id> key(s) exist. Run migrateEmployeesToPerRecordKeys first.');
    return;
  }
  saveFile_(['HR Management'], 'employees-legacy-backup-' +
    Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd') + '.json',
    legacyValue, 'application/json');
  sheet.deleteRow(legacyRow);
  Logger.log('Removed the legacy `employees` row (' + Math.round(legacyValue.length / 1024) +
    ' KB, ' + legacyCount + ' record(s)); ' + perRecord + ' employee:<id> keys remain. ' +
    'A copy was saved to Drive under HR Management.');
}
