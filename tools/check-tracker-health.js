// What HR is told about an engineer's phone.
//
// Two things are being guarded. Every signal here was already being collected
// and almost none of it reached HR, so the assertions are mostly about a
// problem actually producing a warning rather than a line of grey text. And
// the ordering: when two things are wrong at once, HR should be told the one
// worth acting on, and a phone at 3% outranks being outside a geofence.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({trackerStatus, notCheckedInToday, TRACKER_HEALTH})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const NOW = Date.parse('2026-09-06T11:00:00Z');
const fresh = extra => Object.assign({
  lastHeartbeat: NOW - 5000, lastFixTime: NOW - 5000,
  battery: { level: 80, charging: false }, geofenceStatus: 'inside'
}, extra || {});

// ------------------------------------------------------------- nothing wrong
console.log('a phone that is behaving\n');
{
  const s = L.trackerStatus(fresh(), NOW);
  check('reads as live', [s.level, s.key], ['ok', 'live']);
  // Battery was buried in a card nobody reads. On a healthy phone it belongs
  // in the same line as everything else that is fine.
  check('and still says what the battery is', /battery 80%/.test(s.detail), true);
}
{
  const s = L.trackerStatus(null, NOW);
  check('nobody checked in is idle, not a fault', [s.level, s.key], ['idle', 'idle']);
}

// --------------------------------------------------------------- the battery
console.log('\nthe battery, which HR could not see at all before\n');
{
  const s = L.trackerStatus(fresh({ battery: { level: 12, charging: false } }), NOW);
  check('a low battery is a warning, not grey text', s.level, 'warn');
  check('and the percentage is in the label, where it is visible',
        [s.key, s.label], ['battery-low', 'battery 12%']);
}
{
  const s = L.trackerStatus(fresh({ battery: { level: 3, charging: false } }), NOW);
  check('a nearly-dead phone is called out separately', s.key, 'battery-critical');
  check('and says what is about to be lost', /will not be recorded/.test(s.detail), true);
}
{
  // Charging at 4% is a phone getting better, not a problem to ring somebody
  // about. Warning on it would train HR to ignore the warning.
  check('a low battery that is charging is not a warning',
        L.trackerStatus(fresh({ battery: { level: 4, charging: true } }), NOW).level, 'ok');
}
{
  // Plenty of browsers do not implement the Battery API. A missing reading is
  // not a flat battery, and must never be scored as one.
  const s = L.trackerStatus(fresh({ battery: null }), NOW);
  check('a device that does not report battery is not treated as empty', s.level, 'ok');
  check('and nothing is invented about it', /battery/.test(s.detail), false);
}

// ------------------------------------------------------------------ location
console.log('\nlocation off, against a weak signal\n');
{
  const s = L.trackerStatus(fresh({ gpsErrorCode: 1,
    gpsError: 'Location permission denied or GPS turned off' }), NOW);
  // The engineer can fix this himself in ten seconds, which is why it is
  // separated from a signal problem he can do nothing about.
  check('location being switched off is its own status', s.key, 'location-off');
  check('and says distance is not being recorded', /not being recorded/.test(s.detail), true);
}
{
  const s = L.trackerStatus(fresh({ gpsError: 'Location unavailable (GPS off or no signal)' }), NOW);
  check('a signal problem reads differently', [s.key, s.label], ['gps-error', 'no GPS signal']);
}
{
  const s = L.trackerStatus(fresh({ lastFixTime: NOW - 10 * 60000 }), NOW);
  check('a stale fix while still reporting is a weak signal', s.key, 'no-fix');
  // The distinction that stops HR ringing somebody whose phone is fine.
  check('and says the app has not stopped', /still.*reporting/.test(s.detail), true);
}

// ------------------------------------------------------------------- silence
console.log('\nwhen the app goes quiet\n');
{
  const s = L.trackerStatus(fresh({ lastHeartbeat: NOW - 20 * 60000 }), NOW);
  check('silence is a warning', [s.level, s.key], ['warn', 'no-contact']);
  // The honest bit. The old wording named two causes and left out the third,
  // and no wording can name the right one — the server cannot tell them apart.
  check('all three causes are named, none of them claimed',
        /switched off/.test(s.detail) && /out of network range/.test(s.detail) &&
        /app has been closed/.test(s.detail), true);
  check('and it says how long', /20 min/.test(s.detail), true);
}
{
  // The one case where it CAN be narrowed: the app said it had no data
  // connection just before it stopped being heard from.
  const s = L.trackerStatus(fresh({ lastHeartbeat: NOW - 20 * 60000, online: false }), NOW);
  check('an app that reported being offline first is named as lost signal',
        [s.key, s.label], ['no-contact', 'lost signal']);
  check('and HR is told it should recover on its own',
        /catch up by itself/.test(s.detail), true);
}
{
  // Never heard from at all — must not read as a healthy phone.
  const s = L.trackerStatus({ battery: { level: 90, charging: false } }, NOW);
  check('an active record with no heartbeat is silence, not health', s.key, 'no-contact');
}

// -------------------------------------------------------------------- order
console.log('\nwhen several things are wrong at once\n');
{
  const s = L.trackerStatus(fresh({ lastHeartbeat: NOW - 30 * 60000,
    battery: { level: 2, charging: false }, gpsErrorCode: 1, geofenceStatus: 'outside' }), NOW);
  // Every other figure in the record is as old as the silence, so reporting
  // any of them as current would be reporting a stale reading as live.
  check('silence outranks everything, because nothing else is current', s.key, 'no-contact');
}
{
  const s = L.trackerStatus(fresh({ battery: { level: 2, charging: false },
    geofenceStatus: 'outside', lastFixTime: NOW - 10 * 60000 }), NOW);
  check('a dying phone outranks a weak signal and a geofence', s.key, 'battery-critical');
}
{
  const s = L.trackerStatus(fresh({ gpsErrorCode: 1, battery: { level: 12, charging: false } }), NOW);
  check('location off outranks a merely low battery', s.key, 'location-off');
}

// --------------------------------------------------------- not checked in
console.log('\nwho has not checked in today\n');
{
  const TODAY = '2026-09-06';
  const users = [
    { username: 'a', displayName: 'Anil', enabled: true },
    { username: 'b', displayName: 'Bhavesh', enabled: true },
    { username: 'c', displayName: 'Chirag', enabled: true },
    { username: 'd', displayName: 'Dinesh', enabled: false },
    { username: 'e', displayName: 'Esha', enabled: true }
  ];
  const by = {
    a: { active: { lastHeartbeat: NOW }, trips: [] },              // on a trip now
    b: { active: null, trips: [{ date: '2026-09-06' }] },          // been and gone
    c: { active: null, trips: [{ date: '2026-08-30' }] },          // a week ago
    d: { active: null, trips: [] },                                // login switched off
    e: { active: null, trips: [] }                                 // never once
  };
  const rows = L.notCheckedInToday(users, by, TODAY);
  check('somebody on a trip is not on the list', rows.some(r => r.username === 'a'), false);
  // The one that would otherwise generate a false alarm every afternoon.
  check('nor is somebody who came in and checked out again',
        rows.some(r => r.username === 'b'), false);
  check('a disabled login is not chased', rows.some(r => r.username === 'd'), false);
  check('the two who are genuinely missing are listed',
        rows.map(r => r.username).sort(), ['c', 'e']);
  check('with how long it has been', rows.find(r => r.username === 'c').daysSince, 7);
  // Never checked in is a different conversation from a week absent, and
  // "9999 days" would read as a bug rather than as never.
  check('and never having checked in is said as such, not as a huge number',
        [rows.find(r => r.username === 'e').daysSince,
         rows.find(r => r.username === 'e').lastTripDate], [null, null]);
  check('the never-seen one sorts to the top', rows[0].username, 'e');
}
{
  check('nobody to chase is an empty list, not an error',
        L.notCheckedInToday([], {}, '2026-09-06'), []);
  check('and missing arguments do not throw',
        L.notCheckedInToday(null, null, '2026-09-06'), []);
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
