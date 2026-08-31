// ===== Shared report logic =====
//
// The payroll, attendance and leave calculations, in the one place both the
// app and the scheduled report emails read them from.
//
// Why this file exists: every one of these functions used to live inside
// index.html, so only a browser with a live session could run them. The
// report emails run in Google Apps Script, which has neither, so they could
// not work a figure out and instead attached whatever CSV the app had last
// filed in Drive — which meant an emailed report silently depended on
// somebody having opened it first, and could be a month out of date.
//
// index.html loads this with a plain <script src> before its own code, and
// Code 2.js fetches this same file from the live site and evaluates it at
// email time. One file, one definition of every rule; the number on screen
// and the number in the attachment cannot drift apart, because they are
// produced by the same lines.
//
// Rules for anything added here:
//   - No DOM, no fetch, no session, nothing asynchronous. Apps Script has
//     none of it. Data is passed in by the caller, never read in.
//   - Declaration order is the order these were in index.html, which is the
//     order that works: const and let are not hoisted.
//   - Everything is a plain top-level declaration, deliberately. In a
//     classic script that puts it in the same global scope index.html's own
//     code uses, so nothing else had to change to find it.
//
// Do not copy any of this into Code 2.js. A second copy is exactly the drift
// this file was made to end.

function todayStr(d){
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

// Every date shown to a person reads DD/MM/YYYY — the Indian numeral
// convention — never the ISO storage order and never a bare
// toLocaleDateString() guess at the browser's own locale. Storage stays
// ISO everywhere it always was (financial-year math, sorting, attendance
// keys, <input type="date"> values, which the HTML spec pins to ISO
// regardless of display locale) — this only ever touches what a person
// reads. The regex path handles the "YYYY-MM-DD" strings almost every
// date in this app is actually stored as, without going through
// `new Date()` at all — parsing a date-only string with the Date
// constructor reads it as UTC midnight, which in a timezone behind UTC
// lands the day before, exactly the bug financialYearLabel already has to
// avoid. Anything not in that shape (a Date object, a timestamp) falls
// back to reading local calendar fields off it instead. One legacy field
// (policy-override log entries) already stored a bare, unpadded
// toLocaleDateString('en-IN') result — day-first, same as everywhere else,
// just missing the leading zero — so that shape is padded directly rather
// than handed to `new Date()`, which would guess month-first for an
// ambiguous "D/M/YYYY" string and silently transpose day and month.
function fmtDateIN(v){
  if(!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return `${m[3]}/${m[2]}/${m[1]}`;
  const dmy = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(dmy) return dmy[1].padStart(2,'0') + '/' + dmy[2].padStart(2,'0') + '/' + dmy[3];
  const d = v instanceof Date ? v : new Date(v);
  if(isNaN(d)) return String(v);
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}

// Every "shared" key also gets a local mirror, kept as a fallback for when
// the backend is briefly unreachable (network blip, quota hit, etc.) — the
// real Apps Script backend is configured above and is the source of truth
// whenever it's reachable.
// A render often asks for the same shared key several times — the reports tab
// alone reads the employee list from three different builders — and each ask
// was a separate round trip to Apps Script, which is where the wait came from.
// Reads are held very briefly so one screen's repeated asks cost one call.
// Short enough that nothing looks stale, and any write clears the key outright.
const SHARED_READ_TTL_MS = 8000;

function readTtlFor(key){
  if(key && key.indexOf('attendance:') === 0) return LONG_READ_TTL_MS.ATTENDANCE;
  return LONG_READ_TTL_MS[key] || SHARED_READ_TTL_MS;
}

const sharedReadCache = new Map();

function primeSharedRead(key, value){
  sharedReadCache.set(key, { value, until: Date.now() + readTtlFor(key) });
}

async function getAttendanceMany(ids){
  const out = {};
  if(!ids.length) return out;
  const allIds = ids;
  // This filled the cache but never looked in it, so the dashboard downloaded
  // everybody's attendance to work out who is absent today and the Attendance
  // Sheet downloaded the identical thing again a second later. Whatever is
  // already held is used, and only the rest is asked for.
  const missing = [];
  ids.forEach(id => {
    const hit = sharedReadCache.get('attendance:' + id);
    if(hit && Date.now() < hit.until){
      try{ out[id] = hit.value ? JSON.parse(hit.value) : {}; }catch(e){ out[id] = {}; }
    } else {
      missing.push(id);
    }
  });
  if(missing.length){
    ids = missing;
    let handledByBatch = false;
    // Whole history, merged on the backend across every financial year each
    // employee has plus whatever is still in their legacy attendance:<id> key.
    try{
      const data = await backendAction({ action:'getAttendanceAll', ids });
      if(data && data.values){
        ids.forEach(id => { out[id] = data.values[id] || {}; });
        handledByBatch = true;
      }
    }catch(e){}
    if(!handledByBatch){
      // Older backend, or the call failed — one at a time, as before.
      const each = await Promise.all(ids.map(id => getAttendance(id).catch(() => ({}))));
      ids.forEach((id, i) => { out[id] = each[i] || {}; });
    }
  }
  const filled = await applyAlwaysPresentFillToMany_(out, allIds, null, null);
  // Primed with the FILLED value, not the raw one — getAttendance()'s own
  // cache-hit fast path trusts whatever is here without re-applying the fill
  // itself, so a stale unfilled entry here would make the Salary Sheet's read
  // (which goes through that single-employee path) silently disagree with
  // this one the moment this function had already run once this session.
  missing.forEach(id => {
    if(filled[id] !== undefined) primeSharedRead('attendance:' + id, JSON.stringify(filled[id]));
  });
  return filled;
}

// ---- attendance sheet ----
// ===== R.S. Infotech Leave & Attendance Policy — configuration =====
// Every number, threshold and window the engine uses lives here, transcribed
// from the policy document. Nothing below reads a literal: change a value here
// and every calculation, warning and deduction follows it. Where the document
// is silent the value is null and the engine says so rather than inventing one.
const LEAVE_POLICY = {
  version: 'R.S. Infotech Leave Policy',
  shift: {
    // "up to 15 minutes late (by 9:45 AM)" fixes the start at 09:30.
    startMin: 9 * 60 + 30,
    endMin: 19 * 60,                  // 19:00, confirmed by HR
    // Derived from the shift, not a separate figure: 09:30 to 19:00.
    get workingMinutes(){ return this.endMin - this.startMin; },
    // Overtime is counted from 20:00, also confirmed by HR. The hour between
    // shift end and this is neither shift nor overtime — staying until 19:45
    // earns nothing, and no rate is invented for it.
    overtimeFromMin: 20 * 60
  },
  lateComing: {
    graceMinutes: 15,                 // permissible up to 09:45
    shortLeaveAfterMinutes: 30,       // "beyond 30 minutes ... considered as short leave"
    freeInstancesPerMonth: 3,         // 1st-3rd late arrival each month: no warning, no deduction
    // Every late arrival past the free allowance is judged on its own
    // instance number for the month, not a flat "half a day every two" —
    // confirmed by HR. Read in order starting from the 4th late arrival:
    // the 4th is a warning only, the 5th costs half a day, the 6th is
    // another warning, and the 7th costs a full day. The list stops there
    // on purpose — the LAST entry repeats for every late arrival after it,
    // so the 8th, 9th and onward each cost a full day too, with no more
    // warnings.
    escalation: [
      { warning: true },   // 4th late arrival
      { deductDays: 0.5 }, // 5th
      { warning: true },   // 6th
      { deductDays: 1 }    // 7th, and every one after
    ]
  },
  shortLeave: {
    durationHours: 2,
    perMonth: 2,                      // more than 2 in a month -> half day
    // The policy says the third and any further short leave is adjusted as a
    // half day. It used to say compensatory off beyond three, which was never
    // what the written policy allowed and would have given time back instead
    // of taking pay.
    carryForward: false,
    // These are the employee types the form actually stores. They previously
    // read 'full' and 'regular', which no record has ever carried, so short
    // leave was being refused for everybody. Work From Home is excluded by the
    // policy and Resident Engineers are outside these rules entirely.
    eligibleEmployeeTypes: ['field', 'office'],
    minServiceMonths: 3,
    windows: [
      { label: 'Morning', fromMin: 9 * 60 + 30, toMin: 11 * 60 + 30 },
      { label: 'Evening', fromMin: 17 * 60,     toMin: 19 * 60 }
    ]
  },
  sickLeave: {
    // Keyed by employee type. Seven a year is the headline figure; Work From
    // Home is four, confirmed by HR and kept deliberately when the policy was
    // restated as "7 days" without qualification.
    perYear: { full: 7, part: 4, field: 7, office: 7, wfh: 4 },
    medicalCertificateRequired: true,
    carryForward: false,
    encashable: false
  },
  privilegeLeave: {
    earnedPerAttendanceDays: 25,      // 1 PL per 25 days of attendance
    maxPerMonth: 2,                   // beyond this deducts salary
    carryForward: false,
    encashable: true,
    usableInFirstYear: false,         // earned in year 1, usable from year 2
    // Encashment is paid on 70% of Basic + HRA, and a day of it is worth a
    // twenty-fifth of that — confirmed by HR, and the same twenty-five that
    // earns the leave in the first place. Kept as config rather than a number
    // buried in a sum, so the two can be seen to agree.
    salaryBasis: { label: 'Basic + HRA', grossPct: 0.70, components: ['basic', 'hra'], dayDivisor: 25 }
  },
  leaveApplication: {
    formRequired: true,
    hodApprovalRequired: true,
    maxConcurrentPerDepartment: 2,
    mondayIsPaidLeave: false,         // "Monday leave is not considered as paid leave"
    // A Sunday, or a declared holiday, is charged as an extra unpaid day when
    // the working day immediately before it AND the working day immediately
    // after it are both Absent or Leave Without Pay — sandwiched between two
    // days the employee did not actually work. Confirmed by HR: approved
    // leave (EL/SL) on either side does NOT trigger this — only unpaid
    // absence does. See sandwichDaysFor, which computes it against the real
    // attendance record for the Salary Sheet, not just the note this raises
    // on a leave application below.
    sandwichRule: true,
    sandwichCodes: ['A', 'LP']
  },
  partTime: { shortLeaveAllowed: false },
  holidays: ['Uttarayan (14–15 January)', 'Dhuleti', 'Rakshabandhan',
             'Diwali (Diwali to Chhath)', 'Labh Pacham (office open)']
};

// ---- privilege leave encashment ----
// Unused PL is paid out at the year end rather than carried into the next
// year. The rate is 70% of Basic + HRA, from the salary heading and Rate of
// Pay like everything else — never from a stored figure, so an employee whose
// pay changed is encashed at what they are on now.
//
// One function, so the Leave Balance Next Year Report and anything else that
// ever needs the figure cannot disagree about it.
function plEncashmentRate(emp, P){
  P = P || LEAVE_POLICY;
  const B = P.privilegeLeave.salaryBasis;
  const asOf = currentRatePay(emp);
  const h = SALARY_HEADINGS[asOf.salaryHeading] || SALARY_HEADINGS.managerial;
  const rate = asOf.ratePay;
  // Basic and HRA as the heading splits them; a flat heading pays the whole
  // rate as Basic, so its HRA is nil and the base is simply the rate.
  const part = { basic: h.flat ? rate : rate * h.basicPct,
                 hra:   h.flat ? 0    : rate * h.hraPct,
                 lta:   h.flat ? 0    : rate * h.ltaPct };
  const monthly = B.components.reduce((t, k) => t + (part[k] || 0), 0);
  const basis = monthly * B.grossPct;
  return {
    monthly: Math.round(monthly * 100) / 100,
    basis: Math.round(basis * 100) / 100,
    perDay: Math.round((basis / B.dayDivisor) * 100) / 100,
    label: B.label, pct: B.grossPct, dayDivisor: B.dayDivisor
  };
}

function plEncashmentFor(emp, unusedDays, P){
  const r = plEncashmentRate(emp, P);
  const days = Math.max(0, Number(unusedDays) || 0);
  return { ...r, days, amount: Math.round(r.perDay * days * 100) / 100 };
}

// ---- policy summary for the rendered month ----
// Reads the attendance codes the sheet already stores and reports each
// employee's position against LEAVE_POLICY: late instances and the half-days
// they trigger, short leaves and what the next one becomes, sick and PL usage
// against balance. Every threshold quoted comes from the policy config, so this
// panel changes with the policy and never disagrees with the engine.
// One computation, used by both the Attendance Sheet panel and the dashboard
// alerts, so the two can never report different violations for the same month.
// Half days the policy imposes, as distinct from half days somebody marked on
// the sheet. Two sources, both counted over the month being paid:
//
//   late coming   3 instances are free, then one half day per 2 further
//   short leave   2 a month are allowed, the third and beyond are half days
//
// One function, because these now reduce pay: the Salary Sheet and the policy
// panel disagreeing about how many half days somebody owes would be an
// argument with an employee that nobody could settle.
//
// Resident Engineers sit outside both rules entirely and never accrue any.
// `total`/`fromLate` stay expressed in half-day UNITS (1 unit = 0.5 day),
// same as before this formula changed — computeSalaryForEmployee multiplies
// this by 0.5 to get actual days, and the Salary Sheet's "Policy Half Days"
// column shows it raw, so both keep working unchanged. Late-coming deductions
// can now be a mix of half-day and full-day amounts (see LEAVE_POLICY.
// lateComing.escalation), so this converts each instance's own cost to units
// (a full day = 2 units) and sums them, rather than one flat rate for every
// instance past the free allowance.
function lateComingUnitsFor(lateCount, L){
  let units = 0, warnings = 0;
  for(let n = L.freeInstancesPerMonth + 1; n <= lateCount; n++){
    const stepIndex = n - L.freeInstancesPerMonth - 1;
    const step = L.escalation[Math.min(stepIndex, L.escalation.length - 1)];
    if(step.warning) warnings++;
    else units += step.deductDays * 2;
  }
  return { units, warnings };
}

function policyHalfDaysFor(emp, att, dateList){
  const P = LEAVE_POLICY, L = P.lateComing, S = P.shortLeave;
  const out = { fromLate: 0, fromShortLeave: 0, total: 0, lateCount: 0, shortLeaves: 0, lateWarnings: 0, reasons: [] };
  if((emp || {}).employeeType === 'resident') return out;
  (dateList || []).forEach(d => {
    const e = (att || {})[d];
    if(!e) return;
    if(e.lateFlag) out.lateCount++;
    if(e.code === 'SHORT') out.shortLeaves++;
  });
  const late = lateComingUnitsFor(out.lateCount, L);
  out.fromLate = late.units;
  out.lateWarnings = late.warnings;
  if(late.warnings) out.reasons.push(late.warnings + ' late-coming warning(s) (the 4th and 6th late arrival each month) — no deduction for these on their own');
  if(late.units) out.reasons.push((late.units * 0.5) + ' day(s) deducted from ' + out.lateCount +
    ' late arrivals — ' + L.freeInstancesPerMonth + ' free, the 5th is a half day, the 7th and every one after is a full day');
  if(out.shortLeaves > S.perMonth){
    out.fromShortLeave = out.shortLeaves - S.perMonth;
    out.reasons.push(out.fromShortLeave + ' half day(s) from ' + out.shortLeaves +
      ' short leaves — ' + S.perMonth + ' allowed a month');
  }
  out.total = out.fromLate + out.fromShortLeave;
  return out;
}

// ---- sandwich leave ----
// A Sunday, or a run of a declared holiday next to one, is charged as an
// extra unpaid day when the working day immediately before the whole
// non-working block AND the working day immediately after it are both
// Absent or Leave Without Pay — see LEAVE_POLICY.leaveApplication.
// sandwichRule/sandwichCodes. Approved leave (EL/SL) on either side does not
// trigger it, only unpaid absence does.
//
// Non-working days are walked as a BLOCK, not one at a time: a Saturday
// holiday immediately before the Sunday off has no late/absence code of its
// own to check against, so checking each day only against its immediate
// neighbour would miss it. The bracketing working days — the one before the
// block starts and the one after it ends — are what decide the whole block.
// A plain "add N days to an ISO date string" helper — pulled out of
// sandwichDaysFor so callers that need to widen an attendance fetch to
// cover its before/after lookups (see the comment on getAttendanceRange
// callers below) can compute the same padded dates without duplicating the
// date arithmetic.
function shiftDateStr(dateStr, delta){
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function sandwichDaysFor(emp, att, dateList, holidayMap){
  // Resident Engineers are out of this, the same way policyHalfDaysFor above
  // already excuses them from late coming and short leave. It used to apply to
  // them deliberately -- the reasoning being that a Resident's day is marked
  // A/LP/P through the same sheet as everyone else -- but HR has since decided
  // the sandwich rule is not one of theirs, so it now follows the same line as
  // the rest of the policy. Ankit Patel's 28 August was the case that raised
  // it. Gating it here rather than at each caller means the Salary Sheet, the
  // Attendance Sheet's policy note and the Consultant Report cannot disagree
  // about whether a Resident was charged.
  if((emp || {}).employeeType === 'resident') return [];
  const codes = LEAVE_POLICY.leaveApplication.sandwichCodes;
  const shiftDate = shiftDateStr;
  const isNonWorking = dateStr => new Date(dateStr + 'T00:00:00').getDay() === 0 || !!(holidayMap && holidayMap[dateStr]);
  // An unmarked day is not "no opinion" — engineers who track attendance
  // from the mobile app are marked Present the moment they take a check-in
  // selfie (see the Attendance tab's own description of that flow) and
  // nothing at all is written for a day they never check in on, so a real
  // absence there leaves no explicit code behind. computeAttendanceSummary
  // already treats an unmarked day up to and including today as Absent for
  // pay purposes; sandwich leave has to agree with that reading or the two
  // disagree about the very day meant to trigger it, and the sandwich day
  // silently stops being charged for anyone whose absences are mobile-
  // tracked rather than typed into the Attendance Sheet by hand. A future
  // date is never assumed absent. Always-Present employees never reach
  // here with an unmarked day at all — withAlwaysPresentFill_ has already
  // filled those in as Present before sandwichDaysFor ever sees them.
  const isUnpaidAbsence = dateStr => {
    const e = (att || {})[dateStr];
    if(e) return codes.indexOf(e.code) !== -1;
    return dateStr <= todayStr();
  };
  if(!LEAVE_POLICY.leaveApplication.sandwichRule) return [];
  const list = dateList || [];
  const sandwiched = [];
  let i = 0;
  while(i < list.length){
    if(!isNonWorking(list[i])){ i++; continue; }
    let j = i;
    while(j < list.length && isNonWorking(list[j])) j++;
    const before = shiftDate(list[i], -1);
    const after = shiftDate(list[j - 1], 1);
    if(isUnpaidAbsence(before) && isUnpaidAbsence(after)){
      for(let k = i; k < j; k++) sandwiched.push(list[k]);
    }
    i = j;
  }
  return sandwiched;
}

// A day the Holiday section declares takes precedence over whatever this
// code already was — Absent (marked, or defaulted, before the holiday was
// declared), Leave Without Pay, or paid leave nobody needed to spend on a
// day there was no work to attend. resolvedAttendanceCode_ is the one place
// this override happens, so the Attendance Sheet grid, the Salary Sheet and
// every other report that reads a day's code through it agree by
// construction — see that function's own comment. Present and Short Leave
// are deliberately NOT in this set: someone who actually came in and worked
// on a declared holiday keeps their real attendance, not a relabel to
// "holiday" that would hide it.
const HOLIDAY_OVERRIDE_CODES = new Set(['A','LP','EL','SL','HEL','HSL','HLP']);

// The month the Paid Holiday override starts applying from, and a hard wall
// in front of everything before it: a month that has already been worked,
// paid and reported to the consultant must keep reading exactly as it did,
// whatever is added to the Holiday List afterwards.
//
// Deliberately a FIXED date, not "whatever month it is today". A rolling
// cutoff would quietly un-apply the rule from each month as it slid into
// the past — August's figures would change the moment September began,
// which is the very thing this constant exists to prevent. Set to the month
// the rule went live and left alone; moving it is a decision, not a side
// effect of the calendar turning.
const PH_RULE_EFFECTIVE_FROM = '2026-08-01';

// ---- salary sheet headings ----
// Each heading defines how Rate of Pay splits into Basic/HRA/LTA. 'flat' means
// the whole rate (minus leave deduction) is just Basic, with no HRA/LTA split —
// that's how Junior Staff are set up in the source sheet. pf/esi/pt flags
// control which statutory deductions apply to that heading at all.
const SALARY_HEADINGS = {
  managerial:  { label: 'Managerial Staff',  basicPct: 0.65, hraPct: 0.35, ltaPct: 0,    flat: false, pf: true,  esi: true,  pt: true  },
  senior:      { label: 'Seniors Staff',     basicPct: 0.50, hraPct: 0.40, ltaPct: 0.10, flat: false, pf: true,  esi: true,  pt: true  },
  junior:      { label: 'Junior Staff',      basicPct: 1.00, hraPct: 0,    ltaPct: 0,    flat: true,  pf: true,  esi: true,  pt: true  },
  apprentice:  { label: 'Apprentices',       basicPct: 0.50, hraPct: 0.40, ltaPct: 0.10, flat: false, pf: false, esi: false, pt: false },
  rsit:        { label: 'R.S.IT Solution',   basicPct: 0.50, hraPct: 0.40, ltaPct: 0.10, flat: false, pf: false, esi: false, pt: true  },
  contractor:  { label: 'Contractors',       basicPct: 0.50, hraPct: 0.40, ltaPct: 0.10, flat: false, pf: false, esi: false, pt: false }
};

// PT is the one deduction whose amount is decided by a rule rather than typed
// in per employee. Named so the Salary Sheet and the heading explainer below
// read the same numbers — the calculation is unchanged.
// ---- provident fund ----
// Statutory rates, kept as config so a change in the law is an edit here.
// The wage PF is charged on is Basic. HR's instruction, and it matches the
// EPF Act's Basic + DA where there is no DA component: HRA is a house rent
// allowance and is excluded. Add a DA heading one day and list it below.
const PF_RULES = {
  employeePct: 0.12,        // employee share, all of it to EPF
  employerPct: 0.12,        // employer share, split between EPS and EPF
  epsPct: 0.0833,           // pension scheme portion of the employer share
  epsWageCeiling: 15000,    // EPS is charged on wages only up to this
  epsMonthlyCap: 1250       // and therefore never exceeds this
};

// Which earnings PF is charged on. Basic only — HRA was in this list until HR
// confirmed it is a house rent allowance rather than a dearness allowance, and
// HRA is excluded from PF wages. Listed as config rather than written into the
// sum, which is why that change was one line here and needed no migration:
// every employee's PF is worked out from Rate of Pay and their heading at the
// moment it is shown, so existing staff picked up the new base at once.
PF_RULES.wageComponents = ['basic'];

// EPF Scheme "excluded employee". All three conditions must hold — any one of
// them missing and PF is mandatory. The threshold is strictly greater than the
// ceiling, not equal to it, and it is tested at the wage on joining.
// Employer-only charges on the PF wage, over and above the 12% share.
// Confirmed by HR at 0.5% each.
PF_RULES.adminPct = 0.005;
PF_RULES.edliPct  = 0.005;

PF_RULES.fixedAmount = 1800;      // the flat option, both sides

// HR-confirmed exception, standing policy: Jalpa Rasesh Doshi (id 31) and
// Narendrabhai Doshi (id 30). When Actual Percentage is selected for them,
// Employee PF stays uncapped at 12% of their actual wage — no ₹1,800
// ceiling, unlike every other employee on Actual Percentage below — and
// every report shows their Employer PF as one combined figure rather than
// split into Employer PF/EPF and Pension/EPS columns. Nothing else about
// them changes: same wage, same exclusions, ordinary Fixed-₹1,800 behaviour
// if that option is ever picked for them instead. By employee id, not name
// — a name match is one typo away from silently missing the right person or
// catching the wrong one in a payroll figure.
PF_RULES.uncappedPercentIds = ['30', '31'];

PF_RULES.exclusion = {
  wageAbove: 15000,
  conditions: ['No prior UAN or EPF account', 'Basic strictly above ₹15,000', 'Form 11 declaration submitted']
};

// ===== THE central PF calculation =====
// Employee Master, the Salary Sheet and the PF Return all call this and only
// this. Three separate implementations would drift, and payroll disagreeing
// with the return is the one difference nobody notices until a challan is
// short.
//
// `wage` is the FINAL PAYABLE basic — after unpaid leave has reduced it — not
// the contracted figure. The caller is responsible for that reduction, and the
// Salary Sheet already applies it before Basic and HRA are summed.
//
// `emp.salaryHeading` below is read exactly as handed in — this function has
// no month of its own and cannot tell "now" apart from "some past month
// being reported on". For a specific month's payroll (computeSalaryForEmployee,
// monthlyPayFor) the caller MUST build its own object via
// Object.assign({}, emp, ratePayAsOf(emp, thatMonth)) first, the same way
// those two already do — a heading change recorded through Record Increment
// must never move a month that has already been paid. Passing a raw `emp`
// here for anything but a "right now"/hypothetical calculation (the live
// employee-form preview, the CTC Calculator) will silently apply today's
// heading to a past month.
function pfConfigStatus(emp){
  const e = (emp || {}).pfEligible;
  if(e !== 'yes' && e !== 'no') return { configured:false, eligible:false, type:'', problem:'PF eligibility not configured' };
  if(e === 'no') return { configured:true, eligible:false, type:'', problem:'' };
  const t = (emp || {}).pfContributionType;
  if(t !== 'percent' && t !== 'fixed')
    return { configured:false, eligible:true, type:'', problem:'PF contribution type not selected' };
  return { configured:true, eligible:true, type:t, problem:'' };
}

const PF_ZERO = { applicable:false, employee:0, employerEpf:0, employerEps:0, edli:0, admin:0,
                  employeeTotal:0, employerTotal:0, grandTotal:0, wage:0, type:'', employerPfMerged:false };

function calculatePfFor(emp, wage){
  const w = Math.max(0, Number(wage) || 0);
  const heading = SALARY_HEADINGS[(emp || {}).salaryHeading] || SALARY_HEADINGS.managerial;

  // Step 1 — the heading must attract PF at all (R.S. Infotech headings only).
  if(!heading.pf) return { ...PF_ZERO, wage:w, reason:'PF does not apply to ' + heading.label };

  // Step 2 — eligibility, before any formula runs.
  const cfg = pfConfigStatus(emp);
  if(!cfg.configured) return { ...PF_ZERO, wage:w, notConfigured:true, reason:cfg.problem };
  if(!cfg.eligible)   return { ...PF_ZERO, wage:w, reason:'PF Not Applicable — marked not eligible' };

  // Step 3 — the statutory exclusion still stands above eligibility being Yes.
  const ex = pfExclusionStatus(emp, w);
  if(ex.excluded) return { ...PF_ZERO, wage:w, reason:'Excluded employee — no prior UAN, Form 11 submitted, wage above ₹' + fmtMoney(PF_RULES.exclusion.wageAbove) };

  // Step 4 — the configured contribution type. Fixed ₹1,800 is only ever
  // shorthand for "12% of the ₹15,000 ceiling" — the two are the same
  // figure — so it only holds while the wage this month is genuinely above
  // that ceiling. Unpaid leave can take a month's payable Basic down to or
  // below ₹15,000; charging the flat ₹1,800 against a wage that has
  // actually dropped would take more than 12% of what the employee was
  // really paid that month, so this falls through to the same percentage
  // formula 'percent' always uses once the wage is at or under the
  // ceiling — there is no discontinuity at the boundary, since 12% of
  // exactly ₹15,000 is ₹1,800 either way.
  if(cfg.type === 'fixed' && w > PF_RULES.epsWageCeiling){
    const f = PF_RULES.fixedAmount;
    // Employee side stays the flat, agreed ₹1,800 — unchanged. The employer
    // side is charged on the ₹15,000 ceiling itself, never the actual
    // (higher) Basic — EPFO caps employer contributions at the ceiling
    // regardless of what Basic really is, whether Basic is ₹20,000,
    // ₹25,000 or ₹50,000. Computing employer EPF/EPS off the real wage (as
    // this used to) overstated Employer EPF for every Fixed employee above
    // the ceiling — e.g. a Basic of ₹25,000 gave Employer EPF ₹1,750
    // instead of the correct ₹550, because 12% of the real wage minus the
    // (correctly capped) EPS still leaves the EPF share tracking the real
    // wage. EDLI and Admin use the same ₹15,000 base, per the same rule.
    const pfBase = Math.min(w, PF_RULES.epsWageCeiling);
    const cFixed = computePf(pfBase);
    const edliFixed  = pfBase * PF_RULES.edliPct;
    const adminFixed = pfBase * PF_RULES.adminPct;
    return { applicable:true, type:'fixed', wage:w,
             employee:f, employerEpf:cFixed.employerEpf, employerEps:cFixed.employerEps,
             edli:edliFixed, admin:adminFixed,
             employeeTotal:f,
             employerTotal:cFixed.employerEpf + cFixed.employerEps + edliFixed + adminFixed,
             grandTotal:f + cFixed.employerEpf + cFixed.employerEps + edliFixed + adminFixed,
             employerPfMerged:false,
             reason:'Fixed ₹' + fmtMoney(f) + ' (employee) — employer side is Employer EPF + Pension/EPS + EDLI + Admin Charges, calculated on the ₹' + fmtMoney(PF_RULES.epsWageCeiling) + ' ceiling, not the actual wage of ₹' + fmtMoney(w) };
  }

  const c = computePf(w);
  // EDLI = MIN(Basic, ₹15,000) × 0.5% — Basic only, never HRA, allowances,
  // overtime or gross, and never the actual Basic once it is above the
  // ceiling. This used to read the real wage here, which overcharged EDLI
  // for anyone above ₹15,000 the same way Employer EPF did in the Fixed
  // branch above before that was corrected.
  const edliBase = Math.min(w, PF_RULES.epsWageCeiling);
  const edli  = edliBase * PF_RULES.edliPct;
  const admin = w * PF_RULES.adminPct;
  const isUncapped = PF_RULES.uncappedPercentIds.indexOf(String((emp || {}).id)) !== -1;
  // Everyone except the two HR-confirmed exceptions is stopped here — Fixed
  // ₹1,800 and Actual Percentage converge on the same ceiling, just reached
  // two different ways: Fixed is the flat figure directly, Percentage is
  // 12% of the actual wage stopped at the same figure. Below the ceiling
  // neither ever needed capping, since 12% of a wage under ₹15,000 is
  // already under ₹1,800 on its own — this only bites employees whose
  // actual percentage would otherwise have run past it.
  const employeeCharged = isUncapped ? c.employee : Math.min(c.employee, PF_RULES.fixedAmount);
  // The two exceptions' Employer PF is reported as one combined figure
  // rather than split into EPF and Pension/EPS — an HR-confirmed reporting
  // decision for these two specifically. The combined total
  // (employerEpf + employerEps) is exactly what employerTotal already was
  // either way; only which field carries it, and therefore which report
  // column it lands in, changes.
  const employerEpf = isUncapped ? (c.employerEpf + c.employerEps) : c.employerEpf;
  const employerEps = isUncapped ? 0 : c.employerEps;
  return {
    applicable:true, type:'percent', wage:w,
    employee:employeeCharged, employerEpf, employerEps, edli, admin,
    employeeTotal:employeeCharged,
    employerTotal:employerEpf + employerEps + edli + admin,
    grandTotal:employeeCharged + employerEpf + employerEps + edli + admin,
    employerPfMerged:isUncapped,
    reason: isUncapped
      ? 'Percentage on a wage of ₹' + fmtMoney(w) + ' — Employee PF uncapped by standing HR agreement for this employee; Employer PF shown as one combined figure, not split into EPF and Pension/EPS'
      : cfg.type === 'fixed'
        ? 'Percentage — Basic of ₹' + fmtMoney(w) + ' this month is at or below the ₹' + fmtMoney(PF_RULES.epsWageCeiling) +
          ' ceiling, so the usual Fixed ₹' + fmtMoney(PF_RULES.fixedAmount) + ' does not apply'
        : employeeCharged < c.employee
          ? 'Percentage — Employee PF capped at ₹' + fmtMoney(PF_RULES.fixedAmount) + ' on a wage of ₹' + fmtMoney(w)
          : c.capApplied
            ? 'Percentage — EPS capped at ₹' + fmtMoney(PF_RULES.epsMonthlyCap) + ' on a wage of ₹' + fmtMoney(w)
            : 'Percentage on a wage of ₹' + fmtMoney(w)
  };
}

// Returns why PF is or is not being deducted, so the form can say so rather
// than silently showing zero — a zero with no reason looks like a bug, and an
// employee wrongly excluded is a compliance failure nobody notices for months.
function pfExclusionStatus(emp, wage){
  const X = PF_RULES.exclusion;
  const noUan  = emp.hasPriorUan === 'no';
  const form11 = emp.form11Submitted === 'yes';
  const aboveThreshold = wage > X.wageAbove;
  const excluded = noUan && form11 && aboveThreshold;
  const missing = [];
  if(!noUan)  missing.push('a prior UAN or EPF account exists');
  if(!aboveThreshold) missing.push('Basic of ₹' + fmtMoney(wage) + ' is not above ₹' + fmtMoney(X.wageAbove));
  if(!form11) missing.push('Form 11 declaration not recorded');
  return { excluded, missing, noUan, form11, aboveThreshold };
}

function pfWageOf(components){
  const get = k => { const c = components.find(x => x.key === k); return c ? c.value : 0; };
  return PF_RULES.wageComponents.reduce((sum, k) => sum + get(k), 0);
}

// Both sides of the contribution from one wage figure.
function computePf(wage){
  const w = Number(wage) || 0;
  const employee = w * PF_RULES.employeePct;
  const employerTotal = w * PF_RULES.employerPct;
  // At or above the ceiling EPS is the stated cap, not 8.33% of the ceiling.
  // The two differ: 8.33% of 15,000 is 1,249.50, while EPFO deducts a flat
  // 1,250. Taking the percentage literally would under-deduct 50 paise every
  // month for every member and leave the challan short.
  const epsCapped = w >= PF_RULES.epsWageCeiling
    ? PF_RULES.epsMonthlyCap
    : w * PF_RULES.epsPct;
  // Whatever the employer share is not paying into EPS goes to EPF. Above the
  // ceiling that is more than 3.67%, because EPS stops growing and the
  // employer's 12% does not.
  const employerEpf = employerTotal - epsCapped;
  return {
    wage: w, employee, employerTotal,
    employerEps: epsCapped, employerEpf,
    capApplied: w >= PF_RULES.epsWageCeiling,
    total: employee + employerTotal
  };
}

// ---- employees' state insurance ----
const ESI_RULES = {
  employeePct: 0.0075,
  employerPct: 0.0325,
  wageCeiling: 21000,           // exempt strictly above this gross
  disabledCeiling: 25000,       // higher ceiling for persons with disabilities
  lowWageDailyLimit: 176,       // at or below this daily wage the employee share is waived
  daysInMonthForDailyWage: 26   // wage days used to derive a daily rate
};

// Which half-yearly contribution period a date falls in, and when it ends.
// This matters because coverage cannot be dropped mid-period.
function esiContributionPeriod(d){
  const dt = d ? new Date(d) : new Date();
  const y = dt.getFullYear(), m = dt.getMonth();   // 0-11
  return (m >= 3 && m <= 8)
    ? { label:'April–September', endsOn: new Date(y, 8, 30) }
    : { label:'October–March',   endsOn: m >= 9 ? new Date(y + 1, 2, 31) : new Date(y, 2, 31) };
}

// gross is the ESI wage: Basic, DA/HRA, overtime and regular monthly
// allowances. Annual bonus, gratuity and the employer's PF share are excluded,
// so this is deliberately NOT the CTC figure.
//
// o.eligible defaults to true — every existing employee, whose record
// predates this field, keeps computing exactly as before. Set to false
// (emp.esiEligible === 'no' on the record) only when HR has explicitly
// marked someone exempt regardless of what their gross would otherwise
// require — coverage they already hold under a different employer as their
// primary one is the usual real case, not a way to routinely skip the
// statutory deduction. Checked before the wage-ceiling rule, since an
// explicit exemption overrides gross-based coverage entirely, including the
// "once covered, always covered" continuation below — nothing about that
// rule makes sense for someone HR has said is not covered by this employer
// in the first place.
function computeEsi(gross, opts){
  const o = opts || {};
  const g = Number(gross) || 0;
  if(o.eligible === false){
    return { covered:false, employee:0, employer:0, total:0, ceiling:null, period:null,
             reason:'Marked not eligible for ESI on the employee record — no ESI deducted regardless of gross.' };
  }
  const ceiling = o.isDisabled ? ESI_RULES.disabledCeiling : ESI_RULES.wageCeiling;
  const aboveCeiling = g > ceiling;

  // "Once covered, always covered": an employee already contributing when the
  // period began keeps contributing to the end of it, on the NEW wage, even
  // after a rise past the ceiling. Dropping them the month of the increment is
  // the usual mistake and it leaves the return short.
  const period = esiContributionPeriod(o.asOf);
  const mustContinue = aboveCeiling && !!o.coveredAtPeriodStart;
  const covered = !aboveCeiling || mustContinue;

  if(!covered){
    return { covered:false, employee:0, employer:0, total:0, ceiling, period,
             reason:'Gross of ₹' + fmtMoney(g) + ' is above the ₹' + fmtMoney(ceiling) + ' ceiling.' };
  }
  // Low earners keep their share; the employer still pays the full 3.25%.
  const dailyWage = g / ESI_RULES.daysInMonthForDailyWage;
  const lowWage = dailyWage <= ESI_RULES.lowWageDailyLimit;
  const employee = lowWage ? 0 : g * ESI_RULES.employeePct;
  const employer = g * ESI_RULES.employerPct;
  return {
    covered:true, employee, employer, total: employee + employer, ceiling, period, lowWage,
    reason: mustContinue
      ? 'Above the ceiling, but coverage continues to ' + fmtDateIN(period.endsOn) +
        ' — contributions cannot stop mid-period.'
      : lowWage
        ? 'Daily wage of ₹' + fmtMoney(Math.round(dailyWage)) + ' is at or below ₹' +
          ESI_RULES.lowWageDailyLimit + ', so the employee share is waived and the employer pays the full ' +
          headingPct(ESI_RULES.employerPct) + '.'
        : headingPct(ESI_RULES.employeePct) + ' employee and ' + headingPct(ESI_RULES.employerPct) + ' employer on ₹' + fmtMoney(g) + '.'
  };
}

const PT_GROSS_THRESHOLD = 12000;

const PT_AMOUNT = 200;

const PT_ANNUAL_CAP = 2500;

// Worth stating plainly: at ₹200 a month the year comes to ₹2,400, which is
// already under the ₹2,500 cap, so the cap never binds at the current rate. It
// is implemented anyway, so raising PT_AMOUNT later cannot quietly overshoot.
function monthlyPtFor(gross, ptPaidSoFarThisYear){
  if(!(gross > PT_GROSS_THRESHOLD)) return 0;
  const paid = Number(ptPaidSoFarThisYear) || 0;
  return Math.max(0, Math.min(PT_AMOUNT, PT_ANNUAL_CAP - paid));
}

function headingPct(p){ return (Math.round(p * 10000) / 100) + '%'; }

function computeAttendanceSummary(att, employee, dateList, holidayMap){
  // present and paidDays are two different questions and used to be one number.
  // "Present" is the days actually attended; "paid" adds the leave that is paid
  // without being worked. A full day of EL or SL used to add 1 to present, so
  // the Attendance Sheet showed Mahendrasinh 24.5 for August while the
  // Consultant Report showed 23.5 for the same month — the consultant's own
  // count (consultantDayCounts) has always kept leave out of Present. The two
  // now agree, and paidDays carries exactly what present used to, so nothing
  // that reads it moves.
  let present=0, paidDays=0, absent=0, elUsed=0, slUsed=0, lpDays=0, halfDays=0, shortCount=0, lateCount=0, holidays=0;
  dateList.forEach(dateStr => {
    // resolvedAttendanceCode_ is the one place a day's code is resolved from
    // what's saved, the Holiday section, and the weekday — every caller
    // (this summary, the Attendance Sheet grid, the Consultant Report) reads
    // the same answer instead of each keeping its own copy of that logic.
    const entry = att[dateStr];
    const code = resolvedAttendanceCode_(att, dateStr, holidayMap);
    if(entry && entry.lateFlag) lateCount++;
    switch(code){
      case 'P': present += 1; paidDays += 1; break;
      case 'A': absent += 1; break;
      case 'H': holidays += 1; break;
      // Paid, but not attended — so they count towards paidDays and not towards
      // present. This is the line HR queried: a day of Earned Leave is not a
      // day the person was at work.
      case 'EL': elUsed += 1; paidDays += 1; break;
      case 'SL': slUsed += 1; paidDays += 1; break;
      case 'LP': lpDays += 1; break;
      // Half worked, half leave. The worked half is genuine attendance, so it
      // stays in present exactly as before.
      case 'HEL': present += 0.5; elUsed += 0.5; halfDays += 1; paidDays += 0.5; break;
      case 'HSL': present += 0.5; slUsed += 0.5; halfDays += 1; paidDays += 0.5; break;
      case 'HLP': lpDays += 0.5; present += 0.5; halfDays += 1; paidDays += 0.5; break;
      case 'SHORT': present += 1; shortCount += 1; paidDays += 1; break;
      default: if(dateStr <= todayStr()) absent += 1; // unmarked past day defaults to absent
    }
  });
  // The half-days the late-coming and excess-short-leave policy imposes, in
  // DAYS rather than the half-day units policyHalfDaysFor counts in -- the same
  // figure computeSalaryFromAttendance charges. It existed only as a sentence
  // in the violation note before, so a 0.5 taken off somebody's pay could not
  // be seen as a number or added up: Sanjeev Srivastav's 5 late arrivals cost
  // him half a day in August and the Attendance Sheet showed 0 everywhere.
  // It belongs on the summary rather than at the two places that display it,
  // so the live row refresh keeps it current as HR edits the grid.
  const policyCut = policyHalfDaysFor(employee, att, dateList).total * 0.5;
  return { present, absent, elUsed, slUsed, lpDays, halfDays, shortCount, lateCount, holidays,
           paidDays, policyCut };
}

// ---- salary sheet ----
// Whole rupees, no paise, everywhere an amount is shown — payroll here runs
// in rupees, not paise, and a figure like ₹33,333.33 on screen only invited
// the question of where the 33 paise went. CSV exports round the same way;
// see the R()/Math.round() calls next to each csvRows.push.
// `|| 0` also catches NaN, so a missing figure reads ₹0 rather than "NaN".
// The `+ 0` is what stops "₹-0": Math.round returns negative zero for
// anything in (-0.5, 0], and toLocaleString is the one place that shows the
// sign — String(-0) and JSON.stringify(-0) both give "0", which is why the
// CSV exports never had this and only the screen did. Adding zero turns -0
// into 0 and leaves every other value alone, so a real negative still keeps
// its minus. Reached whenever a figure lands a hair below zero through
// floating point: an employee absent the whole month has a gross of exactly
// nothing, computed as a sum of percentages that do not quite cancel.
function fmtMoney(n){ return (Math.round(Number(n) || 0) + 0).toLocaleString('en-IN'); }

// Loan recovery, month by month, from the two figures HR already enters — the
// amount and the instalment. How many months it runs is not stored: it is
// however many instalments the amount needs, so the schedule can never
// disagree with itself, and the final instalment is the remainder so recovery
// stops exactly at the loan and never overshoots it.
//
// A loan with no recovery start month deducts nothing. That is deliberate: an
// EMI has never actually come off the Salary Sheet, so every loan on record
// today was entered on the understanding that it would not. Starting to deduct
// from somebody's salary because their record was migrated is not a decision
// this code gets to make — HR sets the start month, and only then does money
// move.
// An employee's loans, as a list, whatever shape the record is in.
//
// Records written before there was a ledger carry one loan in flat fields.
// Rather than migrate the stored data — which would rewrite every employee to
// answer a read — the single loan is presented as a one-entry list at the point
// of reading. A record that has a `loans` array uses it and the flat fields are
// ignored, so the first save through the form settles the question for good.
function loansOf(emp){
  if(!emp) return [];
  if(Array.isArray(emp.loans)) return emp.loans.filter(l => l && (Number(l.amount) || 0) > 0);
  const amount = Number(emp.loanAmount) || 0;
  if(!amount) return [];
  return [{
    id: 'legacy',
    amount,
    instalment: Number(emp.emiPerMonth) || 0,
    startMonth: emp.loanStartMonth || '',
    status: emp.loanStatus === 'closed' ? 'closed' : 'active',
    reason: '',
    approvedOn: ''
  }];
}

// ---- salary history (increments) ----
// An employee's Rate of Pay and heading, as a dated list, whatever shape the
// record is in. Same idea as loansOf: a record with no history yet is a
// single implicit entry built from the flat ratePay/salaryHeading fields,
// effective for any date — exactly what every report has always shown, so
// nobody's figures move until an increment is actually recorded. `from: null`
// on an entry means "in force before anything else on the list", which is
// what freezes a rate as the one that covered everything before the first
// real increment (see recordIncrement).
function salaryHistoryOf(emp){
  if(!emp) return [{ from: null, ratePay: 0, salaryHeading: 'managerial' }];
  if(Array.isArray(emp.salaryHistory) && emp.salaryHistory.length) return emp.salaryHistory;
  return [{ from: null, ratePay: Number(emp.ratePay) || 0, salaryHeading: emp.salaryHeading || 'managerial' }];
}

// Rate of Pay and salary heading as they stood on one date. This is the whole
// point of keeping history: an increment changes every report from its
// effective date onward without moving a single figure on any report before
// it. The entry with the latest `from` date that is still on or before
// dateStr is the one in force; entries are not assumed to already be sorted.
// A dateStr before every entry (should not happen in practice) falls back to
// the earliest one on file rather than reading as zero.
function ratePayAsOf(emp, dateStr){
  const hist = salaryHistoryOf(emp);
  const asOf = String(dateStr || todayStr());
  let chosen = null;
  hist.forEach(h => {
    if(h.from && h.from > asOf) return; // not effective yet on this date
    if(!chosen || (h.from || '') > (chosen.from || '')) chosen = h;
  });
  if(!chosen){
    chosen = hist.slice().sort((a, b) => (a.from || '').localeCompare(b.from || ''))[0];
  }
  return { ratePay: Number(chosen.ratePay) || 0, salaryHeading: chosen.salaryHeading || 'managerial' };
}

// Rate of Pay and heading in force today — what every "current state" screen
// (the employee form, the dashboard, the Increment and CTC reports) means by
// "their salary", as opposed to a specific month's Salary Sheet.
function currentRatePay(emp){
  return ratePayAsOf(emp, todayStr());
}

// A loan's EMI history, as a dated list, whatever shape the record is in —
// same idea as salaryHistoryOf. A loan with no emiHistory yet is a single
// implicit entry built from the flat instalment field, effective from the
// month recovery starts, so nothing already shown on any report moves until
// an EMI change is actually recorded (see recordLoanEmiChange).
function loanEmiHistoryOf(loan){
  if(!loan) return [];
  if(Array.isArray(loan.emiHistory) && loan.emiHistory.length) return loan.emiHistory;
  return [{ from: loan.startMonth || null, instalment: Number(loan.instalment) || 0 }];
}

// The EMI rate in force on one month — the entry with the latest `from` on
// or before it, same resolution rule as ratePayAsOf.
function loanEmiRateAsOf(loan, ym){
  const hist = loanEmiHistoryOf(loan);
  let chosen = null;
  hist.forEach(h => {
    if(h.from && h.from > ym) return;
    if(!chosen || (h.from || '') > (chosen.from || '')) chosen = h;
  });
  if(!chosen) chosen = hist.slice().sort((a, b) => (a.from || '').localeCompare(b.from || ''))[0];
  return Number(chosen.instalment) || 0;
}

// Walks a loan's schedule month by month from recovery start through the
// given month, so the EMI can change partway through (loanEmiHistoryOf) and a
// specific month can be skipped (loan.skipMonths — the balance just carries
// over, unreduced, and the payoff date moves a month later) without either
// one disagreeing with what was actually recovered before it. How many
// months it runs is still not stored: it is however many the amount needs
// once skips are accounted for, and the last one charged is the remainder,
// so recovery stops exactly at the loan and never overshoots it.
//
// A loan with no recovery month deducts nothing — see the note on the
// employee form. Nothing comes out of a salary until somebody says when.
function loanScheduleThrough(loan, year, month){
  // A closed loan (or no loan, or nothing borrowed) has no outstanding
  // balance to report, whether or not it ever started — matches the two
  // functions this replaces, and the sort in the Loan & Advance Report relies
  // on a closed loan sorting as zero, not as its original amount.
  if(!loan || loan.status !== 'active') return { charged: 0, balanceAfter: 0 };
  const amount = Number(loan.amount) || 0;
  if(!amount) return { charged: 0, balanceAfter: 0 };
  // Active but not yet started (or not due to start until after the month
  // asked about) — the whole amount is still owed, nothing recovered yet.
  if(!loan.startMonth) return { charged: 0, balanceAfter: amount };
  const [sy, sm] = String(loan.startMonth).split('-').map(Number);
  if(!sy || !sm) return { charged: 0, balanceAfter: amount };
  const startIdx = sy * 12 + (sm - 1);
  const targetIdx = year * 12 + (month - 1);
  if(targetIdx < startIdx) return { charged: 0, balanceAfter: amount };
  const skip = new Set(loan.skipMonths || []);
  let balance = amount, charged = 0;
  for(let idx = startIdx; idx <= targetIdx; idx++){
    if(balance <= 0){ charged = 0; continue; }
    const y = Math.floor(idx / 12), mo = (idx % 12) + 1;
    const ym = y + '-' + String(mo).padStart(2, '0');
    if(skip.has(ym)){ charged = 0; continue; }
    const rate = loanEmiRateAsOf(loan, ym);
    const take = Math.min(rate, balance);
    balance = Math.round((balance - take) * 100) / 100;
    charged = take;
  }
  return { charged, balanceAfter: Math.max(0, balance) };
}

// One loan's instalment for one month.
function loanEmiForMonth(loan, year, month){
  return loanScheduleThrough(loan, year, month).charged;
}

// What is still owed on one loan once the given month's instalment is taken.
function loanBalanceAfter(loan, year, month){
  return loanScheduleThrough(loan, year, month).balanceAfter;
}

// Everything being recovered from this employee this month, across every loan
// running at once. Two loans recover two instalments — the second no longer
// displaces the first.
function computeLoanEmiForMonth(emp, year, month){
  return Math.round(loansOf(emp).reduce((t, l) => t + loanEmiForMonth(l, year, month), 0) * 100) / 100;
}

function loanBalanceAfterMonth(emp, year, month){
  return Math.round(loansOf(emp).reduce((t, l) => t + loanBalanceAfter(l, year, month), 0) * 100) / 100;
}

function computeRetentionForMonth(emp, year, month){
  const money = Number(emp.retentionMoney) || 0;
  const months = Number(emp.retentionMonths) || 0;
  if(!money || !months || !emp.bondStart) return 0;
  // 'T00:00:00' — local midnight, not UTC (see CLAUDE.md/computeAttendanceSummary):
  // a bare new Date(dateStr) parses a date-only string as UTC midnight, which
  // can read back as the previous day — and so the previous month — in a
  // timezone behind UTC.
  const start = new Date(emp.bondStart + 'T00:00:00');
  const startIndex = start.getFullYear()*12 + start.getMonth();
  const thisIndex = year*12 + (month-1);
  const offset = thisIndex - startIndex;
  if(offset < 0 || offset >= months) return 0;
  return Math.round((money / months) * 100) / 100;
}

// Salary Advance Payment carries no recurring rate — HR types a fresh
// figure for whichever month it actually applies to
// (emp.advanceHistory: [{month:'YYYY-MM', advanceTemp, advance}, ...] —
// advanceTemp is a leftover key from before Advance for Temporary became
// recurring below; still read here as a one-off legacy fallback, never
// written by anything current), so there is no schedule to walk and
// nothing can overshoot. A month with no entry is genuinely nil, not "not
// yet decided" — same treatment loan months get when no instalment was
// recorded for them.
//
// A record that has never been touched since this replaced the old flat
// advance field has no history at all — that flat field used to apply
// identically to every month a sheet was generated for, which is exactly
// the bug this exists to fix (today's figure silently showing up on a
// regenerated April sheet). The fallback below only ever answers for the
// CURRENT month on such a record, so nothing already relying on today's
// flat figure breaks, while every other month reads a clean zero — the
// safer wrong answer for payroll (under-deducts, fixable by adding a
// dated entry) rather than the old behaviour's over-deduction risk.
function salaryAdvanceForMonth(emp, ym){
  const hist = emp.advanceHistory || [];
  if(hist.length){
    const entry = hist.find(h => h.month === ym);
    return entry ? (Number(entry.advance) || 0) : 0;
  }
  if(ym !== todayStr().slice(0, 7)) return 0;
  return Number(emp.advance) || 0;
}

// Advance for Temporary, unlike Salary Advance Payment, recurs — set a
// rate once with a start month and it keeps applying every month after
// that until HR records a change, exactly like a Loan EMI
// (loanEmiRateAsOf/loanScheduleThrough above). Unlike a loan there is no
// principal being paid off, so there is no schedule to walk and nothing
// that could overshoot — "stopping" it is simply a new rateHistory entry
// of ₹0 dated from the stop month, the same mechanism a genuine rate
// change already uses.
//
// The two guards below matter precisely because this ISN'T only ever
// called the way loanEmiRateAsOf is — that function is only ever reached
// from inside loanScheduleThrough's own loop, which never asks about a
// month before the loan's startMonth to begin with. Nothing here plays
// that gatekeeping role, so an un-started schedule (blank startMonth) or a
// month before the schedule actually began would otherwise fall through
// to "no entry matches, so use the earliest one anyway" and return a rate
// that hasn't started yet.
function advanceTempForMonth(emp, ym){
  const sched = emp.advanceTempSchedule;
  if(!sched || !sched.startMonth) return legacyAdvanceTempForMonth_(emp, ym);
  if(ym < sched.startMonth) return 0;
  const hist = (Array.isArray(sched.rateHistory) && sched.rateHistory.length)
    ? sched.rateHistory
    : [{ from: sched.startMonth, instalment: Number(sched.instalment) || 0 }];
  let chosen = null;
  hist.forEach(h => {
    if(h.from && h.from > ym) return;
    if(!chosen || (h.from || '') > (chosen.from || '')) chosen = h;
  });
  return chosen ? (Number(chosen.instalment) || 0) : 0;
}

// No recurring schedule set up yet — the same three-tier fallback
// salaryAdvanceForMonth uses, so whatever was entered under the one-off
// design this replaces (an April figure, say) keeps answering for exactly
// that month, without silently starting to recur, until HR actually sets
// up the schedule above.
function legacyAdvanceTempForMonth_(emp, ym){
  const hist = emp.advanceHistory || [];
  const entry = hist.find(h => h.month === ym);
  if(entry) return Number(entry.advanceTemp) || 0;
  if(ym === todayStr().slice(0, 7)) return Number(emp.advanceTemp) || 0;
  return 0;
}

// Apprentice-only stipend paid straight to the employee's own bank account
// rather than through this app's Salary Sheet, so it comes off Net Payable
// as its own line instead of being paid a second time. Unlike Advance for
// Temporary this was never meant to recur indefinitely — a direct-deposit
// arrangement always has an end (the apprenticeship board or the scheme
// itself sets one) — so an optional end month stops it automatically from
// the month AFTER the one entered, the same "last month it applies" shape
// bondStart/retentionMonths already uses for retention money. Blank end
// month means the arrangement is still ongoing, same as every other
// open-ended field in this file.
function directPaidForMonth(emp, heading, monthYm){
  if((emp || {}).directPaid !== 'yes' || heading !== SALARY_HEADINGS.apprentice) return 0;
  if(emp.directPaidEndMonth && monthYm > emp.directPaidEndMonth) return 0;
  return Number(emp.directPaidAmount) || 0;
}

// What is still owed on Salary Advance Payment once the given month's
// recovery is taken — a cumulative sum of every advanceHistory entry up to
// and including that month, not a month-by-month walk like a loan's
// balance: there is no rate to resolve per month and no schedule that
// could overshoot, so summing what has actually been recorded is enough.
// advanceOpening is the figure as HR last entered it "as it stands
// today" — no separate "as of" date is needed, since an employee with no
// advanceHistory yet correctly shows that same opening figure for every
// month, which is the honest answer when nothing has been recorded
// against it.
//
// Advance for Temporary is deliberately NOT part of this balance — once it
// became a recurring, open-ended deduction (advanceTempForMonth above)
// rather than a fixed amount being paid down, subtracting it here forever
// would eventually run the balance to ₹0 and leave it looking "settled"
// while the recurring deduction kept happening every month for an
// unrelated reason. This balance is Salary Advance Payment's alone, the
// same way PT or a Loan's own balance never mix with each other either.
//
// Falls back to the flat advance field for the CURRENT month only, on a
// record with no advanceHistory yet — same rule salaryAdvanceForMonth
// uses, so this balance does not look stale next to a real deduction
// happening in the very same row.
function advanceBalanceAfterMonth(emp, year, month){
  const opening = Number(emp.advanceOpening) || 0;
  const ym = year + '-' + String(month).padStart(2, '0');
  const hist = emp.advanceHistory || [];
  let recoveredSoFar;
  if(hist.length){
    recoveredSoFar = hist
      .filter(h => h.month && h.month <= ym)
      .reduce((t, h) => t + (Number(h.advance) || 0), 0);
  } else {
    recoveredSoFar = ym === todayStr().slice(0, 7) ? (Number(emp.advance) || 0) : 0;
  }
  return Math.max(0, Math.round((opening - recoveredSoFar) * 100) / 100);
}

// ================= the company's financial year =================
// 1 April to 31 March. FY 2026-27 runs 1 April 2026 to 31 March 2027, FY
// 2027-28 from 1 April 2027, and so on.
//
// Everything measured by year goes through the four functions below and
// nothing works the year out for itself: Drive filing, EL and leave balances,
// the encashment sheet, the holiday list, the leave report and the PT annual
// cap. Change the two numbers here and the whole app moves with them.
const FINANCIAL_YEAR = { startMonth: 4, startDay: 1 };

// The starting calendar year of the financial year a date falls in — 2026 for
// anything from 1 April 2026 to 31 March 2027 inclusive.
//
// The day is read straight out of the YYYY-MM-DD text rather than through
// `new Date()`. A date-only string is parsed as UTC midnight, so on a device
// whose timezone is behind UTC "2026-04-01" reads back as 31 March locally and
// the whole of 1 April would be filed under the previous financial year.
// Comparing the numbers in the string cannot drift, whatever the device clock
// is set to. Anything that is not a plain date falls back to the local day.
function fyStartYearOf(dateStr){
  let y, m, day;
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(typeof dateStr === 'string' ? dateStr.trim() : '');
  if(iso){
    y = +iso[1]; m = +iso[2]; day = iso[3] ? +iso[3] : 1;
  } else {
    const d = dateStr ? new Date(dateStr) : new Date();
    const t = isNaN(d.getTime()) ? new Date() : d;
    y = t.getFullYear(); m = t.getMonth() + 1; day = t.getDate();
  }
  const beforeYearStart = m < FINANCIAL_YEAR.startMonth ||
    (m === FINANCIAL_YEAR.startMonth && day < FINANCIAL_YEAR.startDay);
  return beforeYearStart ? y - 1 : y;
}

// "2026-27" for anything between 1 April 2026 and 31 March 2027. Used to file
// Drive output by year, so each year's sheets sit in their own folder instead
// of piling into one.
function financialYearLabel(dateStr){
  const y = fyStartYearOf(dateStr);
  return y + '-' + String((y + 1) % 100).padStart(2, '0');
}

// The first day of the financial year a date falls in — "2026-04-01".
function financialYearStart(dateStr){
  const y = fyStartYearOf(dateStr);
  return y + '-' + String(FINANCIAL_YEAR.startMonth).padStart(2, '0') +
             '-' + String(FINANCIAL_YEAR.startDay).padStart(2, '0');
}

// The last day of the financial year a date falls in — "2027-03-31" — worked
// out as the day before the next year starts, so it stays right if the start
// date above is ever moved. Leave balances are measured to here rather than to
// today, so leave already approved for a date in the future is counted as
// spent. Measured to today it would not be, and somebody could book the same
// days twice over by applying for them one block at a time.
function financialYearEnd(dateStr){
  const nextStart = Date.UTC(fyStartYearOf(dateStr) + 1,
                             FINANCIAL_YEAR.startMonth - 1, FINANCIAL_YEAR.startDay);
  return new Date(nextStart - 86400000).toISOString().slice(0, 10);
}

// The four year-scoped reports ask for a plain start year — HR types 2026 and
// means FY 2026-27. This turns that number into the year's first day, last day
// and label, so no screen writes "-04-01" or "-03-31" for itself.
function fyOfStartYear(startYear){
  const from = startYear + '-' + String(FINANCIAL_YEAR.startMonth).padStart(2, '0') +
                          '-' + String(FINANCIAL_YEAR.startDay).padStart(2, '0');
  return { from, to: financialYearEnd(from), label: financialYearLabel(from) };
}

// Leave used from 1 April up to and including the month being paid. Half days
// count as half, matching how the attendance summary treats them, so a balance
// cannot be run down twice as fast by marking half days.
// `openingFrom` is the month the opening balance was stated as at, in YYYY-MM.
// Balances entered part-way through the year are current as at that month, so
// counting from 1 April would deduct leave already reflected in the figure —
// an employee opened at 8 in August, having taken 3 in June, would show 5.
function leaveUsedThisFinancialYear(att, upToDate, openingFrom){
  const from = openingFrom
    ? (openingFrom.length === 7 ? openingFrom + '-01' : openingFrom)
    : financialYearStart(upToDate);
  let el = 0, sl = 0;
  Object.keys(att || {}).forEach(d => {
    if(d < from || d > upToDate) return;
    const c = (att[d] || {}).code;
    if(c === 'EL') el += 1;
    else if(c === 'HEL') el += 0.5;
    else if(c === 'SL') sl += 1;
    else if(c === 'HSL') sl += 0.5;
  });
  return { el, sl };
}

function computeSalaryFromAttendance(emp, att, dateList, monthDays, holidayMap){
  const summary = computeAttendanceSummary(att, emp, dateList, holidayMap);
  // EL/SL are paid, so only Absent and LP reduce pay — plus the half days the
  // policy imposes for late coming and excess short leave, which used to be
  // warned about and then left for somebody to apply by hand. Half a day each.
  const policyHalf = policyHalfDaysFor(emp, att, dateList);
  // A Sunday or holiday sandwiched between two unpaid-absence days, charged
  // as an extra unpaid day of its own — see sandwichDaysFor. Resident
  // Engineers are exempt from the EL/SL/short-leave/late-coming rules, but
  // NOT from this one — a deliberate policy decision, since a Resident's
  // day is still marked A/LP/P through the same Attendance Sheet as
  // everyone else, so the same Sunday-or-holiday-bracketed-by-two-unpaid-
  // days reasoning applies to them the same way.
  const sandwichDates = sandwichDaysFor(emp, att, dateList, holidayMap);
  const leaveDays = summary.absent + summary.lpDays + policyHalf.total * 0.5 + sandwichDates.length;
  // Rate of Pay and heading as they stood on THIS month, not whatever they are
  // today — an increment recorded since must not move a month that has
  // already been paid. asOfEmp carries the historical heading into
  // calculatePfFor below, so PF eligibility is judged the same way.
  const asOf = ratePayAsOf(emp, dateList[0]);
  const asOfEmp = Object.assign({}, emp, asOf);
  const heading = SALARY_HEADINGS[asOf.salaryHeading] || SALARY_HEADINGS.managerial;
  const rate = asOf.ratePay;
  const leaveAmount = monthDays ? (rate / monthDays * leaveDays) : 0;
  let basic, hra, lta;
  if(heading.flat){
    basic = rate - leaveAmount;
    hra = 0; lta = 0;
  } else {
    basic = (rate*heading.basicPct) - (rate*heading.basicPct)/monthDays*leaveDays;
    hra   = (rate*heading.hraPct)   - (rate*heading.hraPct)/monthDays*leaveDays;
    lta   = (rate*heading.ltaPct)   - (rate*heading.ltaPct)/monthDays*leaveDays;
  }
  const gross = basic + hra + lta;
  // basic and hra here are ALREADY reduced for unpaid leave, so this is the
  // final payable wage the policy requires PF to be charged on, not the
  // contracted figure. One central call serves both sides of the contribution.
  const pfWage = PF_RULES.wageComponents.reduce((t, k) => t + ({ basic, hra, lta }[k] || 0), 0);
  const pfCalc = calculatePfFor(asOfEmp, pfWage);
  const pf = pfCalc.employee;
  const esiCalc = heading.esi ? computeEsi(gross, {
        isDisabled: emp.esiDisabled === 'yes',
        coveredAtPeriodStart: emp.esiCoveredAtPeriodStart === 'yes',
        eligible: emp.esiEligible !== 'no',
        asOf: dateList[0]
      }) : { employee:0, employer:0 };
  const esi = esiCalc.employee;
  const pt = heading.pt ? monthlyPtFor(gross, emp.ptPaidThisYear) : 0;
  const [dYear, dMonth] = dateList[0].split('-').map(Number);
  const monthYm = dateList[0].slice(0, 7);
  const advanceTemp = advanceTempForMonth(emp, monthYm);
  const advance = salaryAdvanceForMonth(emp, monthYm);
  // Nothing recovered this month because no entry matches it is correct by
  // design (see salaryAdvanceForMonth) — an April entry only ever affects
  // April. On screen it is indistinguishable from "nobody ever entered
  // anything for this employee" unless flagged, which is exactly what was
  // reported as "advance not deducting" for an employee who in fact only
  // had an entry for a different month. Only fires when this employee
  // genuinely has Salary Advance Payment history recorded for SOME month —
  // an employee with no history at all is correctly silent, nothing to warn
  // about.
  const advanceHist = emp.advanceHistory || [];
  const advanceMissingThisMonth = !advance && advanceHist.length > 0 && !advanceHist.some(h => h.month === monthYm);
  const retention = computeRetentionForMonth(emp, dYear, dMonth);
  const loanEmi = computeLoanEmiForMonth(emp, dYear, dMonth);
  const loanBalance = loanBalanceAfterMonth(emp, dYear, dMonth);
  const totalDeduction = pf + esi + pt + advanceTemp + advance + loanEmi + retention;
  // Money already in the employee's account. It is not a statutory deduction
  // and must not sit inside Total Deduction — Gross, PF, ESI and PT are all
  // computed as if it were not there. It only reduces what is left to pay.
  const directPaid = directPaidForMonth(emp, heading, monthYm);
  // Paid over and above the salary, not part of it. Deliberately outside Gross,
  // so it changes neither PF, ESI, PT nor the Diwali bonus — it is money for
  // petrol, not earnings. It is not reduced for leave either: a flat monthly
  // conveyance is agreed as a figure, and HR lowers it on the record if a month
  // warrants less.
  const conveyance = Number(emp.conveyance) || 0;
  const netBeforeDirect = gross - totalDeduction + conveyance;
  const netSalary = netBeforeDirect - directPaid;
  // Employer side, from the same call — never recomputed.
  const pen = pfCalc.employerEps;
  const employerPf = pfCalc.employerEpf;
  const pfAdmin = pfCalc.admin;
  const edli    = pfCalc.edli;
  const esiEmployer = esiCalc.employer;
  const employerCont = pen + employerPf + pfAdmin + edli + esiEmployer;
  const ctc = gross + employerCont;
  // Balances carried forward. Opening figures are entered once per employee;
  // from there the sheet subtracts what this month recovers or uses, so the
  // closing figure is what the next month opens with.
  const advanceBalance = advanceBalanceAfterMonth(emp, dYear, dMonth);
  // Leave balance is the opening figure less everything used since the
  // financial year began, not just this month. Taking only the current month
  // would show the same balance every month and never run down.
  const ytd = leaveUsedThisFinancialYear(att, dateList[dateList.length - 1], emp.leaveOpeningFrom);
  const fullDayLeaveBal = Math.max(0, (Number(emp.elOpening) || 0) - ytd.el);
  const halfDayLeaveBal = Math.max(0, (Number(emp.slOpening) || 0) - ytd.sl);
  return { rate, leaveDays, leaveAmount, basic, hra, lta, gross, pf, esi, pt, advanceTemp, advance, advanceMissingThisMonth,
           policyHalfDays: policyHalf.total, policyHalfReasons: policyHalf.reasons,
           sandwichDays: sandwichDates.length, sandwichDates,
           conveyance,
           loanEmi, loanBalance,
           retention, totalDeduction, netSalary, pen, employerPf, pfAdmin, edli, employerCont, ctc,
           esiEmployer, advanceBalance, fullDayLeaveBal, halfDayLeaveBal,
           pfWage, pfType: pfCalc.type, pfApplicable: pfCalc.applicable, pfReason: pfCalc.reason,
           directPaid, netBeforeDirect,
           pfEmployeeTotal: pfCalc.employeeTotal, pfEmployerTotal: pfCalc.employerTotal,
           pfGrandTotal: pfCalc.grandTotal,
           // pen/employerPf above already carry the merge (employerPf holds
           // the combined figure, pen is 0) for the two HR-confirmed
           // exceptions — this flag is only so a report can label that
           // column "Employer PF (combined)" instead of implying a real
           // zero Pension/EPS contribution.
           employerPfMerged: pfCalc.employerPfMerged };
}

// One salary per employee per run, not one per report.
//
// The six reports in the monthly pack each need every employee's salary, and
// each was working it out for itself — measured at 4.3 computations per
// employee to produce one pack. Correct, because the calculation is pure and
// gives the same answer every time, but four times the work for nothing.
//
// withSalaryCache runs a block with those repeats collapsed. Inside it, the
// inputs are fixed by construction — one month, one snapshot of the records,
// one set of attendance — which is what makes the answer safe to reuse. The
// cache is torn down on the way out whether the block succeeds or throws, so
// nothing can leak into a later run with different data.
//
// Outside a withSalaryCache block nothing caches at all and every call
// computes, which is why the app screens needed no changes.
let salaryCache_ = null;
function withSalaryCache(fn){
  const outer = salaryCache_;          // nested calls reuse the outer cache
  if(!outer) salaryCache_ = new Map();
  try { return fn(); }
  finally { if(!outer) salaryCache_ = null; }
}
function salaryFor_(emp, att, dateList, monthDays, holidayMap){
  if(!salaryCache_) return computeSalaryFromAttendance(emp, att, dateList, monthDays, holidayMap);
  // The month is part of the key as well as the employee: a caller that builds
  // two months inside one block must not be handed January's figures for
  // February.
  const key = emp.id + '|' + dateList[0] + '|' + monthDays;
  let hit = salaryCache_.get(key);
  if(hit === undefined){
    hit = computeSalaryFromAttendance(emp, att, dateList, monthDays, holidayMap);
    salaryCache_.set(key, hit);
  }
  return hit;
}

// ---- payroll formula master ----
// The single place that says how each salary heading is arrived at. The engine
// below walks this list; it knows nothing about Basic or HRA specifically, so
// adding a heading or changing how one is computed is an edit HERE and nowhere
// else. Percentages themselves are not repeated here — the split lives in
// SALARY_HEADINGS, which is what the Salary Sheet itself reads, so the form and
// the sheet cannot drift apart.
//
// source:
//   split   — a share of Rate of Pay taken from the selected heading
//   ptRule  — the configured professional tax rule
//   sum     — adds other components
//   diff    — subtracts other components
//   manual  — NO formula is configured for this heading, so HR types the amount
//
// A heading is manual only because the master says so. Configure a rate for PF
// or ESI here (source:'percent', of:'basic', pct:0.12) and the form will derive
// it automatically from the next render on, with no code change.
const PAYROLL_MASTER = [
  { key:'basic', label:'Basic Pay',  group:'earning',   source:'split', part:'basic' },
  { key:'hra',   label:'HRA',        group:'earning',   source:'split', part:'hra'   },
  { key:'lta',   label:'LTA',        group:'earning',   source:'split', part:'lta'   },
  { key:'gross', label:'Gross Salary', group:'total',   source:'sum',   of:['basic','hra','lta'] },
  { key:'pf',    label:'PF — employee (12%)', group:'deduction', source:'pfEmployee', flag:'pf' },
  { key:'pfEmployerEps', label:'PF — employer to EPS (8.33%)', group:'employer', source:'pfEps', flag:'pf' },
  { key:'pfEmployerEpf', label:'PF — employer to EPF (3.67%)', group:'employer', source:'pfEpf', flag:'pf' },
  { key:'pfAdmin', label:'PF admin (0.5%)', group:'employer', source:'pfAdmin', flag:'pf' },
  { key:'pfEdli',  label:'EDLI (0.5%)',     group:'employer', source:'pfEdli',  flag:'pf' },
  { key:'esi',   label:'ESI — employee (0.75%)', group:'deduction', source:'esiEmployee', flag:'esi' },
  { key:'esiEmployer', label:'ESI — employer (3.25%)', group:'employer', source:'esiEmployer', flag:'esi' },
  { key:'pt',    label:'Professional Tax (PT)', group:'deduction', source:'ptRule', flag:'pt' },
  // Money being recovered from the employee. Not statutory, and not worked out
  // from the Rate of Pay — they are figures on the employee's own record — but
  // they come out of the same net, so they belong in the same total. Leaving
  // them out is what had this breakdown showing a net ₹7,500 above the Salary
  // Sheet for anybody repaying anything.
  { key:'advanceTemp', label:'Advance for temporary', group:'deduction', source:'recovery' },
  { key:'advance',     label:'Salary Advance Payment', group:'deduction', source:'recovery' },
  { key:'loanEmi',     label:'Loan instalment',       group:'deduction', source:'recovery' },
  { key:'retention',   label:'Retention money',       group:'deduction', source:'recovery' },
  { key:'totalDeduction', label:'Total Deductions', group:'total', source:'sum',
    of:['pf','esi','pt','advanceTemp','advance','loanEmi','retention'] },
  { key:'net',   label:'Net Salary', group:'total', source:'diff', from:'gross', minus:['totalDeduction'] },
  // The employer side is a cost, never a deduction from pay — kept out of
  // Total Deductions and Net so neither is understated.
  // Everything the company pays on top, matching what the Salary Sheet totals.
  // It summed only the two PF halves, leaving out the employer's ESI, PF admin
  // and EDLI — so the CTC on the form came out lower than the CTC on the sheet
  // for the same employee.
  { key:'employerTotal', label:'Employer Contribution', group:'total', source:'sum',
    of:['pfEmployerEps','pfEmployerEpf','pfAdmin','pfEdli','esiEmployer'] },
  { key:'ctc', label:'Cost to Company', group:'total', source:'sum', of:['gross','employerTotal'] }
];

// Runs the master against one Rate of Pay and one heading. Returns every
// component with its value, whether it was derived or typed, and the formula
// used — the same numbers computeSalaryForEmployee produces for a full-
// attendance month, because both read the split from SALARY_HEADINGS.
//
// `ctx` supplies the four answers that change PF and ESI for an individual —
// prior UAN, Form 11, disability, already-covered. Passed in, the master can be
// run for a stored employee with no form on screen, which is what the reports
// need. Left out, it reads the open form exactly as before.
function computePayrollComponents(rate, headingKey, manual, ctx){
  const h = SALARY_HEADINGS[headingKey] || SALARY_HEADINGS.managerial;
  const r = Number(rate) || 0;
  const m = manual || {};
  const c = ctx || payrollFormContext();
  const out = [];
  const val = k => { const c = out.find(x => x.key === k); return c ? c.value : 0; };

  PAYROLL_MASTER.forEach(def => {
    // A heading the selected structure does not attract at all is not shown.
    if(def.flag && !h[def.flag]){
      out.push({ ...def, applies:false, auto:true, value:0, formula:'Not applicable to ' + h.label });
      return;
    }
    let value = 0, formula = '', auto = true, missing = false;

    if(def.source === 'split'){
      const pct = h.flat ? (def.part === 'basic' ? 1 : 0) : h[def.part + 'Pct'];
      if(typeof pct !== 'number'){ missing = true; formula = 'No share configured for ' + def.label; }
      else { value = r * pct; formula = h.flat && def.part === 'basic'
        ? 'Rate of Pay (this structure pays the full rate as Basic)'
        : 'Rate of Pay × ' + headingPct(pct); }
    } else if(def.source === 'percent'){          // available for future config
      const base = def.of === 'rate' ? r : val(def.of);
      if(typeof def.pct !== 'number'){ missing = true; formula = 'No rate configured'; }
      else { value = base * def.pct; formula = (def.of === 'rate' ? 'Rate of Pay' : def.of) + ' × ' + headingPct(def.pct); }
    } else if(def.source === 'pfEmployee' || def.source === 'pfEps' || def.source === 'pfEpf'
              || def.source === 'pfAdmin' || def.source === 'pfEdli'){
      // Through calculatePfFor, the same call the Salary Sheet makes. This
      // branch used to apply the percentages itself, checking only the heading
      // and the statutory exclusion — so an employee marked PF Eligible: No
      // still had PF, an employer share and a CTC worked out in the breakdown,
      // while the PF box six lines above correctly read nil. The flat ₹1,800
      // option was ignored here for the same reason.
      const pfWage = pfWageOf(out);
      const probe = { salaryHeading: headingKey,
                      pfEligible: c.pfEligible, pfContributionType: c.pfContributionType,
                      hasPriorUan: c.hasPriorUan, form11Submitted: c.form11Submitted };
      const pf = calculatePfFor(probe, pfWage);
      value = def.source === 'pfEmployee' ? pf.employee
            : def.source === 'pfEps'      ? pf.employerEps
            : def.source === 'pfEpf'      ? pf.employerEpf
            : def.source === 'pfAdmin'    ? pf.admin : pf.edli;
      const base = PF_RULES.wageComponents
        .map(k => (PAYROLL_MASTER.find(x => x.key === k) || {}).label || k)
        .join(' + ') + ' (₹' + fmtMoney(pfWage) + ')';
      if(!pf.applicable){
        // Not configured is a gap to fill, not a settled nil, so it is flagged
        // as missing and the save refuses until somebody answers it.
        out.push({ ...def, applies:true, auto:true, value:0,
                   formula: pf.reason, missing: !!pf.notConfigured });
        return;
      }
      if(pf.type === 'fixed'){
        formula = 'Fixed ₹' + fmtMoney(PF_RULES.fixedAmount) + ' each side — not a percentage of anything' +
                  (def.source === 'pfEps' ? ', and the EPS split does not apply' : '') +
                  ((def.source === 'pfAdmin' || def.source === 'pfEdli') ? ', and no admin or EDLI is charged' : '');
      } else if(def.source === 'pfAdmin' || def.source === 'pfEdli'){
        formula = headingPct(def.source === 'pfAdmin' ? PF_RULES.adminPct : PF_RULES.edliPct) +
                  ' of ' + base + ' — employer only, over and above the 12% share';
      } else {
        const capped = pfWage >= PF_RULES.epsWageCeiling;
        formula = def.source === 'pfEmployee'
          ? headingPct(PF_RULES.employeePct) + ' of ' + base
          : def.source === 'pfEps'
            ? headingPct(PF_RULES.epsPct) + ' of ' + base +
              (capped ? ', capped at ₹' + fmtMoney(PF_RULES.epsMonthlyCap) +
                ' because the wage is above ₹' + fmtMoney(PF_RULES.epsWageCeiling) : '')
            : headingPct(PF_RULES.employerPct) + ' of ' + base + ' less the EPS share' +
              (capped ? ' — more than ' + headingPct(0.0367) + ' here, since EPS is capped' : '');
      }
    } else if(def.source === 'esiEmployee' || def.source === 'esiEmployer'){
      const gr = out.find(x => x.key === 'gross');
      const r = computeEsi(gr ? gr.value : 0, {
        isDisabled: c.isDisabled,
        coveredAtPeriodStart: c.coveredAtPeriodStart,
        eligible: c.esiEligible !== 'no'
      });
      value = def.source === 'esiEmployee' ? r.employee : r.employer;
      formula = r.reason;
    } else if(def.source === 'ptRule'){
      const gross = val('gross');
      value = monthlyPtFor(gross, 0);
      formula = 'Nil up to ₹' + fmtMoney(PT_GROSS_THRESHOLD) + ' gross; ₹' + fmtMoney(PT_AMOUNT) +
                ' a month above it, capped at ₹' + fmtMoney(PT_ANNUAL_CAP) + ' a year';
    } else if(def.source === 'recovery'){
      value = Number((c.recovery || {})[def.key]) || 0;
      formula = ({
        advanceTemp: 'Temporary advance being recovered this month, from the employee record',
        advance:     'Advance being recovered this month, from the employee record',
        loanEmi:     'This month\'s instalment on the loans recorded against this employee',
        retention:   'Retention money withheld this month under the bond'
      })[def.key] || 'From the employee record';
    } else if(def.source === 'sum'){
      value = def.of.reduce((s, k) => s + val(k), 0);
      formula = def.of.map(k => (PAYROLL_MASTER.find(x => x.key === k) || {}).label || k).join(' + ');
    } else if(def.source === 'diff'){
      value = val(def.from) - def.minus.reduce((s, k) => s + val(k), 0);
      formula = (PAYROLL_MASTER.find(x => x.key === def.from) || {}).label + ' − ' +
                def.minus.map(k => (PAYROLL_MASTER.find(x => x.key === k) || {}).label || k).join(' − ');
    } else if(def.source === 'manual'){
      auto = false;
      value = Number(m[def.key]) || 0;
      formula = def.note || 'Entered manually.';
    } else {
      missing = true; formula = 'Unknown formula type "' + def.source + '"';
    }
    out.push({ ...def, applies:true, auto, value, formula, missing });
  });
  return out;
}

// Bonus is a full month's gross — Basic plus HRA plus LTA on the employee's
// salary heading. Confirmed by HR twice: no deduction of any kind comes off it,
// for any employee. Not PF, not ESI, not Professional Tax, not a loan
// instalment, not an advance, not retention money, and not one rupee for leave
// — however many days somebody lost that year, their bonus is a whole month.
// That is why this function takes only the employee and never the month, the
// date list or the attendance: it has nothing to read them for. Those all reduce what is paid in a given month; none of them change
// what a month is worth, which is what the bonus is a month of.
//
// So this function takes no deduction as an argument and must not grow one. If
// a future change needs the bonus net of something, that belongs at the place
// the money is paid, not here — otherwise the Diwali Bonus Report, the CTC
// report and the figure on the employee form stop agreeing with each other.
//
// Derived from Rate of Pay and the heading rather than from the stored basic
// and hra fields, so it is right for every employee already on file without
// anything being recalculated or re-saved, and it cannot drift from the Gross
// column on the Salary Sheet.
function diwaliBonusFor(emp){
  if(emp.diwaliEligible !== 'yes') return 0;
  // The amount entered against the employee, and nothing else. HR sets what
  // each person is paid; the app does not decide it for them.
  const manual = Number(emp.diwaliBonusAmount) || 0;
  return manual > 0 ? Math.round(manual * 100) / 100 : 0;
}

let editingEmployeeDraft = null;

// What is being recovered from this employee for one month. Loan, retention
// and advance are all month-dependent — ym defaults to the current month so
// the figure shown live on the open form (nobody has asked about a specific
// past month there) is "today's", the same one the Salary Sheet uses when
// that month is actually run; every other caller passes the month it
// actually means.
function payrollRecoveryFrom(src, ym){
  const target = ym || todayStr().slice(0, 7);
  const [y, m] = target.split('-').map(Number);
  return {
    advanceTemp: advanceTempForMonth(src, target),
    advance: salaryAdvanceForMonth(src, target),
    loanEmi: computeLoanEmiForMonth(src, y, m),
    retention: computeRetentionForMonth(src, y, m)
  };
}

// The four per-person answers, read from the open form.
function payrollFormContext(){
  return {
    hasPriorUan: (document.getElementById('f_hasPriorUan') || {}).value || '',
    form11Submitted: (document.getElementById('f_form11') || {}).value || '',
    pfEligible: (document.getElementById('f_pfEligible') || {}).value || '',
    pfContributionType: (document.getElementById('f_pfContributionType') || {}).value || '',
    isDisabled: (document.getElementById('f_esiDisabled') || {}).value === 'yes',
    coveredAtPeriodStart: (document.getElementById('f_esiCovered') || {}).value === 'yes',
    esiEligible: (document.getElementById('f_esiEligible') || {}).value || '',
    // Built from the form as it stands, including any loan/advance rows
    // typed but not yet saved, so the breakdown answers for what is on
    // screen.
    recovery: payrollRecoveryFrom({
      advanceHistory: (typeof editingEmployeeDraft === 'object' && editingEmployeeDraft && editingEmployeeDraft.advanceHistory) || [],
      advanceTempSchedule: (typeof editingEmployeeDraft === 'object' && editingEmployeeDraft && editingEmployeeDraft.advanceTempSchedule) || null,
      loans: (typeof editingEmployeeDraft === 'object' && editingEmployeeDraft && editingEmployeeDraft.loans) || [],
      retentionMoney: (document.getElementById('f_retentionMoney') || {}).value,
      retentionMonths: (document.getElementById('f_retentionMonths') || {}).value,
      bondStart: (document.getElementById('f_bondStart') || {}).value
    })
  };
}

// The same four, read from a stored record, for whichever month ym names
// (defaults to the current month, same reasoning as payrollRecoveryFrom).
function payrollRecordContext(emp, ym){
  const e = emp || {};
  return {
    hasPriorUan: e.hasPriorUan || '',
    form11Submitted: e.form11Submitted || '',
    pfEligible: e.pfEligible || '',
    pfContributionType: e.pfContributionType || '',
    isDisabled: e.esiDisabled === 'yes',
    coveredAtPeriodStart: e.esiCoveredAtPeriodStart === 'yes',
    esiEligible: e.esiEligible || '',
    recovery: payrollRecoveryFrom(e, ym)
  };
}

// One monthly figure for one stored employee, at full attendance.
//
// Basic and HRA stopped being typed when Rate of Pay became the only salary
// input, so anything still adding up `emp.basic + emp.hra` reads zero for
// everybody hired since — which is what had the Salary, CTC and Increment
// reports showing ₹0 and their cards claiming nobody had any data. Every
// surface that wants a month's pay without attendance now derives it here,
// from the same master the Salary Sheet uses, so they cannot drift apart
// again.
function monthlyPayFor(emp, asOfYear, asOfMonth){
  const now = new Date();
  const y = asOfYear || now.getFullYear();
  const m = asOfMonth || (now.getMonth() + 1);
  // Rate of Pay and heading as they stood in the month being asked about —
  // "now" by default, so every caller that does not pass a month (the
  // dashboard, the Increment and CTC reports) still means "their salary
  // today" — not whatever they are asked about for a specific past month.
  const ym = y + '-' + String(m).padStart(2, '0');
  const asOf = ratePayAsOf(emp, ym + '-01');
  const asOfEmp = Object.assign({}, emp, asOf);
  const comps = computePayrollComponents(asOf.ratePay, asOf.salaryHeading, {}, payrollRecordContext(emp, ym));
  const val = k => { const c = comps.find(x => x.key === k); return c && c.applies ? (Number(c.value) || 0) : 0; };
  const heading = SALARY_HEADINGS[asOf.salaryHeading] || SALARY_HEADINGS.managerial;
  const basic = val('basic'), hra = val('hra'), lta = val('lta');
  const salaryGross = basic + hra + lta;

  // PF, ESI and PT come from the calls computeSalaryForEmployee itself makes,
  // not from the component master. The master applies the percentages to
  // anyone whose heading attracts PF; the Salary Sheet goes through
  // calculatePfFor, which also honours the PF Eligible answer and the flat
  // ₹1,800 option. Reading the master here would have a report quoting a
  // deduction the sheet does not take — ₹3,000 against an employee whose
  // eligibility was never set, whose sheet shows nil.
  const pfWage = PF_RULES.wageComponents.reduce((t, k) => t + ({ basic, hra, lta }[k] || 0), 0);
  const pfCalc = calculatePfFor(asOfEmp, pfWage);
  const esiCalc = heading.esi ? computeEsi(salaryGross, {
        isDisabled: emp.esiDisabled === 'yes',
        coveredAtPeriodStart: emp.esiCoveredAtPeriodStart === 'yes',
        eligible: emp.esiEligible !== 'no'
      }) : { employee:0, employer:0 };
  const pt = heading.pt ? monthlyPtFor(salaryGross, emp.ptPaidThisYear) : 0;

  const other = (Number(emp.otherAllowances) || 0);
  const perks = (Number(emp.dressAllowance) || 0) + (Number(emp.mobileExpense) || 0);
  // Paid on top and outside gross, so it lifts what is handed over without
  // touching PF, ESI, PT or the bonus.
  const conveyance = Number(emp.conveyance) || 0;
  // The same four the Salary Sheet takes off, not just the loan. Advance,
  // temporary advance and retention were missing here, so the Salary Report and
  // the payslip showed a net above what the sheet pays.
  const rec = payrollRecoveryFrom(emp, ym);
  const emi = rec.loanEmi;
  const statutory = pfCalc.employee + esiCalc.employee + pt;
  const recovered = rec.advanceTemp + rec.advance + rec.loanEmi + rec.retention;
  return {
    basic, hra, lta,
    salaryGross,                       // Basic + HRA + LTA — what PF, ESI and PT are read against
    other, perks,
    gross: salaryGross + other,        // what the employee is paid before deductions
    ctcGross: salaryGross + other + perks + conveyance,  // plus what the company spends on dress and mobile
    pf: pfCalc.employee, esi: esiCalc.employee, pt,
    pfReason: pfCalc.reason,
    esiEmployer: esiCalc.employer, employerTotal: pfCalc.employerTotal + esiCalc.employer,
    emi, statutory, conveyance,
    advanceTemp: rec.advanceTemp, advance: rec.advance, retention: rec.retention,
    recovered,
    deductions: statutory + recovered,
    net: salaryGross + other + conveyance - statutory - recovered
  };
}

// What one day reads as for one employee — an explicit code if one was
// recorded, else a declared holiday or Sunday, else Absent for a day up to
// and including today, else unknown (a future date, no opinion yet).
// Mirrors computeAttendanceSummary's own resolution exactly, so a day shown
// here can never disagree with what that function counts it as for payroll
// and every other report — kept as its own small function rather than
// folded into that one, since computeAttendanceSummary only ever needed the
// running totals, not the individual day.
function resolvedAttendanceCode_(att, dateStr, holidayMap){
  const entry = (att || {})[dateStr];
  const isHoliday = !!(holidayMap && holidayMap[dateStr]);
  if(entry){
    // The Holiday section is the single source of truth for which days are
    // paid holidays — a code already on file for this date (saved before
    // the holiday was declared, or bulk-filled as Absent by the "unmarked
    // past day defaults to absent" rule below, before anyone added it) must
    // not keep charging it as absence or leave once it is one. See
    // HOLIDAY_OVERRIDE_CODES for exactly which codes this applies to.
    //
    // Only from PH_RULE_EFFECTIVE_FROM onward. Overriding a code that is
    // already on file is the one genuinely NEW behaviour here, and letting
    // it reach backwards would silently restate months that have already
    // been paid and filed — a closed month's Salary Sheet, payslips and
    // Consultant Report would all start reading differently than when they
    // were issued, purely because a holiday was added to the list later.
    // Before that date a saved code is returned exactly as stored, which is
    // precisely what this function did before the rule existed.
    if(isHoliday && dateStr >= PH_RULE_EFFECTIVE_FROM && HOLIDAY_OVERRIDE_CODES.has(entry.code)) return 'H';
    return entry.code;
  }
  // An UNMARKED day on a declared holiday has always resolved to 'H', in
  // every month — that predates this rule and is not gated by it, so
  // historical months keep behaving as they always have.
  if(isHoliday) return 'H';
  if(new Date(dateStr + 'T00:00:00').getDay() === 0) return 'H';
  return dateStr <= todayStr() ? 'A' : null;
}

// Privilege leave earned, used and left for one financial year, with what the
// remainder is worth. Shared by the Leave Balance Next Year Report and the
// Leave Encashment Report — two reports that disagreed about how many days
// somebody had pending would be worse than having only one of them.
async function elFyRows(employees, startYear){
  const fyStart = fyOfStartYear(startYear).from;
  const fyEnd = fyOfStartYear(startYear).to;
  const rows = [];
  // One request for everyone's attendance before the loop; each read below
  // then comes from the primed cache instead of its own round trip.
  await getAttendanceMany(employees.map(e => e.id));
  for(const emp of employees){
    const att = await getAttendance(emp.id);
    let presentDays = 0, elUsed = 0;
    Object.keys(att).forEach(dateStr => {
      if(dateStr < fyStart || dateStr > fyEnd) return;
      const code = att[dateStr].code;
      if(code === 'P' || code === 'EL' || code === 'SL') presentDays += 1;
      else if(code === 'HEL' || code === 'HSL' || code === 'HLP') presentDays += 0.5;
      if(code === 'EL') elUsed += 1;
      else if(code === 'HEL') elUsed += 0.5;
    });
    const opening = Number(emp.elOpening) || 0;
    // What is earned THIS year is not usable until NEXT year — "earned in
    // year 1, usable from year 2" (LEAVE_POLICY.privilegeLeave.usableInFirstYear)
    // — so it is never part of what gets paid for the year that is closing.
    // It only carries forward automatically as next year's opening balance.
    const earned = Math.floor(presentDays / LEAVE_POLICY.privilegeLeave.earnedPerAttendanceDays);
    // What is actually payable now: whatever was already usable this year
    // (last year's earned days, i.e. this year's opening) and went unused. A
    // negative figure is leave taken beyond what was available and is not an
    // encashment of less than nothing.
    const unusedOpening = Math.max(0, opening - elUsed);
    // Kept only for the legacy "carry the whole balance forward, no cash"
    // option — the old opening leftover plus this year's earned days, in one
    // figure, the way EL used to be rolled over before encashment was
    // automated. Deliberately NOT floored at nil here: a negative figure is
    // leave taken beyond what was available, and carrying that debt forward
    // is the point of this legacy path — flooring it would forgive it instead.
    const closing = opening + earned - elUsed;
    const cash = plEncashmentFor(emp, unusedOpening);
    rows.push({ emp, id: emp.id, name: emp.name, opening, presentDays, earned, elUsed,
                unusedOpening, closing, nextOpening: earned,
                pending: unusedOpening, monthly: cash.monthly, basis: cash.basis,
                perDay: cash.perDay, amount: cash.amount });
  }
  return rows;
}

// ---- leave detail reports: late coming / EL-PL / SL / half day / short leave, broken out per category ----
// EL and PL are the same figure — the app only ever stores one earned-leave
// code (EL) — so there is one combined column rather than two that would
// always read identically. Half Day is one combined count too, regardless of
// whether it came from a half-EL, half-SL, half-LP or a late-coming
// escalation, matching how the Attendance Sheet already reports it.
// Full Day Leave sits next to Half Day on purpose: the two are the whole-day
// and part-day counterparts of the same question. It is Absent plus Leave
// Without Pay — the leave the other columns do not already cover, EL/PL and
// SL having their own. HLP contributes its 0.5 here and still counts as one
// half-day instance, exactly as HEL and HSL do for EL and SL, so the columns
// treat a half day the same way whichever kind it is.
const LEAVE_DETAIL_METRICS = [
  { key:'lateCount',    label:'Late Coming' },
  { key:'elUsed',       label:'EL / PL' },
  { key:'slUsed',       label:'SL' },
  { key:'fullDayLeave', label:'Full Day Leave' },
  { key:'halfDays',     label:'Half Day' },
  { key:'shortCount',   label:'Short Leave' }
];


// ---- leave applied for in advance ----
// The dates leave would actually be taken on. Sundays and declared holidays
// are stepped over: they are not working days, so charging a day of EL against
// one would spend a leave day the employee never took. The sandwich rule still
// has its say — the policy engine raises it as a note on the application, where
// somebody can see it and decide, rather than it being applied silently here.
function leaveWorkingDays(fromStr, toStr, holidayMap){
  const out = [];
  if(!fromStr || !toStr || toStr < fromStr) return out;
  const end = new Date(toStr + 'T00:00:00');
  for(let d = new Date(fromStr + 'T00:00:00'); d <= end; d.setDate(d.getDate() + 1)){
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
                '-' + String(d.getDate()).padStart(2, '0');
    if(d.getDay() === 0) continue;               // Sunday
    if(holidayMap && holidayMap[iso]) continue;  // declared holiday
    out.push(iso);
  }
  return out;
}


// "Always mark Present" filled in across a window, without fetching anything.
//
// Kept here rather than in index.html because it decides WHAT the payroll and
// attendance calculations are handed: an Always-Present employee has no
// attendance rows saved, and computeAttendanceSummary reads an unmarked past
// day as Absent. If the report emails skipped this they would run the very
// same arithmetic over different input and quietly disagree with the screen.
//
// `todayIso` is passed in rather than read from the clock so the caller
// decides what "today" means — the app uses the browser's, Apps Script uses
// the IST date, and a test can pin it.
// Returns fresh per-employee objects; the ones passed in may be held by a
// shared read cache.
function applyAlwaysPresentFill(attByEmpId, employees, holidayMap, fromStr, toStr, todayIso){
  (employees || []).forEach(emp => {
    if(!emp || !emp.alwaysPresentFrom || !attByEmpId[emp.id]) return;
    const cutoff = (emp.employmentStatus === 'left' && emp.leftDate) ? emp.leftDate : todayIso;
    const from = (fromStr && fromStr > emp.alwaysPresentFrom) ? fromStr : emp.alwaysPresentFrom;
    const to = (toStr && toStr < cutoff) ? toStr : cutoff;
    const filled = Object.assign({}, attByEmpId[emp.id]);
    leaveWorkingDays(from, to, holidayMap).forEach(dateStr => {
      if(!filled[dateStr]) filled[dateStr] = { code: 'P' };
    });
    attByEmpId[emp.id] = filled;
  });
  return attByEmpId;
}

// One employee's Monthly Leave Detail figures. The report screen and the
// report email both call this, so the row in the attachment and the row on
// screen are the same row.
function leaveDetailRowFor(emp, att, dateList, holidayMap){
  const s = computeAttendanceSummary(att, emp, dateList, holidayMap);
  return { name: emp.name, lateCount: s.lateCount, elUsed: s.elUsed, slUsed: s.slUsed,
           fullDayLeave: s.absent + s.lpDays, halfDays: s.halfDays, shortCount: s.shortCount };
}

// The whole report: a row per employee who actually took something. Anyone
// with a zero in every column is left out — a row of dashes tells HR nothing
// and buries the handful who did. Driven off LEAVE_DETAIL_METRICS so a column
// added to that config is part of the test automatically.
function leaveDetailReportRows(employees, attByEmpId, dateList, holidayMap){
  const all = (employees || []).map(e => leaveDetailRowFor(e, attByEmpId[e.id] || {}, dateList, holidayMap));
  return { all, rows: all.filter(r => LEAVE_DETAIL_METRICS.some(m => (r[m.key] || 0) > 0)) };
}
function leaveDetailCsvHeader(){ return ['Name'].concat(LEAVE_DETAIL_METRICS.map(m => m.label)); }
function leaveDetailCsvRows(rows){
  return rows.map(r => [r.name].concat(LEAVE_DETAIL_METRICS.map(m => r[m.key] || 0)));
}


// ---- Loan & Advance Report rows ----
// One row per loan, not per employee — somebody repaying two shows twice,
// which is the point of a ledger. Recovered-so-far and balance are worked out
// from the start month rather than stored, so they cannot go stale between
// months.
//
// Shared so the report screen and the monthly email produce the same ledger.
// `nowY`/`nowM` are passed in rather than read from the clock: the app asks
// about today, the email asks about the month it is reporting on, and a test
// can pin either.
function loanLedgerRows(employees, nowY, nowM){
  const nowYm = nowY + '-' + String(nowM).padStart(2, '0');
  const ledger = [];
  (employees || []).forEach(e => loansOf(e).forEach((l, i) => ledger.push({ e, l, i })));
  // Anything still being recovered first, biggest balance at the top: the
  // report exists to show what is outstanding, and a closed loan is history.
  ledger.sort((a, b) =>
    (Number(b.l.status === 'active') - Number(a.l.status === 'active')) ||
    (loanBalanceAfter(b.l, nowY, nowM) - loanBalanceAfter(a.l, nowY, nowM)) ||
    String(a.e.name || '').localeCompare(String(b.e.name || '')));
  return ledger.map(({ e, l, i }) => {
    const amount = Number(l.amount) || 0;
    const bal = loanBalanceAfter(l, nowY, nowM);
    const recovered = l.status === 'active' ? Math.max(0, Math.round((amount - bal) * 100) / 100) : amount;
    const started = l.startMonth || '';
    const stalled = l.status === 'active' && !started;
    const skippedThisMonth = l.status === 'active' && (l.skipMonths || []).indexOf(nowYm) !== -1;
    return {
      emp: e, loan: l, index: i,
      name: e.name, what: l.reason ? l.reason : 'Loan ' + (i + 1),
      amount, balance: l.status === 'active' ? bal : 0,
      recovered: l.status === 'active' ? recovered : amount,
      currentEmi: loanEmiRateAsOf(l, nowYm),
      // What actually comes off this month, which is not the same as the rate
      // above. currentEmi is the instalment in force; a loan already recovered
      // in full, one with no recovery month set, and one skipped this month all
      // still carry a rate but deduct nothing. Adding the rate column up would
      // overstate the month: on August 2026's sixteen loans it reads 50,000
      // against a true 35,000, because three loans sitting at a nil balance
      // still showed "active" with a rate beside them.
      //
      // Note it is loanEmiForMonth and not "balance is zero, so charge zero" —
      // those are different. A loan whose FINAL instalment falls in this month
      // also ends at a nil balance, and that instalment is genuinely deducted;
      // in the same August, Hardik Panchal's closing 2,000 belongs in the
      // total. Only loanScheduleThrough knows which of the two a nil balance is.
      emiThisMonth: loanEmiForMonth(l, nowY, nowM),
      started, stalled, skippedThisMonth,
      note: l.status !== 'active' ? 'closed'
          : stalled ? 'active — no recovery month set, nothing is being deducted'
          // Cleared this month by its own final instalment. It reads "active"
          // on the record because nobody has marked it closed, and saying so
          // beside a nil balance and a live-looking rate is what made HR think
          // three settled loans were still running.
          : (bal === 0 && loanEmiForMonth(l, nowY, nowM) > 0) ? 'fully recovered this month'
          : bal === 0 ? 'fully recovered'
          : skippedThisMonth ? 'active — this month skipped'
          : 'active'
    };
  })
  // A loan appears for as long as it is being repaid, and once more in the
  // month it finishes — that last instalment came off a real salary, so hiding
  // it would take a genuine deduction out of the payroll record. From the month
  // after, it has nothing outstanding and nothing deducted, and drops off.
  //
  // Both conditions are needed. "balance is zero" alone would drop the closing
  // month too; "nothing deducted" alone would drop a loan whose recovery month
  // has not started yet, which is still owed in full.
  .filter(r => r.balance > 0 || r.emiThisMonth > 0);
}
// The one place the Grand Total is worked out, so the figure at the bottom of
// the report on screen and the one in the emailed CSV come from the same sum
// over the same rows rather than each screen adding the column up its own way.
function loanLedgerTotals(rows){
  const sum = k => Math.round((rows || []).reduce((t, r) => t + (Number(r[k]) || 0), 0) * 100) / 100;
  return { count: (rows || []).length, amount: sum('amount'), recovered: sum('recovered'),
           balance: sum('balance'), emiThisMonth: sum('emiThisMonth') };
}

function loanLedgerCsvHeader(){
  return ['Name','Loan','Amount','Current EMI','Recovery from','Recovered so far','Balance','Status'];
}
function loanLedgerCsvRows(rows){
  return rows.map(r => [r.name, r.what, Math.round(r.amount), Math.round(r.currentEmi),
                        r.started || '—', Math.round(r.recovered), Math.round(r.balance), r.note]);
}
// Appended to the CSV as its last line, so the attachment HR opens on a phone
// carries the same totals the report tab shows. The EMI figure is the one that
// is actually deducted, not the sum of the rates in the column above it — a
// month can be skipped, and a closing instalment is only as big as what is
// left — and the Status cell says so, since a bare CSV has no summary line
// above it to explain the difference.
function loanLedgerCsvTotalRow(rows){
  const t = loanLedgerTotals(rows);
  return ['Grand Total', t.count + ' loan(s)', Math.round(t.amount), Math.round(t.emiThisMonth),
          '', Math.round(t.recovered), Math.round(t.balance),
          'EMI total is what actually comes off this month. A loan is listed once more in the month it finishes, then drops off.'];
}


const SALARY_HEADING_ORDER = ['managerial','senior','junior','apprentice','rsit','contractor'];

// Whether an employee counts as on roll for a given past period — true if
// their tenure overlaps it at all: joined on or before the period ends, and
// either never left or left on or after the period starts. A plain "not
// left" filter — which most reports used before this existed — makes a
// leaver vanish from every report for the months they actually worked,
// which is backwards for anything about a specific past month or year: HR
// entering July's data in August for someone who left in July needs them to
// still show up on July's Salary Sheet, PF/ESI return, Attendance Sheet and
// every other period report, right up to the month they actually left.
// Reports about the CURRENT roster (dashboards, the Employee Master list,
// admin tools that act going forward) are correctly left on the plain
// "not left" filter — this is only for a report generated for one specific
// past period.
function employedDuringPeriod_(emp, startStr, endStr){
  if(emp.doj && endStr && emp.doj > endStr) return false;
  if(emp.employmentStatus === 'left' && emp.leftDate && startStr && emp.leftDate < startStr) return false;
  return true;
}

// The leading \uFEFF is a UTF-8 byte order mark, and it is load-bearing on
// Windows. Without it Excel opens a .csv in the system codepage, not UTF-8, so
// every rupee sign arrives as "a,1" and every em dash as "a\u20ac\"" -- which is
// what made the PF and ESI returns unreadable in the Rule Applied column. The
// mark costs three bytes and every other reader ignores it.
function toCsv(headerArr, rowsArr){
  const lines = [headerArr.map(csvEscape).join(',')];
  rowsArr.forEach(r => lines.push(r.map(csvEscape).join(',')));
  return '\uFEFF' + lines.join('\n');
}


// ---- PF / ESI / PT returns ----
// Collected once, here, so the report screen and the monthly email work from
// the same rows. Everything comes off computeSalaryFromAttendance's own return
// value rather than being worked out a second time — the whole reason the PF
// figure on a return can never disagree with the Salary Sheet's.
function statutoryReportData(employees, attByEmpId, dateList, monthDays, holidayMap, key){
  const out = { rows: [], grandTotal: 0,
                pfRows: [], pfTot: { wage:0, employee:0, epf:0, eps:0, admin:0, edli:0, total:0 },
                esiRows: [], esiTot: { gross:0, employee:0, employer:0, total:0 },
                // Who was left off each return, and why. Not rows -- a count
                // and a reason, so the report can account for the difference
                // between headcount and members without listing them.
                pfExcluded: [], esiExcluded: [] };
  const field = key === 'pt' ? 'pt' : key === 'pf' ? 'pf' : 'esi';
  (employees || []).forEach(emp => {
    const s = salaryFor_(emp, attByEmpId[emp.id] || {}, dateList, monthDays, holidayMap);
    // The heading each employee was under THIS month — a promotion recorded
    // since must not move which group a past month's row sits in.
    const headingKey = ratePayAsOf(emp, dateList[0]).salaryHeading || 'managerial';
    const amount = s[field];
    if(amount > 0){ out.rows.push([emp.name, amount, headingKey]); out.grandTotal += amount; }
    const heading = SALARY_HEADINGS[headingKey] || SALARY_HEADINGS.managerial;
    if(key === 'pf' && heading.pf){
      const cfg = pfConfigStatus(emp);
      out.pfRows.push({ emp, headingKey, wage: s.pfWage, applicable: s.pfApplicable,
        notConfigured: !cfg.configured,
        eligible: cfg.configured ? (cfg.eligible ? 'Yes' : 'No') : 'Not configured',
        pfType: s.pfType === 'fixed' ? 'Fixed \u20b9' + fmtMoney(PF_RULES.fixedAmount)
              : s.pfType === 'percent' ? 'Percentage / Actual' : '\u2014',
        leaveDays: s.leaveDays, leaveAmount: s.leaveAmount,
        employee: s.pf, epf: s.employerPf, eps: s.pen, admin: s.pfAdmin, edli: s.edli,
        employeeTotal: s.pfEmployeeTotal, employerTotal: s.pfEmployerTotal,
        total: s.pfGrandTotal, reason: s.pfReason });
      // Employees who are not contributing add nothing to any total.
      if(s.pfApplicable){
        out.pfTot.wage += s.pfWage; out.pfTot.employee += s.pf; out.pfTot.epf += s.employerPf;
        out.pfTot.eps += s.pen; out.pfTot.admin += s.pfAdmin; out.pfTot.edli += s.edli;
        out.pfTot.total += s.pfGrandTotal;
      }
      // Non-contributors are dropped, not listed with a row of zeroes. A PF
      // return is a list of the members being contributed for; somebody marked
      // not eligible has nothing to file and reading past them to find the
      // people who do was the complaint. They add nothing to any total either,
      // so no figure moves -- see pfExcluded below, which keeps the count so
      // the report can still say how many were left out and why.
      if(!s.pfApplicable){
        out.pfExcluded.push({ name: emp.name, reason: s.pfReason || 'Not applicable' });
        out.pfRows.pop();
      }
    }
    if(key === 'esi' && heading.esi){
      const r = computeEsi(s.gross, {
        isDisabled: emp.esiDisabled === 'yes',
        coveredAtPeriodStart: emp.esiCoveredAtPeriodStart === 'yes',
        eligible: emp.esiEligible !== 'no',
        asOf: dateList[0]
      });
      if(r.covered){
        out.esiRows.push({ emp, headingKey, s, r });
        out.esiTot.gross += s.gross; out.esiTot.employee += r.employee;
        out.esiTot.employer += r.employer; out.esiTot.total += r.total;
      } else {
        // Same rule as PF above: an exempt employee -- over the wage ceiling,
        // or marked not eligible -- is not a member of the return, so they are
        // counted and named in esiExcluded rather than filling a row.
        out.esiExcluded.push({ name: emp.name, reason: r.reason || 'Exempt' });
      }
    }
  });
  return out;
}

// UAN, ESI number, PF number, bank account — long digit strings that are
// identifiers, not quantities. Excel's General format turns anything past
// eleven digits into scientific notation, so a UAN of 102058000000 opens as
// 1.02058E+11 and two people whose UANs share their first six digits become
// indistinguishable on a PF return. Worse on the accountant's sheet: past
// fifteen significant digits Excel does not just display the number
// differently, it stores a rounded one, so a sixteen-digit bank account can
// come back with its last digit changed and nothing on screen to say so.
//
// ="..." is the one form Excel reads back as text, digits intact. It is
// applied ONLY to a value that is nothing but digits, which is what every
// identifier here is — so no value HR types can ever leave this function as a
// live formula, and a cell that is genuinely text is left exactly as it was.
function excelIdNumber(v){
  const s = String(v == null ? '' : v);
  return /^\d{11,}$/.test(s) ? '="' + s + '"' : s;
}

// Grouped by salary heading, in the app's own heading order, with a heading
// row before each group — the shape the returns are filed in.
// Everyone dropped from a return is left off for one of two very different
// reasons, and the difference matters. "Marked not eligible" or "above the
// ceiling" is a decision somebody made -- there is nothing to file and nothing
// to chase. "Not configured" is a blank field: nobody has said yet whether that
// person contributes, and quietly dropping them would file a return with a
// member missing and no sign of it. So the deliberate exclusions are counted
// and the unconfigured ones are named, on screen and at the foot of the CSV.
function excludedNote_(excluded, what){
  const list = excluded || [];
  if(!list.length) return '';
  const unconfigured = list.filter(x => /not configured|not selected/i.test(x.reason || ''));
  let note = list.length + ' employee(s) are not ' + what + ' members this month and are not listed.';
  if(unconfigured.length){
    note += ' ' + unconfigured.length + ' of them because ' + what +
      ' has not been set on their record — ' +
      unconfigured.map(x => x.name).join(', ') +
      ' — which is a gap to fill in, not an exemption.';
  }
  return note;
}

function pfReturnCsv(pfRows, pfTot, excluded){
  const body = [];
  let sr = 0;
  SALARY_HEADING_ORDER.forEach(hk => {
    const group = pfRows.filter(x => x.headingKey === hk);
    if(!group.length) return;
    body.push([SALARY_HEADINGS[hk].label]);
    group.forEach(x => {
      sr++;
      const status = x.applicable ? 'Contributing' : (x.notConfigured ? 'Not configured' : 'PF Not Applicable');
      body.push([sr, x.emp.name, x.emp.id, excelIdNumber(x.emp.uan), x.eligible, x.pfType,
        Math.round(x.wage + (x.leaveAmount || 0)), x.leaveDays || 0, Math.round(x.leaveAmount || 0), Math.round(x.wage),
        x.applicable ? Math.round(x.employee) : 0, x.applicable ? Math.round(x.epf) : 0, x.applicable ? Math.round(x.eps) : 0,
        x.applicable ? Math.round(x.edli) : 0, x.applicable ? Math.round(x.admin) : 0,
        x.applicable ? Math.round(x.employeeTotal) : 0, x.applicable ? Math.round(x.employerTotal) : 0,
        x.applicable ? Math.round(x.total) : 0, status, x.reason]);
    });
  });
  return {
    header: ['SR NO','Employee','Employee Code','UAN','PF Eligible','PF Type','Basic Salary','Leave/LOP Days',
             'Leave/LOP Deduction','Final Payable Basic','Employee EPF','Employer EPF','Employer EPS (PF Account 10)',
             'EDLI (PF Account 21)','Admin Charges (PF Account 2)','Employee Total','Employer Total','Grand Total','Status','Rule Applied'],
    rows: body.concat([['', 'GRAND TOTAL', '', '', '', '', '', '', '', Math.round(pfTot.wage), Math.round(pfTot.employee),
      Math.round(pfTot.epf), Math.round(pfTot.eps), Math.round(pfTot.edli), Math.round(pfTot.admin), Math.round(pfTot.employee),
      Math.round(pfTot.epf + pfTot.eps + pfTot.edli + pfTot.admin), Math.round(pfTot.total), '', '']])
      .concat(excludedNote_(excluded, 'PF') ? [['', '', '', '', '', '', '', '', '', '', '', '', '',
        '', '', '', '', '', '', excludedNote_(excluded, 'PF')]] : [])
  };
}

function esiReturnCsv(esiRows, esiTot, excluded){
  const body = [];
  let sr = 0;
  SALARY_HEADING_ORDER.forEach(hk => {
    const group = esiRows.filter(x => x.headingKey === hk);
    if(!group.length) return;
    body.push([SALARY_HEADINGS[hk].label]);
    group.forEach(x => {
      sr++;
      const status = x.r.covered ? 'Covered' : 'Exempt';
      body.push([sr, x.emp.name, excelIdNumber(x.emp.esiNumber), Math.round(x.s.gross),
        x.r.covered ? Math.round(x.r.employee) : 0, x.r.covered ? Math.round(x.r.employer) : 0,
        x.r.covered ? Math.round(x.r.total) : 0, status, x.r.reason]);
    });
  });
  return {
    header: ['SR NO','Name','ESI Number','Gross Wages','Employee 0.75%','Employer 3.25%','Total','Status','Rule Applied'],
    rows: body.concat([['', 'TOTAL', '', Math.round(esiTot.gross), Math.round(esiTot.employee),
      Math.round(esiTot.employer), Math.round(esiTot.total), '', '']])
      .concat(excludedNote_(excluded, 'ESI') ? [['', '', '', '', '', '', '', '',
        excludedNote_(excluded, 'ESI')]] : [])
  };
}

// PT and anything else that is one amount per employee.
function statutoryAmountCsv(rows, grandTotal, key){
  const body = [];
  SALARY_HEADING_ORDER.forEach(hk => {
    const group = rows.filter(r => r[2] === hk);
    if(!group.length) return;
    body.push([SALARY_HEADINGS[hk].label]);
    group.forEach(r => body.push([r[0], Math.round(r[1])]));
  });
  body.push(['Grand Total', Math.round(grandTotal)]);
  return { header: ['Name', key.toUpperCase() + ' Amount'], rows: body };
}


// ---- Salary Sheet ----
// The sheet's columns and every row of it, grouped by the heading each
// employee was under THAT month, with a subtotal per group and a grand total.
// Shared so the CSV the screen files and the one the monthly email attaches
// are the same file, not two builds of it.
//
// Whole rupees, matching what the sheet shows. Day counts (leave days, half
// days, leave balances) are left exactly as they are — they are not money.
const SALARY_SHEET_COLS = ['SR NO','Name','Rate of Pay','Leave Days','Policy Half Days','Leave Amount','Basic','HRA','LTA','Gross',
  'PF','ESI','PT','Advance Temp','Advance','Loan EMI','Retention','Total Deduction','Conveyance','Net Before Direct','Paid Directly','Net Salary',
  'PEN','Employer PF','PF Admin','EDLI','ESI Employer','Employer Cont.','CTC',
  'Advance Balance','Loan Balance','Full Day Leave Bal','Half Day Leave Bal'];
const SALARY_SHEET_TOTAL_KEYS = ['rate','leaveAmount','policyHalfDays','basic','hra','lta','gross','pf','esi','pt',
  'advanceTemp','advance','loanEmi','retention','totalDeduction','conveyance','netSalary','pen','employerPf',
  'pfAdmin','edli','employerCont','ctc','esiEmployer','advanceBalance','loanBalance','directPaid','netBeforeDirect'];

function salarySheetTotalsSeed_(){
  const o = {};
  SALARY_SHEET_TOTAL_KEYS.forEach(k => { o[k] = 0; });
  return o;
}

function salarySheetCsv(employees, attByEmpId, dateList, monthDays, holidayMap){
  const R = v => Math.round(Number(v) || 0);
  const rows = [];
  const grand = salarySheetTotalsSeed_();
  let srNo = 1;
  SALARY_HEADING_ORDER.forEach(headingKey => {
    const group = (employees || []).filter(e => ratePayAsOf(e, dateList[0]).salaryHeading === headingKey);
    if(!group.length) return;
    rows.push([SALARY_HEADINGS[headingKey].label]);
    const sub = salarySheetTotalsSeed_();
    group.forEach(emp => {
      const s = salaryFor_(emp, attByEmpId[emp.id] || {}, dateList, monthDays, holidayMap);
      rows.push([srNo++, emp.name, R(s.rate), s.leaveDays, s.policyHalfDays, R(s.leaveAmount), R(s.basic), R(s.hra),
        R(s.lta), R(s.gross), R(s.pf), R(s.esi), R(s.pt), R(s.advanceTemp), R(s.advance), R(s.loanEmi), R(s.retention),
        R(s.totalDeduction), R(s.conveyance), R(s.netBeforeDirect), R(s.directPaid), R(s.netSalary),
        R(s.pen), R(s.employerPf), R(s.pfAdmin), R(s.edli), R(s.esiEmployer), R(s.employerCont), R(s.ctc),
        R(s.advanceBalance), R(s.loanBalance), s.fullDayLeaveBal, s.halfDayLeaveBal]);
      SALARY_SHEET_TOTAL_KEYS.forEach(k => { sub[k] += s[k]; grand[k] += s[k]; });
    });
    // The subtotal line stops at Total Deduction/Conveyance/Net the way it
    // always has — shorter than a full row on purpose.
    rows.push(['', 'Subtotal', R(sub.rate), '', sub.policyHalfDays, R(sub.leaveAmount), R(sub.basic), R(sub.hra),
      R(sub.lta), R(sub.gross), R(sub.pf), R(sub.esi), R(sub.pt), R(sub.advanceTemp), R(sub.advance),
      R(sub.loanEmi), R(sub.retention), R(sub.totalDeduction), R(sub.conveyance), R(sub.netSalary)]);
  });
  rows.push(['', 'Grand Total', R(grand.rate), '', grand.policyHalfDays, R(grand.leaveAmount), R(grand.basic),
    R(grand.hra), R(grand.lta), R(grand.gross), R(grand.pf), R(grand.esi), R(grand.pt), R(grand.advanceTemp),
    R(grand.advance), R(grand.loanEmi), R(grand.retention), R(grand.totalDeduction), R(grand.conveyance),
    R(grand.netBeforeDirect), R(grand.directPaid), R(grand.netSalary), R(grand.pen), R(grand.employerPf),
    R(grand.pfAdmin), R(grand.edli), R(grand.esiEmployer), R(grand.employerCont), R(grand.ctc),
    R(grand.advanceBalance), R(grand.loanBalance), '', '']);
  return { cols: SALARY_SHEET_COLS.slice(), rows, grand };
}


// ---- Final Salary Sheet for Accountant ----
// The payment list: name, bank, account, and what is actually payable after
// every deduction. Grouped by the heading each employee was under that month,
// and within a group sorted bank first then name, so everyone at one bank sits
// together and the block can be handed over as a single transfer instruction.
function finalSalarySheetCsv(employees, attByEmpId, dateList, monthDays, holidayMap){
  const out = [];
  let sr = 0, grand = 0, grandCount = 0;
  SALARY_HEADING_ORDER.forEach(headingKey => {
    const group = (employees || []).filter(e => ratePayAsOf(e, dateList[0]).salaryHeading === headingKey);
    if(!group.length) return;
    const label = SALARY_HEADINGS[headingKey].label;
    const rows = group.map(emp => ({
      emp, net: salaryFor_(emp, attByEmpId[emp.id] || {}, dateList, monthDays, holidayMap).netSalary
    }));
    rows.sort((a, b) => (a.emp.bankName || '').localeCompare(b.emp.bankName || '')
      || (a.emp.name || '').localeCompare(b.emp.name || ''));
    out.push([label]);
    let sub = 0;
    rows.forEach(r => {
      sr++; sub += r.net; grand += r.net; grandCount++;
      out.push([sr, r.emp.name, r.emp.bankName || '', excelIdNumber(r.emp.accountNumber),
                r.emp.ifsc || '', Math.round(r.net)]);
    });
    out.push(['', label + ' subtotal', rows.length + ' employee(s)', '', '', Math.round(sub)]);
  });
  out.push(['', 'GRAND TOTAL', grandCount + ' employee(s)', '', '', Math.round(grand)]);
  return {
    cols: ['SR NO','Employee Name','Bank Name','Account Number','IFSC','Final Payable Salary'],
    rows: out, grand: Math.round(grand), count: grandCount
  };
}


// holidayMap is optional — omitting it still catches every Sunday sandwich
// (which needs no holiday data at all), just not a holiday-adjacent one.
// Every caller that has a holidayMap handy passes it; computeSalaryForEmployee
// always has one, so the actual Salary Sheet deduction is never affected by
// this — only how completely a warning panel can explain it in advance.
// ---- leave balances ----
function leaveBalances(emp, used, P){
  P = P || LEAVE_POLICY;
  const type = P.sickLeave.perYear[emp.employeeType] !== undefined
    ? emp.employeeType
    : (emp.employeeType === 'part' ? 'part' : 'full');
  const sickTotal = P.sickLeave.perYear[type];
  const sickLeft = Math.max(0, sickTotal - (used.sick || 0));
  const plEarned = Math.floor((used.attendanceDays || 0) / P.privilegeLeave.earnedPerAttendanceDays);
  const plUsable = P.privilegeLeave.usableInFirstYear || !emp.isFirstFinancialYear;
  return {
    sickTotal, sickLeft, sickExhausted: sickLeft === 0,
    plEarned, plUsed: used.pl || 0, plLeft: Math.max(0, plEarned - (used.pl || 0)),
    plUsable,
    notes: [].concat(
      sickLeft === 0 ? ['No Sick Leave balance available — further sick leave becomes Leave Without Pay'] : [],
      !plUsable ? ['PL earned this year is usable from the next financial year'] : [],
      (used.plThisMonth || 0) > P.privilegeLeave.maxPerMonth
        ? ['More than '+P.privilegeLeave.maxPerMonth+' PL this month — the excess is deducted from salary'] : []
    )
  };
}

// Moved here from index.html, where it used to live. policyRowsFor below calls
// evaluateAttendanceDay for any day with both punches recorded, and in the
// browser that resolved out of index.html because the two files share one
// global scope. Apps Script evaluates only this file, so the 1 August report
// email died on "evaluateAttendanceDay is not defined" and sent nothing.
// check-shared-standalone.js missed it because its fixture had no check-in or
// check-out times, so the branch that calls this never ran.
const minToHHMM = m => (m===null||m===undefined) ? '—'
  : String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');

// ---- one day ----
function evaluateAttendanceDay(inp, P){
  P = P || LEAVE_POLICY;
  const r = { facts: [], warnings: [], rules: [], status: inp.status || 'P', lateMinutes: 0 };
  const L = P.lateComing;

  if(inp.inMin !== null && inp.inMin !== undefined && P.shift.startMin !== null){
    r.lateMinutes = Math.max(0, inp.inMin - P.shift.startMin);
    r.facts.push({ k:'Shift start', v:minToHHMM(P.shift.startMin) });
    r.facts.push({ k:'In time', v:minToHHMM(inp.inMin) });
    if(r.lateMinutes > 0) r.facts.push({ k:'Late minutes', v:r.lateMinutes });
  }
  if(inp.outMin !== null && inp.outMin !== undefined){
    r.facts.push({ k:'Out time', v:minToHHMM(inp.outMin) });
    r.facts.push({ k:'Shift end', v:minToHHMM(P.shift.endMin) });
    if(inp.inMin !== null && inp.inMin !== undefined){
      const w = inp.outMin - inp.inMin;
      r.workedMinutes = w;
      r.facts.push({ k:'Working hours', v:Math.floor(w/60)+'h '+(w%60)+'m' });
      // Deliberately NOT compared against the full 09:30–19:00 span. Grace
      // permits a late arrival, so measuring hours worked against the whole
      // shift would flag every person who used their grace as short — which
      // would make the grace period meaningless. Leaving before shift end is
      // the rule that matters, and it is reported below on its own.
    }
    if(P.shift.endMin !== null && inp.outMin < P.shift.endMin){
      r.earlyMinutes = P.shift.endMin - inp.outMin;
      r.warnings.push('Left ' + r.earlyMinutes + ' minutes before shift end');
    }
    // Overtime starts at the configured hour, not at shift end.
    if(P.shift.overtimeFromMin !== null && inp.outMin > P.shift.overtimeFromMin){
      r.overtimeMinutes = inp.outMin - P.shift.overtimeFromMin;
      r.facts.push({ k:'Overtime', v:Math.floor(r.overtimeMinutes/60)+'h '+(r.overtimeMinutes%60)+'m' });
      r.rules.push('Overtime counted from ' + minToHHMM(P.shift.overtimeFromMin));
    }
  }

  if(r.lateMinutes > 0){
    if(r.lateMinutes <= L.graceMinutes){
      r.rules.push('Grace time used (up to '+L.graceMinutes+' minutes)');
    } else if(r.lateMinutes <= L.shortLeaveAfterMinutes){
      r.warnings.push('Late by '+r.lateMinutes+' minutes — grace period of '+L.graceMinutes+' minutes exceeded');
      r.countsAsLateInstance = true;
    } else {
      r.warnings.push('Late by '+r.lateMinutes+' minutes — beyond '+L.shortLeaveAfterMinutes+' minutes');
      r.warnings.push('Converted to Short Leave as per policy');
      r.rules.push('Late beyond '+L.shortLeaveAfterMinutes+' minutes becomes short leave');
      r.countsAsLateInstance = true;
      r.becomesShortLeave = true;
    }
  }
  return r;
}

function policyRowsFor(employees, attByEmp, dateList, holidayMap){
  const P = LEAVE_POLICY;
  return employees.map(emp => {
    const att = attByEmp[emp.id] || {};
    let lateCount = 0, shortLeaves = 0, sickUsed = 0, plUsed = 0, lwp = 0, halfDays = 0, attendanceDays = 0;
    let otMinutes = 0, earlyDays = 0;
    dateList.forEach(d => {
      const e = att[d];
      if(!e) return;
      const c = e.code;
      if(c === 'SHORT') shortLeaves++;
      if(c === 'SL' || c === 'HSL') sickUsed += (c === 'HSL' ? 0.5 : 1);
      if(c === 'EL' || c === 'HEL') plUsed += (c === 'HEL' ? 0.5 : 1);
      if(c === 'LP' || c === 'HLP') lwp += (c === 'HLP' ? 0.5 : 1);
      if(c === 'HEL' || c === 'HSL' || c === 'HLP') halfDays++;
      if(c === 'P' || c === 'SHORT' || c === 'EL' || c === 'SL') attendanceDays++;
      if(e.lateFlag) lateCount++;
      // Judge the day itself whenever both punches exist, so early leaving and
      // overtime are counted rather than merely storable.
      if(e.checkinTime && e.checkoutTime){
        const toMin = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
        const day = evaluateAttendanceDay({ inMin: toMin(e.checkinTime), outMin: toMin(e.checkoutTime) });
        if(day.overtimeMinutes) otMinutes += day.overtimeMinutes;
        if(day.earlyMinutes) earlyDays++;
      }
    });
    const type = emp.employeeType === 'part' ? 'part' : 'full';
    const bal = leaveBalances({ employeeType: type, isFirstFinancialYear: !!emp.isFirstFinancialYear },
                              { sick: sickUsed, pl: plUsed, plThisMonth: plUsed, attendanceDays });
    const L = P.lateComing, S = P.shortLeave;
    const warn = [];
    // The same call the Salary Sheet makes, so the warning and the deduction
    // are one number seen twice rather than two numbers that might differ.
    const policyHalf = policyHalfDaysFor(emp, att, dateList);
    if(lateCount > L.freeInstancesPerMonth){
      warn.push('Exhausted the ' + L.freeInstancesPerMonth + ' permissible late entries');
    }
    policyHalf.reasons.forEach(r => warn.push(r + ' — deducted from this month\u2019s salary'));
    if(emp.employeeType === 'part' && shortLeaves > 0 && !P.partTime.shortLeaveAllowed)
      warn.push('Short Leave is not applicable for Part-Time employees');
    if(bal.sickExhausted) warn.push('Sick Leave exhausted — further sick leave becomes Leave Without Pay');
    if(plUsed > P.privilegeLeave.maxPerMonth)
      warn.push('More than ' + P.privilegeLeave.maxPerMonth + ' PL this month — excess deducted from salary');
    if(!bal.plUsable && bal.plEarned > 0) warn.push('PL earned this year is usable from the next financial year');
    if(earlyDays) warn.push(earlyDays + ' day(s) left before shift end (' + minToHHMM(P.shift.endMin) + ')');
    // Sandwich leave applies to Resident Engineers too — confirmed as a
    // deliberate policy decision, unlike the EL/SL/short-leave/late-coming
    // rules just above, which stay exempt for them exactly as before. A
    // Resident's day is still marked A/LP/P through the same Attendance
    // Sheet everyone else uses, so there is nothing special about how their
    // sandwich days are found — only whether the exemption applied at all.
    const sandwichDates = sandwichDaysFor(emp, att, dateList, holidayMap || {});
    if(sandwichDates.length) warn.push(sandwichDates.length + ' sandwich day(s) (' + sandwichDates.join(', ') +
      ') — Sunday/holiday between two unpaid-absence days, deducted from this month’s salary');
    return { emp, lateCount, shortLeaves, sickUsed, plUsed, lwp, halfDays, attendanceDays,
             otMinutes, earlyDays, bal, warn, policyHalfDays: policyHalf.total, sandwichDays: sandwichDates.length };
  });
}

// The letters shown in an attendance cell. Only 'H' varies, and only by
// whether the date is a declared holiday rather than a Sunday.
function attCodeText_(code, isPh){
  return (isPh && code === 'H') ? 'PH' : code;
}

// ---- Attendance Sheet ----
// A day-by-day grid plus the month's summary and the policy position, in the
// one shape the sheet is filed and emailed in. The day codes are resolved the
// same way the grid on screen resolves them, so a Sunday or a declared holiday
// reads identically in both.
function attendanceSheetCsv(employees, attByEmpId, dateList, holidayMap){
  const header = ['S.No','Name'].concat(dateList.map(d => parseInt(d.slice(8), 10))).concat(
    ['Present','Absent','EL','SL','LP','Half','Short','Late','Policy Cut',
     'Employee Type','Late Count','Short Leaves','Half Days','Sick Used','Sick Balance',
     'PL Earned','PL Used','PL Balance','LWP','Sandwich Days','Attendance Days','Overtime Minutes','Early Leaving Days',
     'Policy Rule Applied','Violation Reason']);
  const rows = [];
  (employees || []).forEach((emp, i) => {
    const att = attByEmpId[emp.id] || {};
    const summary = computeAttendanceSummary(att, emp, dateList, holidayMap);
    const dayCodes = dateList.map(dateStr => {
      const code = resolvedAttendanceCode_(att, dateStr, holidayMap);
      // A declared holiday reads PH, a Sunday reads H — the stored code is 'H'
      // for both, only what it READS differs, same as the grid.
      const isPhDay = !!holidayMap[dateStr] && new Date(dateStr + 'T00:00:00').getDay() !== 0;
      return attCodeText_(code, isPhDay) || '';
    });
    rows.push([i + 1, emp.name].concat(dayCodes).concat(
      [summary.present, summary.absent, summary.elUsed, summary.slUsed,
       summary.lpDays, summary.halfDays, summary.shortCount, summary.lateCount,
       summary.policyCut]));
  });
  // The policy columns are appended before the file is written, never after —
  // the Drive copy used to be written first and carried fourteen empty
  // columns under headings that promised data.
  policyRowsFor(employees, attByEmpId, dateList, holidayMap).forEach((r, i) => {
    if(!rows[i]) return;
    rows[i].push(
      r.emp.employeeType === 'part' ? 'Part-time' : 'Full-time',
      r.lateCount, r.shortLeaves, r.halfDays,
      r.sickUsed, r.bal.sickLeft,
      r.bal.plEarned, r.plUsed, r.bal.plLeft,
      r.lwp, r.sandwichDays || 0, r.attendanceDays, r.otMinutes || 0, r.earlyDays || 0,
      LEAVE_POLICY.version,
      r.warn.length ? r.warn.join('; ') : 'Within policy'
    );
  });
  return { header, rows };
}


// ---- Consultant Report ----
// The monthly sheet the consultant works from. Column order and headings are
// fixed to match the workbook they send back, so the CSV can be pasted straight
// into their template — don't reorder these without checking with them first.
const CONSULTANT_REPORT_COLS = [
  'SR NO','EC','EmpName','Designation','BirthDate','JoiningDate','PFNo','Uan No','ESINo',
  'GROSS SALARY(Including PT)','W.DYS','W.OFF','PRESENT DYS','PH','EL','SL',
  'ABSENT DAYS','PAYABLE DYS','OTHER ALL IF ANY','I.T.','LOAN/ ADVANCE'
];

// Which headings are R.S. Infotech's own payroll. The Consultant Report covers
// these and nothing else — Apprentices, Contractors and R.S.IT Solution are
// separate books and are not the consultant's to process. Kept here beside the
// headings so the two are changed together.
const CONSULTANT_REPORT_HEADINGS = ['managerial','senior','junior'];

// The consultant's sheet writes dates as dd.mm.yyyy, not the ISO form stored here.
function consultantDate(v){
  if(!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v);
}

// Trim trailing zeros so half-days read as 25.5 and whole days as 26, not 26.0
function consultantDays(n){
  return String(Math.round((Number(n) || 0) * 100) / 100);
}

// The consultant's sheet splits days differently from computeAttendanceSummary,
// which folds EL/SL into `present` because they are paid. Here PRESENT means days
// actually worked, with leave in its own column — so a full EL day is 0 present +
// 1 EL, while a half EL day is 0.5 present + 0.5 EL. That distinction is why this
// counts the raw codes rather than deriving from the summary.
function consultantDayCounts(att, dateList, holidayMap){
  let present = 0, el = 0, sl = 0, absent = 0;
  dateList.forEach(dateStr => {
    // Same resolution computeAttendanceSummary and the Attendance Sheet use
    // (resolvedAttendanceCode_) — a declared holiday counts as one here too,
    // even over an Absent or leave code already saved for the date.
    const code = resolvedAttendanceCode_(att, dateStr, holidayMap);
    switch(code){
      case 'P': case 'SHORT': present += 1; break;
      case 'EL': el += 1; break;
      case 'SL': sl += 1; break;
      case 'HEL': present += 0.5; el += 0.5; break;
      case 'HSL': present += 0.5; sl += 0.5; break;
      case 'HLP': present += 0.5; absent += 0.5; break;
      case 'A': case 'LP': absent += 1; break;
      case 'H': break; // week-off or declared holiday, counted separately
      default: if(dateStr <= todayStr()) absent += 1; // unmarked past day, same rule as the Attendance Sheet
    }
  });
  return { present, el, sl, absent };
}

// ---- Consultant Report (the wage register) ----
// R.S. Infotech's own payroll headings only — Apprentices, Contractors and
// R.S.IT Solution are separate books that were once folded in here and
// overstated every column and the headcount with them.
function consultantReportRows(employees, attByEmpId, dateList, monthDays, holidayMap, year, month){
  let weekOff = 0, publicHolidays = 0;
  dateList.forEach(dateStr => {
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    if(dow === 0) weekOff++;
    else if(holidayMap[dateStr]) publicHolidays++;
  });
  const workingDays = monthDays - weekOff;
  const rows = [];
  let sr = 0;
  (employees || []).forEach(emp => {
    const att = attByEmpId[emp.id] || {};
    const c = consultantDayCounts(att, dateList, holidayMap);
    // The same sandwich figure the Salary Sheet charges, added the same way,
    // so the payable-days count sent to the consultant cannot overstate what
    // is actually paid.
    const sandwichDays = sandwichDaysFor(emp, att, dateList, holidayMap).length;
    const absentDays = c.absent + sandwichDays;
    // Everything in the month is paid except unpaid absence. Derived by
    // subtraction so it stays inside 0..monthDays even when somebody checks in
    // on a Sunday, which would otherwise be counted twice.
    const payableDays = Math.max(0, monthDays - absentDays);
    const ym = year + '-' + String(month).padStart(2, '0');
    const loanEmi = computeLoanEmiForMonth(emp, year, month);
    const advance = advanceTempForMonth(emp, ym) + salaryAdvanceForMonth(emp, ym);
    const deduction = loanEmi + advance;
    let loanLabel = '';
    if(loanEmi && advance) loanLabel = 'Loan / Advance';
    else if(loanEmi) loanLabel = 'Loan';
    else if(advance) loanLabel = 'Advance';
    sr++;
    rows.push([sr, emp.id || '', emp.name || '', emp.designation || '',
      consultantDate(emp.dob), consultantDate(emp.doj), emp.pfNo || '', emp.uan || 'NA',
      emp.esiNumber || '', Math.round(ratePayAsOf(emp, dateList[0]).ratePay),
      consultantDays(workingDays), consultantDays(weekOff), consultantDays(c.present),
      consultantDays(publicHolidays), consultantDays(c.el), consultantDays(c.sl),
      consultantDays(absentDays), consultantDays(payableDays),
      Number(emp.otherAllowances) ? fmtMoney(Number(emp.otherAllowances)) : 'NA',
      deduction ? Math.round(deduction) : '', loanLabel]);
  });
  return { cols: CONSULTANT_REPORT_COLS.slice(), rows, workingDays, weekOff, publicHolidays };
}
// The same rows, made safe to open in Excel. consultantReportRows above is
// rendered on screen as well as written to CSV, and ="102058000000" belongs in
// a spreadsheet cell, not in a table on a phone -- so the identifier columns
// are wrapped here at the export boundary, exactly where the money columns are
// rounded rather than in the arithmetic behind them.
// Found by name, not written as [6,7,8]: insert a column into
// CONSULTANT_REPORT_COLS one day and the wrapper follows it instead of quietly
// wrapping whatever moved into position 6.
const CONSULTANT_ID_COLS = ['PFNo', 'Uan No', 'ESINo']
  .map(h => CONSULTANT_REPORT_COLS.indexOf(h))
  .filter(i => i !== -1);
function consultantCsvRows(rows){
  return (rows || []).map(r => r.map((cell, i) =>
    CONSULTANT_ID_COLS.indexOf(i) === -1 ? cell : excelIdNumber(cell)));
}

function consultantReportEmployees(employees, dateList){
  return (employees || []).filter(e =>
    employedDuringPeriod_(e, dateList[0], dateList[dateList.length - 1]) &&
    CONSULTANT_REPORT_HEADINGS.indexOf(ratePayAsOf(e, dateList[0]).salaryHeading) !== -1);
}


// ---- Consultant Final Summary Report ----
// The one-page PF/ESI account-wise totals the consultant files alongside the
// wage register. Not a per-employee listing — the same totals the Salary
// Sheet, PF Report and ESI Report already compute, added up once.
//
// PT counts the wider population (R.S.IT Solution included); everything else
// stays scoped to R.S. Infotech's own three headings. heading.pf/heading.esi
// are already false for rsit, so those checks never match it anyway — only
// the PT sum needs to know about the wider group explicitly.
function consultantSummaryEmployees(employees, dateList){
  const wider = CONSULTANT_REPORT_HEADINGS.concat(['rsit']);
  return (employees || []).filter(e =>
    employedDuringPeriod_(e, dateList[0], dateList[dateList.length - 1]) &&
    wider.indexOf(ratePayAsOf(e, dateList[0]).salaryHeading) !== -1);
}

function consultantSummaryTotals(employees, attByEmpId, dateList, monthDays, holidayMap){
  const pf = { count:0, wage:0, empEmployee:0, empEmployer:0, admin:0, eps:0, edli:0 };
  const esiT = { count:0, wage:0, employee:0, employer:0 };
  const alw = { basic:0, hra:0, conveyance:0, lta:0 };
  const ded = { pf:0, pt:0, adv:0, loan:0, esi:0 };
  (employees || []).forEach(emp => {
    const s = salaryFor_(emp, attByEmpId[emp.id] || {}, dateList, monthDays, holidayMap);
    const headingKey = ratePayAsOf(emp, dateList[0]).salaryHeading || 'managerial';
    const heading = SALARY_HEADINGS[headingKey] || SALARY_HEADINGS.managerial;
    // heading.pf gates whether the heading attracts PF at all; s.pfApplicable
    // additionally covers an employee-level pfEligible:'no' or a not-yet-
    // configured contribution type, either of which means nothing to add.
    if(heading.pf && s.pfApplicable){
      pf.count++; pf.wage += s.pfWage; pf.empEmployee += s.pf; pf.empEmployer += s.employerPf;
      pf.admin += s.pfAdmin; pf.eps += s.pen; pf.edli += s.edli;
    }
    if(heading.esi){
      const r = computeEsi(s.gross, {
        isDisabled: emp.esiDisabled === 'yes',
        coveredAtPeriodStart: emp.esiCoveredAtPeriodStart === 'yes',
        eligible: emp.esiEligible !== 'no',
        asOf: dateList[0]
      });
      if(r.covered){
        esiT.count++; esiT.wage += s.gross; esiT.employee += r.employee; esiT.employer += r.employer;
      }
    }
    ded.pt += s.pt;
    if(CONSULTANT_REPORT_HEADINGS.indexOf(headingKey) !== -1){
      alw.basic += s.basic; alw.hra += s.hra; alw.conveyance += s.conveyance; alw.lta += s.lta;
      ded.pf += s.pf; ded.adv += s.advanceTemp + s.advance; ded.loan += s.loanEmi; ded.esi += s.esi;
    }
  });
  const acct1 = pf.empEmployee + pf.empEmployer;
  const acct22 = 0;   // EDLI admin charge — not levied, kept as a named zero
  const lwf = 0;      // Labour Welfare Fund — not tracked, same
  const pfTotal = acct1 + pf.admin + pf.eps + pf.edli + acct22;
  const esiTotal = esiT.employee + esiT.employer;
  const alwTotal = alw.basic + alw.hra + alw.conveyance + alw.lta;
  const dedTotal = ded.pf + ded.pt + ded.adv + lwf + ded.loan + ded.esi;
  return { pf, esiT, alw, ded, acct1, acct22, lwf, pfTotal, esiTotal, alwTotal, dedTotal,
           net: alwTotal - dedTotal };
}

function consultantSummaryCsv(t){
  return {
    header: ['Section','Item','Amount'],
    rows: [
      ['PF Summary','Total No Of Employees', t.pf.count],
      ['PF Summary','Total Wages', Math.round(t.pf.wage)],
      ['PF Summary','P.F. Account No 1', Math.round(t.acct1)],
      ['PF Summary','P.F. Account No 1 — Employee share', Math.round(t.pf.empEmployee)],
      ['PF Summary','P.F. Account No 1 — Employer EPF share', Math.round(t.pf.empEmployer)],
      ['PF Summary','P.F. Account No 2', Math.round(t.pf.admin)],
      ['PF Summary','P.F. Account No 10', Math.round(t.pf.eps)],
      ['PF Summary','P.F. Account No 21', Math.round(t.pf.edli)],
      ['PF Summary','P.F. Account No 22', Math.round(t.acct22)],
      ['PF Summary','Total P.F.', Math.round(t.pfTotal)],
      ['ESI Summary','Total No Of Employees', t.esiT.count],
      ['ESI Summary','Total Wage', Math.round(t.esiT.wage)],
      ['ESI Summary','Employee Contribution', Math.round(t.esiT.employee)],
      ['ESI Summary','Employer Contribution', Math.round(t.esiT.employer)],
      ['ESI Summary','Total', Math.round(t.esiTotal)],
      ['Allowance','Basic', Math.round(t.alw.basic)],
      ['Allowance','HRA', Math.round(t.alw.hra)],
      ['Allowance','Conveyance', Math.round(t.alw.conveyance)],
      ['Allowance','LTA', Math.round(t.alw.lta)],
      ['Allowance','Total', Math.round(t.alwTotal)],
      ['Deduction','P.F.', Math.round(t.ded.pf)],
      ['Deduction','P.T.', Math.round(t.ded.pt)],
      ['Deduction','Advance', Math.round(t.ded.adv)],
      ['Deduction','L.W.F. (not tracked)', Math.round(t.lwf)],
      ['Deduction','Loan', Math.round(t.ded.loan)],
      ['Deduction','E.S.I.', Math.round(t.ded.esi)],
      ['Deduction','Total Deduction', Math.round(t.dedTotal)],
      ['Net','Net', Math.round(t.net)]
    ]
  };
}
