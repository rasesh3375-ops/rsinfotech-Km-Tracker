# R.S. Infotech KM Tracker

An HR and payroll web app for R.S. Infotech, plus the km-tracking login the
field engineers use. Real payroll runs on this — salary sheets, PF, ESI, PT,
leave balances and bonus payments for actual people. A wrong number here is a
wrong number in somebody's bank account, so correctness matters more than
elegance and more than speed.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The entire frontend — markup, CSS and ~12,500 lines of JavaScript in two inline `<script>` blocks. No build step, no framework, no bundler. |
| `apps-script/Code 2.js` | The backend: a Google Apps Script web app over a Google Sheet, with Drive for file storage. |
| `apps-script/appsscript.json` | Script manifest. Timezone is `Asia/Kolkata` and must stay that way. |
| `tools/` | Two checks to run after editing `index.html`. See below. |
| `manifest.json`, `manifest-hr.json` | Two PWA manifests — `/` is the engineer login, `/hr/` is the HR app. `vercel.json` rewrites `/hr/` to the same `index.html` with the HR manifest so the iPhone home-screen shortcut opens the right one. |

Hosted on Vercel, deploying automatically from `main`. There is no staging
environment: a push to `main` is live for HR within a minute.

## Working on it

There is nothing to install and nothing to run. Open `index.html` in a browser,
or edit and push.

After **every** edit to `index.html`, run both checks:

```bash
node tools/check-syntax.js        # no dependencies
npm install acorn                 # once, for the second one
node tools/check-undeclared.js
```

`check-syntax.js` parses the inline scripts. A stray brace means the app does
not start at all, and the browser is a slow place to find that out.

`check-undeclared.js` finds identifiers that are read but never declared. This
matters far more than it sounds: the file parses perfectly with a
`ReferenceError` waiting in it, and the bad line only runs when a real person
opens that screen. Four reports were silently broken this way — `viewReport`,
Increment Reminders, the Overtime Report, the Monthly Leave Report and the
Holiday List each called `hrYearPath(monthVal + '-01', …)` in a function where
`monthVal` did not exist, so two of them rendered nothing at all and the others
never wrote their Drive copy. Nothing else in the project catches that.

### Verifying behaviour

There is no test suite. The way changes get verified here is a throwaway
[jsdom](https://github.com/jsdom/jsdom) harness that loads the real
`index.html`, stubs the network, drives the actual UI and asserts on what comes
out. Write one per change, keep it out of the repo, and make it assert rather
than print — printing hides regressions in a wall of output.

```js
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.test/hr/',
  beforeParse(w){
    w.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){},
                            addEventListener(){}, removeEventListener(){} });
    w.fetch = async () => ({ ok:true, status:200, text:async()=>'{}', json:async()=>({ok:true}) });
    w.alert = () => {}; w.confirm = () => true;
    w.addEventListener('error', e => pageErrors.push(e.error && e.error.stack));
  }});
```

Two things that will waste your time otherwise:

- Top-level `const` and `let` are **not** properties of `window`. Reach them
  with `w.eval('financialYearLabel')`, not `w.financialYearLabel`.
- Always collect page errors as above and print them. A handler that throws
  half way leaves the screen looking merely incomplete, and every bug listed in
  this file hid behind exactly that.

Checking that content exists in the DOM is not the same as checking a person
can see it. The salary calculation card rendered its full text into a
*collapsed* `<details>` — present in `textContent`, invisible on screen.

## Architecture

Two rules carry almost all the weight.

**One function per domain concept, called by every surface.** `calculatePfFor`,
`computeEsi`, `monthlyPtFor`, `monthlyPayFor`, `computeSalaryForEmployee`,
`diwaliBonusFor`, `policyHalfDaysFor`, `plEncashmentFor`, `loansOf`,
`elFyRows`, `financialYearLabel`, `hrYearPath`. If a screen needs a number,
it calls the function; it does not work the number out.

This is not a style preference. Three separate times, HR reported that the
figure on the Add Employee form disagreed with the figure on the Salary Sheet —
PF eligibility, employer CTC, then loan and advance recoveries. Every time the
cause was the same: the form had grown its own copy of the arithmetic. If you
find yourself writing `× 0.12` anywhere outside `calculatePfFor`, stop.

**Rules live in config, not in code.** `SALARY_HEADINGS`, `PF_RULES`,
`ESI_RULES`, `LEAVE_POLICY`, `PAYROLL_MASTER`, `LETTER_FIELDS`,
`IMPORT_COLUMNS`, `FINANCIAL_YEAR`. Changing PF from Basic + HRA to Basic only
was one line — `PF_RULES.wageComponents = ['basic']` — with no migration,
because nothing is stored derived. Every employee's Basic, HRA, PF and ESI are
computed from their Rate of Pay and heading at the moment they are displayed.

A consequence worth knowing: **the explanatory text is generated from the same
config**, so a heading whose treatment changes explains itself correctly
without anyone remembering the prose exists. Do not hand-write a paragraph
describing a calculation.

## Domain reference

**Financial year: 1 April – 31 March.** FY 2026-27 runs 1 April 2026 to
31 March 2027. Defined once in `FINANCIAL_YEAR`; everything year-scoped goes
through `financialYearLabel`, `financialYearStart`, `financialYearEnd`,
`fyOfStartYear`, `nextFinancialYearStart` or `getCurrentFYStartYear`. Never
write `-04-01` or `-03-31` into a new screen, and never work the year out with
`new Date(dateStr).getMonth()` — a date-only string parses as UTC midnight, so
in a timezone behind UTC the whole of 1 April lands in the previous year.

**Salary headings** decide the Basic/HRA/LTA split *and* which statutory
deductions apply at all:

| Heading | Basic | HRA | LTA | PF | ESI | PT |
|---|---|---|---|---|---|---|
| Managerial Staff | 65% | 35% | — | ✓ | ✓ | ✓ |
| Seniors Staff | 50% | 40% | 10% | ✓ | ✓ | ✓ |
| Junior Staff | 100% (flat) | — | — | ✓ | ✓ | ✓ |
| Apprentices | 50% | 40% | 10% | — | — | — |
| R.S.IT Solution | 50% | 40% | 10% | — | — | ✓ |
| Contractors | 50% | 40% | 10% | — | — | — |

Rate of Pay is the **gross**, not take-home. Statutory deductions come out of
it; the employer's contributions sit on top of it.

- **PF** — 12% employee and 12% employer, on **Basic only**. Employer share
  splits into EPS (8.33%, capped at ₹1,250) and EPF. Admin 0.5% and EDLI 0.5%
  on top. `pfEligible: 'no'` means no PF at all, whatever the wage.
- **ESI** — 0.75% employee, 3.25% employer, exempt strictly above ₹21,000 gross
  (₹25,000 for persons with disabilities). "Once covered, always covered" for
  the rest of the half-yearly contribution period (April–September,
  October–March — the same year boundary as everything else).
- **PT** — flat ₹200/month above ₹12,000 gross, capped at ₹2,500 a year.
- **Diwali bonus** — the manually entered `diwaliBonusAmount` and nothing else.
  **Nothing is ever deducted from it** — no PF, no ESI, no PT, no advance, no
  retention, no leave. Blank means no bonus and no appearance on the payment
  sheet. This was got wrong repeatedly; leave it alone.
- **Employee type** (`field`, `office`, `wfh`, `resident`) is separate from
  heading and decides *leave* rules. Resident Engineers are outside the leave,
  short-leave, late-coming and overtime rules entirely.
- **Leave** — 7 SL a year (4 for Work From Home), PL earned at 1 per 25
  attendance days, neither carried forward. PL is encashable at 70% of
  Basic + HRA, a day being a twenty-fifth of that. SL requires a medical
  certificate.
- **Late coming** — 15 minutes grace, then 3 free instances a month. Past
  that, each late arrival is judged by its own instance number, not a flat
  rate: the 4th is a warning with no deduction, the 5th costs half a day, the
  6th another warning, and the 7th — and every one after it — costs a full
  day. See `LEAVE_POLICY.lateComing.escalation` and `lateComingUnitsFor`; the
  list's last entry is what repeats for the 8th late arrival onward.
- **Sandwich leave** — a Sunday, or a declared holiday, is charged as an
  extra unpaid day when the working day immediately before it and the working
  day immediately after it are both Absent or Leave Without Pay. Approved
  leave (EL/SL) on either side does not trigger it. A run of adjacent
  non-working days (e.g. a Saturday holiday next to the Sunday) is judged as
  one block, bracketed by the working days either side of the whole block,
  not day by day — see `sandwichDaysFor`. Applied in
  `computeSalaryForEmployee`, so it actually reduces pay, not just a note on
  a leave application.

## Conventions

**Comments explain why, not what.** Nearly every non-obvious block in
`index.html` carries a comment naming the bug it fixes or the decision behind
it. Match that. `// The four the Salary Sheet takes off, not just the loan —
advance, temporary advance and retention were missing here, so the payslip
showed a net above what the sheet pays` earns its place. `// loop over
employees` does not.

**Commit messages** state what changed and why in plain prose, with the failure
they fix. Read `git log` before writing one.

**Ask before assuming a policy figure.** Percentages, ceilings and leave
allowances come from HR or the PF consultant. When a number is uncertain, say
so plainly rather than picking a plausible one.

**The backend is gated by role, as a whitelist.** `doGet`/`doPost` in
`Code 2.js` check `validateSession_`'s role; an engineer's tracking login may
only touch what `engineerMayRead_`/`engineerMayWrite_`/`ENGINEER_SHARED_READ`
explicitly name — their own trips, check-ins, live-tracking and attendance,
shared reference data, and adding to `leave_requests`. A key nobody has
listed is refused, not allowed. If a new storage key needs engineer access,
add it to the whitelist deliberately; do not widen the default. HR is
unrestricted throughout.

## Deploying

- **Frontend** — push to `main`. Vercel does the rest. Tell HR to hard-refresh,
  or to close and reopen the home-screen app on iPhone.
- **Backend** — open the KM Tracker Data sheet → Extensions → Apps Script,
  paste the file, save. To run a one-off like `organiseDriveByYear`, pick it in
  the function dropdown and press Run.
  **Never create a new deployment.** The `/exec` URL is hard-coded in
  `index.html`; a new deployment gets a different URL and the app stops talking
  to the backend. If a redeploy is genuinely needed, use Manage deployments →
  edit the existing one → New version, which keeps the URL.

### Testing against a staging backend

There is no staging environment by default — every push to `main` is live
production within a minute, against the one real "RS Tracker Backend" sheet.
For a change risky enough to want to try against real-shaped data first
without touching payroll:

1. Make a copy of the "RS Tracker Backend" Google Sheet (File → Make a copy).
   Copying it also copies its bound Apps Script project.
2. Open the copy's Apps Script editor and change `SPREADSHEET_ID` to the
   copy's own ID (find it in the copy's URL). This is the one line that has
   to differ from production — everything else can stay identical.
3. Deploy the copy as its own Web App (Deploy → New deployment). This is a
   genuinely separate deployment for a separate script project, so it does
   not conflict with the "never create a new deployment" rule above, which
   is only about the single production deployment's URL staying fixed.
4. On the live site, visit it once with `?stagingBackend=<the staging /exec
   URL>` appended. `index.html` remembers that in `localStorage` for that
   browser only — nobody else's session is affected, and the production
   default (no override) is untouched. A red banner ("STAGING BACKEND — this
   is test data, not the live payroll sheet") stays on screen the whole time
   an override is active, so it can't be mistaken for the real thing.
5. Visit again with `?stagingBackend=` (empty) to clear the override and go
   back to production.

This does not need setting up in advance — it costs nothing until the day a
change is worth testing this way.

## Known constraints

- **Every amount is whole rupees, no paise, everywhere.** `fmtMoney` rounds and
  formats every figure shown on screen; CSV exports round with `Math.round()`
  (or the same `R()` helper used in the Salary Sheet) right at the
  `csvRows.push`/`stashReportShare` boundary, not in the underlying
  calculation. Internal domain functions (`plEncashmentFor`, `diwaliBonusFor`,
  loan/leave math) keep full precision — only the display and export layer
  rounds — so rounding never compounds across a chain of calculations. There
  used to be a separate `fmtMoneyWhole` for the Salary Sheet only; it was
  folded into `fmtMoney` once every screen needed the same treatment, so there
  is now one money formatter, not two.
- The employee record shares one Google Sheets cell with a 50,000 character
  limit. Documents go to Drive and the record keeps only the link; there is a
  migration button in Admin Settings for older records that still hold images.
- Attendance is one key per employee **per financial year** —
  `attendance:<id>:<financial-year>`, e.g. `attendance:7:2026-27` — instead of
  one key per employee holding every day they have ever worked, which is what
  kept it well clear of the 50,000-character cell limit even with check-in and
  check-out times now recorded. `migrateAttendanceToFY` in `Code 2.js` did the
  one-off split; it is safe to re-run (recomputes every year bucket from
  scratch) but nothing needs it run again in normal operation. The legacy
  `attendance:<id>` key is left in place permanently as a fallback baseline —
  `mergedAttendanceForId_` on the backend overlays each year key on top of it,
  so a year key never needs to be a complete mirror of its year, only whatever
  has actually been edited since the split. Deleting an employee goes through
  `deleteAttendanceAll`, not a plain key delete, so every year key is removed
  along with the legacy one.
- Attendance saves are batched via `setMany` — one read and one write for the
  whole save, not one per employee or per cell. An earlier version made 620
  backend calls for a month of ten staff and silently lost most of them. Do
  not reintroduce per-cell writes, and do not use `safeSet` where the caller
  needs to know whether the write succeeded — it swallows errors. Use
  `remoteSet`, which returns a boolean.
- `position: sticky` works inside `.modal-box` because the overlay, not the
  box, is the scrolling element.
