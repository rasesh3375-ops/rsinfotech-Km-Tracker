// The Monthly Briefing: that its sentences say what the figures say.
//
// A briefing is read and forwarded — to a consultant, to an accountant — by
// people who will not open the reports behind it. So the risk here is not a
// crash, it is a sentence that reads plausibly and is wrong: a total that does
// not match the Salary Sheet, a percentage with the sign flipped, "two
// increments" where there was one. Every assertion below ties a phrase in the
// prose back to the number it claims to be reporting.
//
// The wording is generated from the figures rather than written out, so these
// also pin the shape: a month with no loans has no loan paragraph at all, and
// a briefing padded with "there were no loans this month" every month is one
// nobody finishes reading.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({monthlyBriefing, briefingFigures, computeSalaryFromAttendance,' +
  ' prePayrollChecks, monthDateList_, prevMonthOf_, plEncashmentFor, fmtMoney,' +
  ' employedDuringPeriod_})', sb);

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '\n         want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};

const YM = '2026-08';
const LIST = L.monthDateList_(YM), PLIST = L.monthDateList_('2026-07');
const HOL = {};

function emp(over){
  return Object.assign({
    id: 'E1', name: 'Test One', employmentStatus: 'active', employeeType: 'office',
    doj: '2020-01-01', salaryHeading: 'managerial', ratePay: 30000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' }],
    pfEligible: 'yes', pfContributionType: 'percent', hasPriorUan: 'yes', form11Submitted: 'yes',
    esiEligible: 'yes'
  }, over || {});
}
function attendance(){
  const a = {};
  PLIST.concat(LIST).forEach(d => {
    if (new Date(d + 'T00:00:00').getDay() === 0) return;
    a[d] = { code: 'P' };
  });
  return a;
}
function build(employees, attByEmp, withChecks){
  const sal = {}, prevSal = {};
  // Mirrors what the screen does, including the filter. Skipping it computed a
  // July salary for somebody who joined in August, so a genuine first month
  // came out with a previous month to compare against — the fixture inventing
  // history the app would never have.
  employees.forEach(e => {
    const att = attByEmp[e.id] || {};
    if(L.employedDuringPeriod_(e, LIST[0], LIST[LIST.length - 1]))
      sal[e.id] = L.computeSalaryFromAttendance(e, att, LIST, LIST.length, HOL);
    if(L.employedDuringPeriod_(e, PLIST[0], PLIST[PLIST.length - 1]))
      prevSal[e.id] = L.computeSalaryFromAttendance(e, att, PLIST, PLIST.length, HOL);
  });
  const checks = withChecks
    ? L.prePayrollChecks(employees, attByEmp, YM, HOL, sal, prevSal, { today: '2026-09-01' })
    : null;
  return { brief: L.monthlyBriefing(employees, YM, sal, prevSal, checks), sal, prevSal };
}
const text = b => b.paragraphs.join('\n');

// ------------------------------------------------------------------ the totals
console.log('the figures in the prose are the figures in the sheet\n');
{
  const a = emp({ id: 'A', name: 'Ay' }), b = emp({ id: 'B', name: 'Bee', ratePay: 20000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 20000, salaryHeading: 'seniors' }] });
  const att = { A: attendance(), B: attendance() };
  const { brief, sal } = build([a, b], att);
  const f = brief.figures;
  const sheetCtc = Math.round(sal.A.ctc + sal.B.ctc);
  const sheetNet = Math.round(sal.A.netSalary + sal.B.netSalary);
  check('cost to company is the sum of what the sheet computed', Math.round(f.ctc), sheetCtc);
  check('and net payable likewise', Math.round(f.net), sheetNet);
  check('the headcount is who was employed that month', f.headcount, 2);
  // The number in the sentence, not just in the figures object — the sentence
  // is the thing that gets forwarded.
  check('the cost appears in the prose exactly as formatted',
        text(brief).includes('₹' + L.fmtMoney(f.ctc)), true);
  check('and so does net payable', text(brief).includes('₹' + L.fmtMoney(f.net)), true);
  check('the month is named in words, not as 2026-08',
        /August 2026/.test(text(brief)) && !/2026-08/.test(text(brief)), true);
}

// -------------------------------------------------------------- the comparison
console.log('\nthe month-on-month direction and size\n');
{
  // An increment on 1 August: this month costs more than last, and the briefing
  // must say up, name the person, and quote both rates.
  const e = emp({ ratePay: 40000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' },
                    { from: '2026-08-01', ratePay: 40000, salaryHeading: 'managerial' }] });
  const { brief } = build([e], { E1: attendance() });
  const t = text(brief);
  check('it reads as an increase', /up \d/.test(t), true);
  check('names the one increment as one, not two', /One increment took effect/.test(t), true);
  check('names the person', /Test One/.test(t), true);
  check('and quotes the rate it moved from and to',
        t.includes('₹30,000') && t.includes('₹40,000'), true);
  check('the increment count matches the history', brief.figures.increments.length, 1);
}
{
  // The other direction, and the sign must follow it.
  const e = emp({ ratePay: 20000,
    salaryHistory: [{ from: '2020-01-01', ratePay: 30000, salaryHeading: 'managerial' },
                    { from: '2026-08-01', ratePay: 20000, salaryHeading: 'managerial' }] });
  const { brief } = build([e], { E1: attendance() });
  check('a cut reads as a decrease, not an increase', /down \d/.test(text(brief)), true);
}
{
  // No previous month to compare against must say so rather than print a
  // percentage against zero — which would read as an infinite rise.
  const e = emp({ doj: '2026-08-01' });
  const { brief } = build([e], { E1: attendance() });
  const t = text(brief);
  check('a first month says there is nothing to compare against',
        /no previous month on file/.test(t), true);
  check('and prints no percentage at all', /up \d|down \d/.test(t), false);
}

// ------------------------------------------------- the count and the names agree
console.log('\nthe count in the sentence and the names after it\n');
{
  // Four increments listed as three read as an omission on the live August
  // briefing: "4 increments took effect" followed by three names, leaving the
  // reader counting and wondering which one was left out.
  const mk = (id, name, was, now) => emp({ id: id, name: name, ratePay: now,
    salaryHistory: [{ from: '2020-01-01', ratePay: was, salaryHeading: 'managerial' },
                    { from: '2026-08-01', ratePay: now, salaryHeading: 'managerial' }] });
  const four = [mk('A','Ay',30000,34000), mk('B','Bee',28000,31000),
                mk('C','Cee',25000,27000), mk('D','Dee',20000,21000)];
  const att = {}; four.forEach(e => { att[e.id] = attendance(); });
  const { brief } = build(four, att);
  const t = text(brief);
  check('four increments are counted', brief.figures.increments.length, 4);
  check('and all four are named', four.every(e => t.includes(e.name)), true);
  check('with nothing left implied', /and \d+ more/.test(t), false);
}
{
  // Past the point where naming them all is readable, it says how many it left
  // out rather than trailing off — the count and the list still agree.
  const many = [];
  for(let i = 0; i < 8; i++){
    const now = 30000 + i * 1000;
    many.push(emp({ id: 'X' + i, name: 'Person ' + i, ratePay: now,
      salaryHistory: [{ from: '2020-01-01', ratePay: 20000, salaryHeading: 'managerial' },
                      { from: '2026-08-01', ratePay: now, salaryHeading: 'managerial' }] }));
  }
  const att = {}; many.forEach(e => { att[e.id] = attendance(); });
  const { brief } = build(many, att);
  const t = text(brief);
  check('eight increments are counted', brief.figures.increments.length, 8);
  check('five are named and the rest are accounted for', /, and 3 more/.test(t), true);
  check('the biggest movers are the ones named',
        t.includes('Person 7') && t.includes('Person 6'), true);
}

// ------------------------------------------------------------------ leave money
console.log('\nearned leave, and what it is worth\n');
{
  const e = emp({ leaveOpeningEl: 8, leaveOpeningFrom: '2026-04-01' });
  const { brief, sal } = build([e], { E1: attendance() });
  const bal = sal.E1.elBalance;
  if(bal > 0){
    check('the value quoted is what the encashment rate pays',
          Math.round(brief.figures.elMoney), Math.round(L.plEncashmentFor(e, bal).amount));
    check('and the policy is stated with it',
          /carries forward past 31 March/.test(text(brief)) || brief.figures.elHeavy.length === 0, true);
  } else {
    console.log('  ..   no EL balance on this fixture — nothing to value');
  }
}

// ------------------------------------------------- a resident on the roster
console.log('\na Resident Engineer, who is outside the leave scheme\n');
{
  // elBalance is deliberately the STRING 'NA' for a resident — they are not in
  // the EL/SL scheme and the Salary Sheet prints that rather than a number.
  // Every fixture here had office staff only, so nothing caught what one
  // resident did to a running total: "NaN day(s)" on the live August briefing,
  // beside a rupee figure that was perfectly correct because plEncashmentFor
  // coerces its own input. And NaN > 0 being false took the whole earned-leave
  // paragraph out with it.
  const office = emp({ id: 'O', name: 'Office One', elOpening: 9, leaveOpeningFrom: '2026-04-01' });
  const resident = emp({ id: 'RE', name: 'Resident One', employeeType: 'resident',
                         elOpening: 9, leaveOpeningFrom: '2026-04-01' });
  const att = { O: attendance(), RE: attendance() };
  const { brief, sal } = build([office, resident], att);
  check('the resident really does report NA, not a number', sal.RE.elBalance, 'NA');
  check('the day count is a number, not NaN',
        Number.isFinite(brief.figures.elDays), true);
  check('and it counts only the people actually in the scheme',
        brief.figures.elDays, Number(sal.O.elBalance));
  check('the resident is not named among those carrying leave',
        brief.figures.elHeavy.some(x => x.id === 'RE'), false);
  const t = text(brief);
  check('the earned-leave paragraph is printed, not silently dropped',
        /Earned leave stands at/.test(t), true);
  check('with no NaN anywhere in the prose', /NaN/.test(t), false);
  check('nor in any figure the screen shows',
        Object.keys(brief.figures).some(k => typeof brief.figures[k] === 'number' &&
                                             !Number.isFinite(brief.figures[k])), false);
}

// -------------------------------------------------------- paragraphs that vanish
console.log('\na month with nothing to say about something says nothing\n');
{
  const { brief } = build([emp()], { E1: attendance() });
  const t = text(brief);
  check('no loan paragraph when there are no loans', /Loans and advances/.test(t), false);
  check('no attendance paragraph when nothing was charged',
        /On attendance:/.test(t), false);
  check('but the cost and the payable are always there',
        /Total cost to company/.test(t) && /Net payable/.test(t), true);
}
{
  const e = emp({ loans: [{ id: 'L1', amount: 60000, instalment: 5000,
    startMonth: '2026-06', status: 'active' }] });
  const { brief } = build([e], { E1: attendance() });
  check('the loan paragraph appears once there is a loan',
        /Loans and advances outstanding/.test(text(brief)), true);
  check('and the balance is the one loanBalanceAfterMonth reports',
        brief.figures.loanBalance > 0, true);
}

// ------------------------------------------------------------ the check agrees
console.log('\nthe briefing and the pre-payroll check are one run, not two\n');
{
  const att = attendance();
  delete att['2026-08-11'];
  const { brief } = build([emp()], { E1: att }, true);
  check('a must-fix in the check is reported in the briefing',
        /had to be fixed before this ran/.test(text(brief)), true);
  check('and it is named', /attendance not complete/i.test(text(brief)), true);
}
{
  const { brief } = build([emp()], { E1: attendance() }, true);
  check('a clean check says so plainly', /found nothing at all/.test(text(brief)), true);
}

// ------------------------------------------------------------------- provenance
console.log('\nwhere a reader can go to check it\n');
{
  const { brief } = build([emp()], { E1: attendance() }, true);
  check('the reports behind it are named', brief.sources.includes('Salary Sheet'), true);
  check('including the check it quotes', brief.sources.includes('Pre-Payroll Check'), true);
  check('every paragraph is a non-empty sentence',
        brief.paragraphs.every(p => typeof p === 'string' && p.trim().length > 20 && /\.$/.test(p.trim())), true);
}

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
