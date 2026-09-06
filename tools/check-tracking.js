// What an engineer gets paid for travelling.
//
// The km this produces becomes kmToday * rate_per_km on HR's dashboard, so
// every assertion below is about somebody's reimbursement. Two failures matter
// and they pull in opposite directions: counting a walk round a plant as
// driving pays for kilometres nobody drove, and dropping a traffic jam stops
// paying for kilometres somebody did drive. The second is the worse of the
// two, because the engineer cannot see what was taken off him — which is why
// there are more tests below about traffic than about walking.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({trackingStep, newTrackingState, TRACKING_RULES, haversineKm, routeAppend_})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};
const near = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= (tol === undefined ? 0.05 : tol);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + got.toFixed(3) +
              (ok ? '' : '  want ~' + want));
  if (!ok) fails.push(label);
};

// A straight run of fixes at a steady speed, one every `everyS` seconds.
// Positions are derived from the speed rather than asserted alongside it, so a
// fixture cannot claim a speed its own coordinates disagree with.
const START_LAT = 22.3072, START_LON = 73.1812;
function leg(state, kmph, minutes, opts){
  const o = opts || {};
  const everyS = o.everyS || 15;
  const steps = Math.round(minutes * 60 / everyS);
  let s = state, t = o.t0 || 0, lat = o.lat === undefined ? START_LAT : o.lat;
  for(let i = 0; i < steps; i++){
    t += everyS * 1000;
    // 1 degree of latitude is about 111.32 km.
    lat += (kmph * (everyS / 3600)) / 111.32;
    s = L.trackingStep(s, { lat: lat, lon: START_LON, ts: t,
      accuracy: o.accuracy === undefined ? 10 : o.accuracy,
      speed: o.noDeviceSpeed ? null : kmph / 3.6 }, o.rules);
  }
  return { s: s, t: t, lat: lat };
}

// -------------------------------------------------------------- walking only
console.log('an engineer who only walks\n');
{
  // Twenty minutes at 4.5 km/h — 1.5 km round a plant. Not a rupee of it.
  const r = leg(L.newTrackingState(), 4.5, 20);
  check('nothing is claimed as vehicle travel', Math.round(r.s.vehicleKm * 1000), 0);
  near('but the walk is measured and kept', r.s.walkKm, 1.5, 0.1);
  check('and the state says he is on foot', r.s.mode, 'foot');
}
{
  // A brisk walk, and a jog. Neither reaches the threshold.
  check('a brisk 6.5 km/h walk still counts nothing',
        Math.round(leg(L.newTrackingState(), 6.5, 15).s.vehicleKm * 1000), 0);
  check('nor does a 10 km/h jog',
        Math.round(leg(L.newTrackingState(), 10, 10).s.vehicleKm * 1000), 0);
}

// ------------------------------------------------------------------- driving
console.log('\nan engineer who drives\n');
{
  const r = leg(L.newTrackingState(), 45, 20);   // 15 km
  check('the drive is counted', r.s.mode, 'vehicle');
  near('and measured', r.s.vehicleKm, 15, 0.3);
  check('with nothing landing in the walking figure', Math.round(r.s.walkKm * 1000), 0);
}

// ------------------------------------------------ THE ONE THAT COSTS MONEY
console.log('\na vehicle stuck in traffic — the failure that underpays\n');
{
  // Drive, crawl at 4 km/h for four minutes, drive again. A single "below
  // walking pace stops counting" rule silently drops the crawl, and the
  // engineer is short for kilometres he genuinely drove.
  const a = leg(L.newTrackingState(), 40, 10);
  const b = leg(a.s, 4, 4, { t0: a.t, lat: a.lat });
  const c = leg(b.s, 40, 10, { t0: b.t, lat: b.lat });
  // Both driven legs in full, plus the part of the crawl inside the grace.
  near('the crawl through traffic is still paid', c.s.vehicleKm, 6.667 + 0.133 + 6.667, 0.4);
  // Four minutes of crawling is double the agreed two-minute grace, so the
  // tail of it correctly stops being a drive. That is the trade-off in the
  // grace being two minutes: a jam longer than that gives up its slow middle.
  // TRACKING_RULES.exitGraceMs is the one line to change if HR wants longer.
  near('past the grace, the rest of the crawl becomes walking', c.s.walkKm, 0.133, 0.09);
  check('and the journey resumes as a drive when traffic clears', c.s.mode, 'vehicle');
}
{
  // Ninety seconds of crawling is inside the grace and must not end the drive.
  const a = leg(L.newTrackingState(), 40, 5);
  const b = leg(a.s, 3, 1.5, { t0: a.t, lat: a.lat });
  check('a ninety-second crawl does not end the journey', b.s.mode, 'vehicle');
}

// ------------------------------------------------------- parking and walking
console.log('\nparking, then walking to the door\n');
{
  const a = leg(L.newTrackingState(), 40, 15);
  const drove = a.s.vehicleKm;
  // Park and walk for eight minutes at 4 km/h — 533 m.
  const b = leg(a.s, 4, 8, { t0: a.t, lat: a.lat });
  check('the walk ends the journey', b.s.mode, 'foot');
  // The grace means the first two minutes of the walk are still booked as
  // driving. That is the deliberate cost of protecting traffic jams, it is
  // bounded, and it errs towards the engineer rather than against him.
  const overcount = b.s.vehicleKm - drove;
  check('the drive is not retrospectively taken away', b.s.vehicleKm > drove, true);
  near('and the grace costs at most a couple of minutes of walking',
       overcount, 0.13, 0.09);
  near('the rest of the walk is recorded as walking', b.s.walkKm, 0.4, 0.15);
}

// ------------------------------------------------------- the device's fixes
console.log('\nwhat the phone actually hands over\n');
{
  // Plenty of Android fixes report no speed at all. Falling back to distance
  // over time has to reach the same answer, or the same journey pays
  // differently on two handsets.
  const withSpeed = leg(L.newTrackingState(), 40, 10).s;
  const without = leg(L.newTrackingState(), 40, 10, { noDeviceSpeed: true }).s;
  check('a phone that reports no speed still counts the drive', without.mode, 'vehicle');
  near('and reaches the same distance', without.vehicleKm, withSpeed.vehicleKm, 0.05);
  const walkNo = leg(L.newTrackingState(), 4.5, 20, { noDeviceSpeed: true }).s;
  check('and still refuses to pay for a walk', Math.round(walkNo.vehicleKm * 1000), 0);
}
{
  // A vague fix is dropped without moving `last`. If it moved `last`, the next
  // good fix would be measured against a position that was never real.
  let s = L.newTrackingState();
  s = L.trackingStep(s, { lat: START_LAT, lon: START_LON, ts: 1000, accuracy: 8, speed: 12 });
  const before = s.last;
  s = L.trackingStep(s, { lat: START_LAT + 0.05, lon: START_LON, ts: 2000, accuracy: 500, speed: 12 });
  check('a fix too vague to trust is ignored', s.last, before);
  check('and adds nothing to either figure', [s.vehicleKm, s.walkKm], [0, 0]);
}
{
  let s = L.newTrackingState();
  s = L.trackingStep(s, { lat: START_LAT, lon: START_LON, ts: 1000, accuracy: 8, speed: 20 });
  // 0.05 degrees is about 5.5 km in one fix — a bad reading, not a journey.
  s = L.trackingStep(s, { lat: START_LAT + 0.05, lon: START_LON, ts: 2000, accuracy: 8, speed: 20 });
  check('a fix that teleports is not counted as distance',
        [Math.round(s.vehicleKm * 1000), Math.round(s.walkKm * 1000)], [0, 0]);
}
{
  // Nothing a watchPosition callback can hand over may throw: an exception
  // there stops the trip being measured at all, and nobody finds out until the
  // reimbursement is short.
  let s = L.newTrackingState();
  [{}, { lat: 'x', lon: 'y', ts: 1 }, { lat: 1, lon: 2 }, { lat: null, lon: null, ts: null },
   { lat: START_LAT, lon: START_LON, ts: 1000, accuracy: null, speed: undefined }
  ].forEach(f => { s = L.trackingStep(s, f); });
  check('a malformed fix never throws and never invents distance',
        [Math.round(s.vehicleKm * 1000), Math.round(s.walkKm * 1000)], [0, 0]);
}

// ------------------------------------------------------------------ the route
console.log('\nthe route kept for the trip\n');
{
  const r = leg(L.newTrackingState(), 45, 30);   // 22.5 km
  check('a route is collected', r.s.route.length > 10, true);
  check('and stays well inside its cap', r.s.route.length <= L.TRACKING_RULES.routeMaxPoints, true);
  check('every point is a rounded lat/lon pair',
        r.s.route.every(p => p.length === 2 && Math.abs(p[0] * 1e5 % 1) < 1e-6), true);
  // The size that decides whether this fits in its own cell.
  const bytes = JSON.stringify(r.s.route).length;
  console.log('       a 22.5 km route stores as ' + bytes + ' characters');
  check('a normal trip is nowhere near the 50,000 character cell limit',
        bytes < 12000, true);
}
{
  // Eight hours of driving must cost no more room than one — it is drawn
  // coarser instead of growing without limit.
  const long = leg(L.newTrackingState(), 60, 8 * 60, { everyS: 30 });
  check('a very long trip is still capped',
        long.s.route.length <= L.TRACKING_RULES.routeMaxPoints + 1, true);
  const bytes = JSON.stringify(long.s.route).length;
  console.log('       an eight-hour 480 km route stores as ' + bytes + ' characters');
  check('and still fits in one cell', bytes < 20000, true);
}

// ---------------------------------------------- when the app was not running
console.log('\na gap while the app was suspended\n');
{
  const L2 = vm.runInContext('({trackingResume, trackingGapSummary})', sb);
  // Drive, then the engineer switches to WhatsApp for six minutes and comes
  // back 3 km away. Nobody measured that 3 km — not the route, not whether he
  // drove straight there.
  const a = leg(L.newTrackingState(), 45, 10);
  const drove = a.s.vehicleKm;
  const back = { lat: a.lat + 3 / 111.32, lon: START_LON };
  const r = L2.trackingResume(a.s, 6 * 60 * 1000, back);
  check('the gap is recorded', [r.gap.ms, Math.round(r.gap.straightKm)], [360000, 3]);
  // THE assertion. A guess must not reach the figure that becomes money.
  check('and not one metre of it joins the paid distance', r.state.vehicleKm, drove);
  check('nor the walked one', r.state.walkKm, a.s.walkKm);
  // Without this the next fix extends the journey across the hole: 3 km is
  // over maxStepKm so it would vanish silently, and a 1.5 km gap would have
  // been added as though it had been driven under observation.
  check('the next fix starts fresh rather than bridging the hole', r.state.last, null);
  const after = leg(r.state, 45, 5, { t0: a.t + 6 * 60000, lat: back.lat });
  near('driving after the gap is counted normally again',
       after.s.vehicleKm - drove, 3.75, 0.3);
}
{
  const L2 = vm.runInContext('({trackingResume, trackingGapSummary})', sb);
  // A glance at a notification is not a tracking failure.
  const a = leg(L.newTrackingState(), 45, 5);
  const r = L2.trackingResume(a.s, 4000, { lat: a.lat, lon: START_LON });
  check('a four-second glance is not recorded as a gap', r.gap, null);
  check('and does not throw the journey away', r.state.last !== null, true);
}
{
  const L2 = vm.runInContext('({trackingResume, trackingGapSummary})', sb);
  // No fix on the way back — GPS had not caught up yet.
  const a = leg(L.newTrackingState(), 45, 5);
  const r = L2.trackingResume(a.s, 5 * 60000, null);
  check('a gap with no fix to compare is still recorded', r.gap.ms, 300000);
  // "We do not know how far it moved" and "it did not move" are different
  // answers, and only one of them may be shown to HR as a distance.
  check('but its distance is unknown, not zero', r.gap.straightKm, null);
}
{
  const L2 = vm.runInContext('({trackingResume, trackingGapSummary})', sb);
  let st = L.newTrackingState();
  st.last = { lat: START_LAT, lon: START_LON, ts: 0 };
  st = L2.trackingResume(st, 60000, { lat: START_LAT + 1 / 111.32, lon: START_LON }).state;
  st.last = { lat: START_LAT, lon: START_LON, ts: 0 };
  st = L2.trackingResume(st, 120000, null).state;
  const sum = L2.trackingGapSummary(st);
  check('the trip reports how many holes it has', sum.count, 2);
  check('and how long they add up to', sum.ms, 180000);
  check('with the measured distance totalled', Math.round(sum.straightKm), 1);
  // The count that stops the total reading as complete when it is not.
  check('and the unmeasured ones counted separately', sum.unmeasured, 1);
  check('a trip with no gaps reports none',
        L2.trackingGapSummary(L.newTrackingState()), { count: 0, ms: 0, straightKm: 0, unmeasured: 0 });
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
