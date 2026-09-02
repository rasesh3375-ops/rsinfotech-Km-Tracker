// The wage register has to hold together the way the consultant's does, or it
// cannot be compared against it. His passes four identities on every row —
// days, earnings, deductions and net — and so must ours, including for the
// awkward people: a mid-month joiner, someone with a policy half-day cut, a
// loan, an advance, retention, conveyance, and a Resident Engineer outside the
// leave scheme.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..');

const sb = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp,
             Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(R + '/shared/report-logic.js', 'utf8'), sb);
const L = vm.runInContext('({wageRegisterRows, wageRegisterCsvRows, WAGE_REGISTER_COLS,' +
  ' consultantReportEmployees, consultantReportRows, salarySheetCsv, SALARY_SHEET_COLS})', sb);

const C = {}; L.WAGE_REGISTER_COLS.forEach((n, i) => { C[n] = i; });

// August 2026: 31 days, Sundays on 2/9/16/23/30, one declared holiday on the 28th.
const monthDays = 31, year = 2026, month = 8;
const dateList = [];
for (let d = 1; d <= monthDays; d++) dateList.push('2026-08-' + String(d).padStart(2, '0'));
const holidayMap = { '2026-08-28': true };
const workDates = dateList.filter(d => new Date(d + 'T00:00:00').getDay() !== 0 && !holidayMap[d]);

const mk = (o) => Object.assign({
  employmentStatus: 'active', employeeType: 'office', doj: '2020-01-01', dob: '1990-01-01',
  designation: 'Engineer', uan: '101234567890', esiNumber: '3812900001',
  accountNumber: '23010049481236', pfEligible: 'yes', esiEligible: 'yes',
  pfContributionType: 'percent', elOpening: 7, slOpening: 7, leaveOpeningFrom: '2026-04-01'
}, o);

const EMPS = [
  mk({ id:'1', name:'Full Month',     seqNo:1, salaryHeading:'managerial', ratePay:39215 }),
  mk({ id:'2', name:'Took EL',        seqNo:2, salaryHeading:'managerial', ratePay:39215 }),
  mk({ id:'3', name:'Absent Half',    seqNo:3, salaryHeading:'junior',     ratePay:29328 }),
  mk({ id:'4', name:'Has Loan',       seqNo:4, salaryHeading:'senior',     ratePay:29165,
       loans:[{ id:'L1', amount:60000, instalment:2500, startMonth:'2026-04', status:'active' }] }),
  mk({ id:'5', name:'Has Advance',    seqNo:5, salaryHeading:'senior',     ratePay:27200,
       advances:[{ id:'A1', month:'2026-08', amount:200, type:'temp' }] }),
  mk({ id:'6', name:'Gets Conveyance',seqNo:6, salaryHeading:'junior',     ratePay:28980, conveyance:2878 }),
  mk({ id:'7', name:'Mid Month Join', seqNo:7, salaryHeading:'senior',     ratePay:26810, doj:'2026-08-03' }),
  mk({ id:'8', name:'Late Comer',     seqNo:8, salaryHeading:'junior',     ratePay:18710 }),
  mk({ id:'9', name:'Resident Eng',   seqNo:9, salaryHeading:'senior',     ratePay:28766,
       employeeType:'resident' }),
  mk({ id:'10',name:'Has Retention',  seqNo:10,salaryHeading:'junior',     ratePay:24000,
       retentionAmount:1500 }),
];

// Attendance: everyone present, then the specific shapes each name promises.
const att = {};
EMPS.forEach(e => { att[e.id] = {}; workDates.forEach(d => { att[e.id][d] = { code:'P' }; }); });
att['2']['2026-08-10'] = { code:'EL' };
att['2']['2026-08-11'] = { code:'HEL' };
att['3']['2026-08-12'] = { code:'HLP' };
att['3']['2026-08-13'] = { code:'SL' };
att['3']['2026-08-14'] = { code:'SL' };
// The mid-month joiner: 1 and 2 August are both before he started, and the 2nd
// is a Sunday. That is the shape that broke the real register — the day is a
// week-off and a non-employed day at once, so counting the month's five
// Sundays flat made the row add to 30 in a month he is paid 29 for.
att['7']['2026-08-01'] = { code:'A' };
att['7']['2026-08-02'] = { code:'A' };
// Late arrivals past the three free instances, so a policy half-day is charged.
['03','04','05','06','07','10','11'].forEach(dd => {
  att['8']['2026-08-' + dd] = { code:'P', checkinTime:'09:45', checkoutTime:'18:30' };
});

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ' + JSON.stringify(got) +
              (ok ? '' : '   want ' + JSON.stringify(want)));
  if (!ok) fails.push(label);
};
const n = v => Number(v) || 0;

const built = L.wageRegisterRows(L.consultantReportEmployees(EMPS, dateList),
                                att, dateList, monthDays, holidayMap, year, month);

console.log('register rows: ' + built.rows.length + ', columns: ' + built.cols.length + '\n');
check('every employee in scope has a row', built.rows.length, EMPS.length);
console.log('');

console.log('each row adds up on its own terms, the way his does\n');
let dayBad = 0, earnBad = 0, deduBad = 0, netBad = 0;
built.rows.forEach(r => {
  const name = r[C['Emp Name']];
  const days = n(r[C['P.Days']]) + n(r[C['W.Off']]) + n(r[C['P.H.']]) +
               n(r[C['PL']]) + n(r[C['SL']]);
  const earn = n(r[C['Basic']]) + n(r[C['HRA']]) + n(r[C['LTA']]) + n(r[C['Conv All']]) +
               n(r[C['Per.All']]) + n(r[C['Extra All2']]);
  const dedu = n(r[C['P.F.']]) + n(r[C['P.T.']]) + n(r[C['Adv']]) + n(r[C['L.W.F.']]) +
               n(r[C['Loan']]) + n(r[C['Retention']]) + n(r[C['E.S.I.']]);
  const okDay  = Math.abs(days - n(r[C['Payable Days']])) < 0.001;
  const okEarn = Math.abs(earn - n(r[C['Gross Earni.']])) <= 1;
  const okDedu = Math.abs(dedu - n(r[C['Gross Dedu.']])) <= 1;
  const okNet  = Math.abs(n(r[C['Gross Earni.']]) - n(r[C['Gross Dedu.']]) - n(r[C['Net Salary']])) <= 1;
  if (!okDay)  { dayBad++;  console.log('    ' + name + ' days ' + days + ' vs payable ' + r[C['Payable Days']]); }
  if (!okEarn) { earnBad++; console.log('    ' + name + ' earnings ' + earn + ' vs gross ' + r[C['Gross Earni.']]); }
  if (!okDedu) { deduBad++; console.log('    ' + name + ' deductions ' + dedu + ' vs total ' + r[C['Gross Dedu.']]); }
  if (!okNet)  { netBad++;  console.log('    ' + name + ' net does not follow'); }
});
check('P.Days + W.Off + P.H. + PL + SL = Payable Days, every row', dayBad, 0);
check('every earning head adds to Gross Earni.', earnBad, 0);
check('every deduction head adds to Gross Dedu.', deduBad, 0);
check('Gross Earni. − Gross Dedu. = Net Salary', netBad, 0);

console.log('\nthe mid-month joiner is the case a flat Sunday count gets wrong\n');
const joiner = built.rows.find(r => r[C['Emp Name']] === 'Mid Month Join');
console.log('  P.Days ' + joiner[C['P.Days']] + ' · W.Off ' + joiner[C['W.Off']] +
            ' · P.H. ' + joiner[C['P.H.']] + ' · Payable ' + joiner[C['Payable Days']]);
check('he gets four week-offs, not the month\'s five', n(joiner[C['W.Off']]), 4);
check('and his row still adds to his payable days',
      n(joiner[C['P.Days']]) + n(joiner[C['W.Off']]) + n(joiner[C['P.H.']]) +
      n(joiner[C['PL']]) + n(joiner[C['SL']]), n(joiner[C['Payable Days']]));

console.log('\nthe totals are the columns added up, not recomputed\n');
let totBad = 0;
['Basic','HRA','LTA','Conv All','P.F.','P.T.','Adv','Loan','Retention','E.S.I.',
 'Gross Earni.','Gross Dedu.','Net Salary','P.Days','PL','SL','Payable Days'].forEach(k => {
  const sum = built.rows.reduce((t, r) => t + n(r[C[k]]), 0);
  const shown = n(built.total[C[k]]);
  const ok = Math.abs(sum - shown) < 0.001;
  if (!ok) { totBad++; console.log('    ' + k + ': rows ' + sum + ', total row ' + shown); }
});
check('every total column equals the sum of its rows', totBad, 0);
check('W.Days on the total row is per-person days × headcount',
      n(built.total[C['W.Days']]), monthDays * built.rows.length);
check('the total row is labelled', built.total[C['Emp Name']], 'GRAND TOTAL');

console.log('\nit agrees with the Salary Sheet, which is the whole point\n');
const sheet = L.salarySheetCsv(EMPS, att, dateList, monthDays, holidayMap);
const S = {}; L.SALARY_SHEET_COLS.forEach((h, i) => { S[h] = i; });
const sheetRows = {};
sheet.rows.forEach(r => {
  if (r.length === L.SALARY_SHEET_COLS.length && typeof r[S['SR NO']] === 'number') {
    sheetRows[r[S['Name']]] = r;
  }
});
let driftBad = 0;
built.rows.forEach(r => {
  const name = r[C['Emp Name']], sr = sheetRows[name];
  if (!sr) return;
  const pairs = [
    ['Basic', 'Basic'], ['HRA', 'HRA'], ['LTA', 'LTA'], ['P.F.', 'PF'],
    ['P.T.', 'PT'], ['E.S.I.', 'ESI'], ['Loan', 'Loan EMI'],
    // Net on the register is the Salary Sheet's Consultant Salary, not its Net
    // Salary: conveyance is paid but sits outside the wage register, so the
    // two columns are different figures on purpose for anyone drawing it.
    ['Gross Dedu.', 'Total Deduction'], ['Net Salary', 'Consultant Salary']
  ];
  pairs.forEach(([reg, she]) => {
    if (Math.abs(n(r[C[reg]]) - n(sr[S[she]])) > 0.5) {
      driftBad++;
      console.log('    ' + name + ' ' + reg + ': register ' + r[C[reg]] + ', salary sheet ' + sr[S[she]]);
    }
  });
});
check('not one figure differs from the Salary Sheet', driftBad, 0);

console.log('\nconveyance is paid, and deliberately not on this register\n');
const conv = built.rows.find(r => r[C['Emp Name']] === 'Gets Conveyance');
const convSheet = sheetRows['Gets Conveyance'];
console.log('  Salary Sheet: gross ' + convSheet[S['Gross']] + ' + conveyance ' +
            convSheet[S['Conveyance']] + ' = net ' + convSheet[S['Net Salary']]);
console.log('  Register    : gross ' + conv[C['Gross Earni.']] + ' + Conv All ' +
            conv[C['Conv All']] + ' = net ' + conv[C['Net Salary']]);
check('he really does draw conveyance', n(convSheet[S['Conveyance']]) > 0, true);
check('the register\'s Conv All column is nil', n(conv[C['Conv All']]), 0);
check('and its rate column too', n(conv[C['Conv All Rate']]), 0);
check('so his Gross Earni. is Basic + HRA + LTA only',
      n(conv[C['Gross Earni.']]), n(convSheet[S['Gross']]));
check('and the register net is below the Salary Sheet net by the conveyance',
      n(convSheet[S['Net Salary']]) - n(conv[C['Net Salary']]), n(convSheet[S['Conveyance']]));
check('while the Salary Sheet still pays it in full',
      n(convSheet[S['Net Salary']]),
      n(convSheet[S['Consultant Salary']]) + n(convSheet[S['Conveyance']]));

console.log('\nthe identifier columns survive Excel\n');
const csv = L.wageRegisterCsvRows(built.rows);
const uan = csv[0][C['UAN No']], acct = csv[0][C['A/c No']];
console.log('  UAN "' + uan + '"   A/c "' + acct + '"');
check('a 12-digit UAN is wrapped so Excel keeps every digit', /^="/.test(String(uan)), true);
check('a 14-digit account number too', /^="/.test(String(acct)), true);
check('and the money columns are untouched by the wrapper',
      csv[0][C['Net Salary']], built.rows[0][C['Net Salary']]);

console.log('\n' + (fails.length ? fails.length + ' FAILURE(S):\n  ' + fails.join('\n  ') : 'PASS'));
process.exit(fails.length ? 1 : 0);
