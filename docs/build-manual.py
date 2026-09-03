#!/usr/bin/env python3
"""Builds docs/HR-Module-Manual.pdf — the HR module manual.

    pip install reportlab
    python3 docs/build-manual.py

Kept in the repo so the manual can be regenerated rather than edited as a
binary: when a policy figure, a report or a screen changes, change it here and
rebuild, so the manual and the app cannot drift apart the way a hand-edited PDF
would. DejaVu is used rather than a built-in font because the built-ins have no
rupee glyph and would print a black box for every amount.
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, PageBreak, NextPageTemplate)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

D = '/usr/share/fonts/truetype/dejavu/'
pdfmetrics.registerFont(TTFont('Sans', D + 'DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('Sans-B', D + 'DejaVuSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Serif-B', D + 'DejaVuSerif-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Mono', D + 'DejaVuSansMono.ttf'))
# No oblique DejaVu Sans on this system, so <i> falls back to the upright face
# rather than reportlab reaching for a font that is not there.
pdfmetrics.registerFontFamily('Sans', normal='Sans', bold='Sans-B',
                              italic='Sans', boldItalic='Sans-B')

INK   = colors.HexColor('#1A1D1B')
INK2  = colors.HexColor('#4A524D')
INK3  = colors.HexColor('#7C847E')
ACC   = colors.HexColor('#16564A')
RULE  = colors.HexColor('#D2D7D3')
SUNK  = colors.HexColor('#EFF1EE')
WARN  = colors.HexColor('#8A4B12')
WARNBG= colors.HexColor('#F8F1E7')

import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'HR-Module-Manual.pdf')

S = {
 'h1': ParagraphStyle('h1', fontName='Serif-B', fontSize=17, leading=21, textColor=ACC,
                      spaceBefore=2, spaceAfter=9),
 'h2': ParagraphStyle('h2', fontName='Sans-B', fontSize=11.5, leading=15, textColor=INK,
                      spaceBefore=13, spaceAfter=5),
 'h3': ParagraphStyle('h3', fontName='Sans-B', fontSize=9.6, leading=13, textColor=ACC,
                      spaceBefore=10, spaceAfter=3),
 'p':  ParagraphStyle('p', fontName='Sans', fontSize=9.4, leading=14.2, textColor=INK2,
                      spaceAfter=6, alignment=TA_LEFT),
 'li': ParagraphStyle('li', fontName='Sans', fontSize=9.4, leading=14, textColor=INK2,
                      leftIndent=11, bulletIndent=2, spaceAfter=3.5),
 'num':ParagraphStyle('num', fontName='Sans', fontSize=9.4, leading=14, textColor=INK2,
                      leftIndent=16, bulletIndent=2, spaceAfter=5),
 'cell':ParagraphStyle('cell', fontName='Sans', fontSize=8.4, leading=11.6, textColor=INK2),
 'cellb':ParagraphStyle('cellb', fontName='Sans-B', fontSize=8.4, leading=11.6, textColor=INK),
 'note':ParagraphStyle('note', fontName='Sans', fontSize=8.8, leading=13, textColor=INK2,
                       leftIndent=8, rightIndent=6, spaceBefore=3, spaceAfter=3),
 'cap':ParagraphStyle('cap', fontName='Sans', fontSize=8.2, leading=11.5, textColor=INK3,
                      spaceBefore=3, spaceAfter=8),
}

def P(t, s='p'): return Paragraph(t, S[s])
def bullets(items, style='li'):
    return [Paragraph(t, S[style], bulletText='•') for t in items]
def steps(items):
    return [Paragraph(t, S['num'], bulletText='%d.' % (i + 1)) for i, t in enumerate(items)]

def box(title, body, tone='note'):
    bg, bar = (WARNBG, WARN) if tone == 'warn' else (SUNK, ACC)
    inner = [Paragraph('<b>%s</b>' % title, S['note'])] + [Paragraph(b, S['note']) for b in body]
    t = Table([[inner]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), bg),
        ('LINEBEFORE', (0,0), (0,-1), 2, bar),
        ('LEFTPADDING', (0,0), (-1,-1), 8), ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('TOPPADDING', (0,0), (-1,-1), 7), ('BOTTOMPADDING', (0,0), (-1,-1), 7),
    ]))
    return [Spacer(1, 3), t, Spacer(1, 7)]

def table(head, rows, widths, align_right=()):
    data = [[Paragraph(h, S['cellb']) for h in head]]
    for r in rows:
        data.append([Paragraph(str(c), S['cell']) for c in r])
    t = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    st = [
        ('BACKGROUND', (0,0), (-1,0), SUNK),
        ('LINEBELOW', (0,0), (-1,0), 0.8, colors.HexColor('#B4BCB6')),
        ('LINEBELOW', (0,1), (-1,-2), 0.4, RULE),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 6), ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ]
    for c in align_right:
        st.append(('ALIGN', (c,0), (c,-1), 'RIGHT'))
    t.setStyle(TableStyle(st))
    return [t, Spacer(1, 4)]

# ---------------------------------------------------------------- page frame
TITLE = 'R.S. Infotech — HR Module Manual'

def later_pages(canvas, doc):
    canvas.saveState()
    canvas.setFont('Sans', 7.5)
    canvas.setFillColor(INK3)
    canvas.drawString(22 * mm, 12 * mm, TITLE)
    canvas.drawRightString(A4[0] - 22 * mm, 12 * mm, 'Page %d' % (doc.page - 1))
    canvas.setStrokeColor(RULE); canvas.setLineWidth(0.4)
    canvas.line(22 * mm, 15.5 * mm, A4[0] - 22 * mm, 15.5 * mm)
    canvas.restoreState()

def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(ACC)
    canvas.rect(0, A4[1] - 92 * mm, A4[0], 92 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont('Sans', 9)
    canvas.drawString(22 * mm, A4[1] - 30 * mm, 'R.S. INFOTECH')
    canvas.setFont('Serif-B', 30)
    canvas.drawString(22 * mm, A4[1] - 50 * mm, 'HR Module Manual')
    canvas.setFont('Sans', 11)
    canvas.drawString(22 * mm, A4[1] - 62 * mm, 'For HR, and for anyone new to the system')
    canvas.setFont('Sans', 8.5)
    canvas.setFillColor(colors.HexColor('#BFD9D2'))
    canvas.drawString(22 * mm, A4[1] - 78 * mm,
                      'Payroll, attendance, leave, statutory returns and the monthly cycle')
    canvas.setFillColor(INK3)
    canvas.setFont('Sans', 8)
    canvas.drawString(22 * mm, 18 * mm,
                      'This manual describes the system as it stands. Where a figure comes from '
                      'policy — a percentage, a')
    canvas.drawString(22 * mm, 13 * mm,
                      'ceiling, a leave allowance — it is HR and the PF consultant who own it, '
                      'not the software.')
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=22*mm, rightMargin=22*mm,
                      topMargin=20*mm, bottomMargin=20*mm,
                      title='R.S. Infotech HR Module Manual',
                      author='R.S. Infotech', subject='HR module user manual')
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='body')
doc.addPageTemplates([
    PageTemplate(id='cover', frames=[frame], onPage=cover_page),
    PageTemplate(id='body', frames=[frame], onPage=later_pages),
])

st = []
A = st.append
def add(items):
    for i in items: st.append(i)

# ------------------------------------------------------------------ cover
# Without the switch the cover artwork is drawn behind every page, because the
# first template stays in force until something changes it.
A(Spacer(1, 120 * mm))
A(NextPageTemplate('body'))
A(PageBreak())

# ------------------------------------------------------------------ contents
A(P('What is in this manual', 'h1'))
contents = [
    ('1', 'Getting in, and what you are looking at', 'Login, the tabs, phone and desktop'),
    ('2', 'The month, start to finish', 'The order the work actually happens in'),
    ('3', 'Employee Master', 'Adding someone, and the fields that decide their pay'),
    ('4', 'Attendance', 'The codes, and the policies applied for you'),
    ('5', 'How pay is worked out', 'Headings, PF, ESI, PT and what comes off'),
    ('6', 'Leave', 'SL, EL, sandwich days and encashment'),
    ('7', 'Loans and advances', 'Recording one, and changing an EMI'),
    ('8', 'Reports', 'What each one is for and who receives it'),
    ('9', 'Generator', 'Letters, checklists and payroll documents'),
    ('10', 'Settings', 'The six things you can change'),
    ('11', 'The automatic emails', 'What sends, when, and to whom'),
    ('12', 'Care and troubleshooting', 'What to check when a figure looks wrong'),
]
add(table(['', 'Section', 'What it covers'],
          [[n, '<b>%s</b>' % t, d] for n, t, d in contents],
          [10*mm, 58*mm, 97*mm]))

A(PageBreak())

# ------------------------------------------------------------------ 1
A(P('1 &nbsp;Getting in, and what you are looking at', 'h1'))
A(P('The HR app runs in a browser. There is nothing to install and nothing to update — '
    'open the address and you have the current version.'))
A(P('Signing in', 'h2'))
add(steps([
  'Open the HR address in Safari or Chrome. On an iPhone, use the icon on the home screen '
  'if one has been added — it opens the HR app directly.',
  'Sign in with your own username and password. Do not share a login: the Activity Log '
  'records who changed what, and a shared login makes that record useless.',
  'If a screen looks stale after an update, close the app completely and reopen it, or '
  'pull down to refresh in the browser.',
]))

A(P('The tabs', 'h2'))
add(table(['Tab', 'What you do there'], [
  ['<b>Dashboard</b>', 'Today at a glance — who is in, who is absent, live tracking, the daily summary, '
   'and the shortcuts for loans, advances, document expiry and increment reminders.'],
  ['<b>Employee Master</b>', 'The staff records. Add someone, change a salary, record a loan, upload documents.'],
  ['<b>Attendance Sheet</b>', 'The month grid. Mark the days, see the policy position for each person.'],
  ['<b>Salary Sheet</b>', 'The month\'s pay, every column, grouped by salary heading.'],
  ['<b>Reports</b>', 'Everything you send out or file — statutory returns, consultant reports, leave reports.'],
  ['<b>Generator</b>', 'Documents you produce — letters, checklists, the handbook, payroll document filing.'],
  ['<b>Settings</b>', 'The few things that are configurable.'],
], [34*mm, 131*mm]))

add(box('On a phone', [
  'Every sheet that is a wide table on a laptop becomes a stack of cards on a phone, one card '
  'per employee, so nothing needs sideways scrolling. The figures are identical — only the '
  'layout changes.',
]))

A(PageBreak())

# ------------------------------------------------------------------ 2
A(P('2 &nbsp;The month, start to finish', 'h1'))
A(P('This is the order the work actually happens in. Everything else in this manual is detail '
    'hanging off one of these steps.'))

A(P('Through the month', 'h2'))
add(steps([
  '<b>Mark attendance</b> on the Attendance Sheet as the days go, or in a batch — whichever '
  'suits. Late arrivals and short leaves are counted for you.',
  '<b>Record loans and advances</b> as they are agreed, from the Dashboard shortcuts or the '
  'employee\'s own record.',
  '<b>Approve leave requests</b> as engineers raise them.',
  '<b>File payroll documents</b> — challans and receipts — under Generator → Payroll Documents '
  'as they arrive.',
]))

A(P('At month end', 'h2'))
add(steps([
  '<b>Finish the attendance</b> for the month. Nothing downstream is right until this is.',
  '<b>Open the Salary Sheet</b> for the month and read it. This is where a wrong attendance day '
  'or a missing increment shows up as a wrong figure.',
  '<b>Check the Consultant Final Summary Report.</b> It carries the wage register and the '
  'PF/ESI/PT totals, in the layout the consultant uses.',
  '<b>Send the consultant what he needs</b> — the Consultant Report and the Final Summary.',
  '<b>Take the Final Salary Sheet for Accountant</b> to whoever makes the bank transfer. '
  'The last column is the amount to pay.',
  '<b>When his register comes back, compare it</b> against ours. See section 12.',
]))

add(box('The emails do some of this for you', [
  'On the 2nd of each month the system emails the report pack, the Loan and EMI Report, the '
  'Monthly Leave Detail Report, the Consultant Report and the salary advance summary — all for '
  'the month just gone. You do not have to generate those by hand. Section 11 lists them.',
]))

A(P('What to look at first on the Salary Sheet', 'h2'))
add(bullets([
  '<b>Anyone new</b> — is their Date of Joining right, and is their first month prorated as you expect?',
  '<b>Anyone who left</b> — are they still on the sheet when they should not be?',
  '<b>Leave Days and Policy Half Days</b> — a surprise here almost always means an attendance day is wrong.',
  '<b>Loan EMI and Advance</b> — do the recoveries match what was agreed?',
  '<b>The Grand Total</b> — compare it against last month. A jump you cannot explain is worth '
  'chasing before the money moves.',
]))

A(PageBreak())

# ------------------------------------------------------------------ 3
A(P('3 &nbsp;Employee Master', 'h1'))
A(P('One record per person. Everything about their pay is worked out from this record at the '
    'moment it is shown — nothing is stored already-calculated, so correcting a field here '
    'corrects every report that reads it.'))

A(P('Adding someone', 'h2'))
add(steps([
  'Employee Master → <b>Add Employee</b>.',
  'Fill the <b>Basic details</b>: name, employee code, designation, date of birth, '
  '<b>Date of Joining</b>, mobile, email.',
  'Set the <b>Sequence No.</b> — the position this person holds in every report. Give them a '
  'number somebody already has and everyone from there down shifts one place.',
  'Choose the <b>Salary Heading</b> and enter the <b>Rate of Pay</b>. See section 5 — the '
  'heading decides the Basic/HRA/LTA split and which deductions apply at all.',
  'Choose the <b>Employee Type</b>: Field, Office, Work From Home or Resident. This is separate '
  'from the heading and decides the <i>leave</i> rules.',
  'Answer the <b>PF and ESI</b> questions: eligibility, contribution type, prior UAN, Form 11, '
  'disability, already-covered.',
  'Enter <b>bank details</b> — name, account number, IFSC. The accountant\'s sheet is built from these.',
  'Add <b>opening leave balances</b> (EL and SL) and the date they apply from.',
  'Upload <b>documents</b> in the Documents section. They go to Drive; the record keeps the link.',
  '<b>Save.</b> A message confirms what was written.',
]))

add(box('Rate of Pay is the gross, not take-home', [
  'It is the figure everything else is derived from. Statutory deductions come out of it; the '
  'employer\'s contributions sit on top of it. If you enter what somebody actually receives in '
  'the bank, every figure in the system will be wrong.',
], 'warn'))

A(P('Changing a salary', 'h2'))
A(P('Use <b>Record Increment</b> on the employee\'s record rather than editing Rate of Pay '
    'directly. An increment is dated, so past months keep the old rate and only months from the '
    'effective date carry the new one. Editing the rate in place would rewrite history.'))

A(P('When somebody leaves', 'h2'))
A(P('Set their employment status to left and enter the leaving date. They stay on reports for '
    'the months they worked and drop off after. Use the Joining/Exit checklist in the Generator '
    'so nothing is missed.'))

A(PageBreak())

# ------------------------------------------------------------------ 4
A(P('4 &nbsp;Attendance', 'h1'))
A(P('The Attendance Sheet is a grid: employees down the side, days of the month across. Pick the '
    'month, click a day, choose a code.'))

A(P('The codes', 'h2'))
add(table(['Code', 'Means', 'Effect on pay'], [
  ['<b>P</b>', 'Present', 'Paid in full'],
  ['<b>EL</b>', 'Earned leave (privilege leave)', 'Paid, comes off the EL balance'],
  ['<b>SL</b>', 'Sick leave', 'Paid, comes off the SL balance. Needs a medical certificate'],
  ['<b>HEL</b>', 'Half day earned leave', 'Half present, half EL'],
  ['<b>HSL</b>', 'Half day sick leave', 'Half present, half SL'],
  ['<b>HLP</b>', 'Half day leave without pay', 'Half present, half unpaid'],
  ['<b>A</b>', 'Absent', 'Unpaid'],
  ['<b>LP</b>', 'Leave without pay', 'Unpaid'],
  ['<b>H</b>', 'Week off or declared holiday', 'Paid, not a working day. Counts towards EL'],
  ['<b>SHORT</b>', 'Short leave', 'Counted as present; three a month are free, past that see below'],
], [18*mm, 60*mm, 87*mm]))

A(P('What the system applies for you', 'h2'))
add(bullets([
  '<b>Late coming.</b> Fifteen minutes\' grace, then three free instances a month. Past that each '
  'late arrival is judged by its own instance number: the 4th is a warning with no deduction, the '
  '5th costs half a day, the 6th another warning, and the 7th — and every one after — costs a full day.',
  '<b>Sandwich leave.</b> A Sunday or declared holiday is charged as an extra unpaid day when the '
  'working day immediately before <i>and</i> the working day immediately after are both Absent or '
  'Leave Without Pay. Approved leave on either side does not trigger it. A run of adjacent '
  'non-working days is judged as one block.',
  '<b>Resident Engineers are outside all of it</b> — leave, short leave, late coming and overtime '
  'rules do not apply to them.',
]))

add(box('Finish the month before you read the Salary Sheet', [
  'An unmarked past day counts as absent. That is deliberate — it stops a forgotten day being '
  'silently paid — but it means a half-marked month reads as though people were away.',
]))

A(P('Bulk marking', 'h2'))
A(P('Settings → <b>Always mark Present — bulk apply</b> fills a whole month as Present for the '
    'staff you choose, so you only edit the exceptions. Saves are batched: one write for the '
    'whole sheet, not one per cell.'))

A(PageBreak())

# ------------------------------------------------------------------ 5
A(P('5 &nbsp;How pay is worked out', 'h1'))
A(P('The salary heading decides two things at once: how Rate of Pay splits into Basic, HRA and '
    'LTA, and which statutory deductions apply at all.'))

add(table(['Heading', 'Basic', 'HRA', 'LTA', 'PF', 'ESI', 'PT'], [
  ['Managerial Staff', '65%', '35%', '—', 'Yes', 'Yes', 'Yes'],
  ['Seniors Staff', '50%', '40%', '10%', 'Yes', 'Yes', 'Yes'],
  ['Junior Staff', '100% flat', '—', '—', 'Yes', 'Yes', 'Yes'],
  ['Apprentices', '50%', '40%', '10%', '—', '—', '—'],
  ['R.S.IT Solution', '50%', '40%', '10%', '—', '—', 'Yes'],
  ['Contractors', '50%', '40%', '10%', '—', '—', '—'],
], [40*mm, 22*mm, 18*mm, 18*mm, 16*mm, 16*mm, 16*mm]))
A(Paragraph('The explanatory text on screen is generated from this same table, so it always '
            'matches what was actually applied.', S['cap']))

A(P('The statutory deductions', 'h2'))
A(P('<b>Provident Fund.</b> 12% from the employee and 12% from the employer, on <b>Basic only</b>. '
    'The employer\'s share splits into Pension (EPS, 8.33%, capped at ₹1,250) and EPF. '
    'Administration charges of 0.5% and EDLI of 0.5% sit on top. EPFO caps the PF wage at '
    '₹15,000 a month, so anyone whose Basic is above that contributes on ₹15,000 unless they are '
    'one of the agreed exceptions. Marking somebody not eligible means no PF at all, whatever '
    'the wage.'))
A(P('<b>ESI.</b> 0.75% from the employee and 3.25% from the employer, and it stops strictly above '
    '₹21,000 gross (₹25,000 for a person with a disability). Once covered, coverage continues to '
    'the end of the half-yearly contribution period — April to September, or October to March — '
    'even if the wage rises above the ceiling mid-period. Each member\'s share is rounded up to '
    'the next rupee, which is what ESIC requires.'))
A(P('<b>Professional Tax.</b> A flat ₹200 a month once gross is above ₹12,000, capped at ₹2,500 '
    'in a year.'))

A(P('What else comes off', 'h2'))
add(bullets([
  '<b>Loan EMI</b> — whatever is in force for that month.',
  '<b>Advance</b> and <b>Temporary Advance</b> recoveries.',
  '<b>Retention</b>, where one applies.',
  '<b>Leave amount</b> — the value of unpaid days.',
]))

A(P('And what sits outside', 'h2'))
A(P('<b>Conveyance expense</b> is reimbursed on top of salary. It carries no PF, ESI or PT, and '
    'it is deliberately not on the wage register the consultant files. It <i>is</i> paid, and it '
    'appears on the Salary Sheet, the payslip and the accountant\'s sheet.'))
A(P('<b>Diwali bonus</b> is the amount you enter and nothing else. Nothing is ever deducted from '
    'it — no PF, no ESI, no PT, no advance, no retention, no leave. Leave it blank and the person '
    'does not appear on the bonus payment sheet.'))

add(box('Every amount is whole rupees', [
  'No paise, anywhere. Totals are the sum of the rounded figures printed above them, so a column '
  'always adds up to what you can see — which is what a PF or ESI challan has to match.',
]))

A(PageBreak())

# ------------------------------------------------------------------ 6
A(P('6 &nbsp;Leave', 'h1'))
add(table(['', 'Rule'], [
  ['<b>Sick leave</b>', '7 days a year, or 4 for Work From Home. Not carried forward. '
   'A medical certificate is required.'],
  ['<b>Earned leave</b>', 'One day per 25 qualifying present days, as a running total across '
   'the whole financial year — it does not start again each month. The total is rounded to the '
   'nearest whole day at the end of the year: 28 qualifying days earns 1 day, 12 days earns '
   'nothing and 13 earns a full day. The rounding happens once, on the year\'s total, so the '
   'remainder still carries from month to month. Not carried forward: what is earned in one '
   'year becomes next year\'s opening balance.'],
  ['<b>A qualifying day</b>', 'Exactly the Present figure the Attendance Sheet prints for that '
   'person, added up month by month, so the two can never disagree. A day present counts 1 '
   '(short leave included) and a half-day code counts 0.5, with the late-coming policy cut '
   'taken off the same way it is there. EL, SL, a declared holiday, a Sunday, unpaid absence '
   'and an unmarked day all count nothing — none of them is a day worked.'],
  ['<b>Encashment</b>', 'Earned leave is encashable at 70% of Basic + HRA, a day being a '
   'twenty-fifth of that.'],
  ['<b>Resident Engineers</b>', 'Outside the leave scheme entirely. Their leave columns read NA.'],
], [32*mm, 133*mm]))

A(P('Where to look', 'h2'))
add(bullets([
  '<b>EL SL Current Status</b> — where everybody stands right now.',
  '<b>Monthly Leave Detail Report</b> — late coming, EL/PL, SL, half days and short leave, broken out.',
  '<b>Yearly Total Leave Report</b> — the year in one page.',
  '<b>Leave Encashment Report</b> (Generator) — what the pending balance is worth.',
  '<b>Leave Balance Next Year</b> — what carries into the coming financial year.',
]))

add(box('The financial year', [
  '1 April to 31 March. FY 2026-27 runs 1 April 2026 to 31 March 2027. Every year-scoped figure '
  'in the system — leave, PT cap, attendance storage — uses this, not the calendar year.',
]))

# ------------------------------------------------------------------ 7
A(P('7 &nbsp;Loans and advances', 'h1'))
A(P('Both can be recorded from the Dashboard shortcuts — <b>Employee Loan &amp; EMI</b> and '
    '<b>Salary Advance Payment</b> — or from the employee\'s own record.'))

A(P('Recording a loan', 'h2'))
add(steps([
  'Dashboard → <b>Employee Loan &amp; EMI</b>.',
  'Choose the employee. Any existing loans are listed with their current EMI and outstanding balance.',
  'Enter the loan amount, the monthly EMI and the month recovery starts from.',
  'Save. From that month on the EMI comes off the salary automatically and the balance reduces '
  'each month until it clears.',
]))

A(P('Changing an EMI partway through', 'h2'))
A(P('Use the <b>Change EMI</b> control on the loan itself. Give the month the new EMI starts '
    'from and the new amount. Months before that keep the old rate, so past payroll is untouched; '
    'the remaining balance is recalculated automatically. Both the old and new EMI stay in the '
    'loan\'s history. The loan is never deleted and recreated.'))

add(box('A new EMI can only start this month or later', [
  'The system refuses a past month deliberately. Changing an EMI backwards would alter payroll '
  'that has already been paid and filed.',
], 'warn'))

A(PageBreak())

# ------------------------------------------------------------------ 8
A(P('8 &nbsp;Reports', 'h1'))
A(P('Every report is generated for a month you choose, can be printed or shared, and files a copy '
    'to Drive under HR Management → the financial year → Reports.'))

A(P('For the PF consultant', 'h3'))
add(table(['Report', 'What it is'], [
  ['<b>Consultant Report</b>', 'One row per employee: attendance days, leave, gross, loan and '
   'advance. This is what he works from.'],
  ['<b>Consultant Final Summary Report</b>', 'The wage register in his own column order, then the '
   'PF, ESI, allowance and deduction totals. Built so you can read it against the register he '
   'sends back, row for row.'],
  ['<b>PF Report</b>', 'The PF return — every account, per member and in total.'],
  ['<b>ESI Report</b>', 'The ESI return.'],
  ['<b>PT Report</b>', 'Professional tax. Covers R.S.IT Solution as well as the core three '
   'headings, because PT applies to them.'],
], [50*mm, 115*mm]))

A(P('For payment', 'h3'))
add(table(['Report', 'What it is'], [
  ['<b>Final Salary Sheet for Accountant</b>', 'Grouped by heading, sorted by bank, with account '
   'number and IFSC. The last column is the amount to transfer. In a month somebody draws '
   'conveyance it splits into Payable Salary and Conveyance Expense as well.'],
  ['<b>Diwali Bonus Payment Sheet</b>', 'The bonus payment list, same shape.'],
], [50*mm, 115*mm]))

A(P('For management', 'h3'))
add(table(['Report', 'What it is'], [
  ['<b>Salary Report Net for Employer</b>', 'Salary at full attendance — no leave, absence or LOP '
   'applied. Loan, advance and retention <i>are</i> deducted.'],
  ['<b>Month-wise Salary Comparison</b>', 'This month against last, with every reason for the gap '
   'named, and the reasons adding back up to the difference.'],
  ['<b>Cost to Company Report</b>', 'What each person costs including the employer side.'],
  ['<b>Increment Report</b> / <b>Increment Reminders</b>', 'Who is due, and what was given.'],
  ['<b>Loan &amp; Advance Report</b>', 'Outstanding balances and recoveries.'],
  ['<b>Employee Wise Detail Report</b>', 'One person, everything.'],
  ['<b>Overtime Report</b>', 'Overtime minutes by employee.'],
  ['<b>Employee Contact</b> / <b>Insurance</b> / <b>Assets</b> / <b>Birthday</b>', 'Reference lists.'],
], [50*mm, 115*mm]))

A(PageBreak())

# ------------------------------------------------------------------ 9
A(P('9 &nbsp;Generator', 'h1'))
A(P('Where documents are produced rather than calculated.'))
add(table(['Section', 'What it does'], [
  ['<b>Letters</b>', 'Offer, appointment, confirmation, experience, relieving and the rest, on '
   'the company letterhead, filled from the employee record.'],
  ['<b>Checklists</b>', 'Joining and exit checklists, so nothing is missed either end.'],
  ['<b>Payroll Documents (monthly)</b>', 'Where PF, ESI and PT challans and receipts, the wage '
   'register and payslips are filed, by financial year and month. Browse, search and see at a '
   'glance which month is incomplete.'],
  ['<b>Employee Role Reports</b>', 'Role and responsibility profiles by department.'],
  ['<b>Holiday List</b>', 'Generate one, or upload the signed copy.'],
  ['<b>Leave Encashment Report</b>', 'What pending leave is worth.'],
  ['<b>Company Letterhead</b> / <b>R.S. Infotech Profile</b>', 'The letterhead, logo, signatory, '
   'PF and ESI code numbers used across every report.'],
  ['<b>Apprentice Documents</b>', 'Apprentice claim paperwork.'],
  ['<b>Uniform &amp; ID List</b>, <b>Employee Handbook</b>, <b>Important Documents</b>', 'Reference material.'],
  ['<b>CTC Calculator</b>, <b>Rate of Pay Calculator</b>', 'Work backwards from a CTC or a '
   'take-home figure to a Rate of Pay, using the same rules payroll uses.'],
], [50*mm, 115*mm]))

# ------------------------------------------------------------------ 10
A(P('10 &nbsp;Settings', 'h1'))
add(table(['Setting', 'What it is for'], [
  ['<b>1 Expense rate</b>', 'The per-kilometre rate for the engineers\' travel claims.'],
  ['<b>2 Geofence zones</b>', 'The site boundaries live tracking checks against.'],
  ['<b>3 Document storage</b>', 'Moves documents held inside old employee records out to Drive. '
   'Run once if prompted.'],
  ['<b>4 Always mark Present — bulk apply</b>', 'Fills a month as Present for the staff you '
   'choose, so you only edit the exceptions.'],
  ['<b>5 Backend connection</b>', 'Checks this device can actually read and write to the Google '
   'Sheet. The first thing to try when saving fails.'],
  ['<b>6 Employee sequence</b>', 'Gives the whole roster a clean 1, 2, 3 in the order it is '
   'listed now. Individual numbers are then set on each employee\'s own record.'],
], [50*mm, 115*mm]))

A(PageBreak())

# ------------------------------------------------------------------ 11
A(P('11 &nbsp;The automatic emails', 'h1'))
A(P('These send on their own. You do not have to generate them.'))
add(table(['Email', 'When'], [
  ['<b>Daily HR Digest</b>', 'Every day'],
  ['<b>Birthday reminder</b>', 'The day before'],
  ['<b>Salary advance taken</b>', 'The same evening, and only on a day somebody actually took one'],
  ['<b>Report pack</b>', '2nd of the month, for the month just gone'],
  ['<b>Loan and EMI Report</b>', '2nd of the month'],
  ['<b>Monthly Leave Detail Report</b>', '2nd of the month'],
  ['<b>Consultant Report</b>', '2nd of the month'],
  ['<b>Salary advances for last month</b>', '2nd of the month'],
  ['<b>Increments due this month</b>', '2nd of the month'],
], [62*mm, 103*mm]))
A(Paragraph('Attachments are Excel files with the columns already sized. The salary-advance alert '
            'is silent on a day nothing happened, deliberately — a daily "nothing to report" '
            'would train you to stop reading it.', S['cap']))

# ------------------------------------------------------------------ 12
A(P('12 &nbsp;Care and troubleshooting', 'h1'))

A(P('When a figure looks wrong', 'h2'))
add(steps([
  '<b>Check the attendance first.</b> Most surprises on a Salary Sheet are an attendance day, '
  'not a calculation.',
  '<b>Check the Date of Joining and the leaving date.</b> A wrong date prorates a whole month.',
  '<b>Check the salary heading and Rate of Pay</b>, and whether an increment was recorded with '
  'the right effective month.',
  '<b>Check PF and ESI eligibility</b> on the employee record. "Not eligible" means nil, whatever '
  'the wage.',
  '<b>Open the calculation card</b> on the Salary Sheet. It explains, in words, how that person\'s '
  'figure was reached.',
]))

A(P('Comparing against the consultant\'s register', 'h2'))
add(bullets([
  'Open the <b>Consultant Final Summary Report</b> for the month and put his register beside it. '
  'Same column order, so you can read down.',
  '<b>Sort both by name first</b> — his register runs in his order, ours in your sequence order.',
  '<b>Compare his grand total against ours first.</b> If gross, deductions and net all match, '
  'there is nothing to hunt for.',
  '<b>A matching total does not mean the rows match.</b> An amount charged to the wrong person '
  'cancels out in the total. Read down the Net Salary column even when the totals agree.',
]))

A(P('Things worth being careful about', 'h2'))
add(bullets([
  '<b>Never edit Rate of Pay to give an increment.</b> Use Record Increment, so past months keep '
  'the old rate.',
  '<b>Do not enter take-home as Rate of Pay.</b> It is the gross.',
  '<b>Finish the attendance before reading the Salary Sheet.</b> Unmarked past days count as absent.',
  '<b>Every person gets their own login.</b> The Activity Log is only as useful as that.',
  '<b>A policy figure is not the software\'s to change.</b> Percentages, ceilings and leave '
  'allowances come from HR and the PF consultant. If a number looks wrong, ask them before '
  'assuming the system is at fault.',
]))

A(P('If something will not save', 'h2'))
add(steps([
  'Settings → <b>Backend connection</b> → run the check. It tells you whether this device can '
  'reach the Google Sheet.',
  'If the check fails, it is the connection, not your data. Try again on a different network.',
  'If the check passes and saving still fails, note exactly what you were doing and pass it on.',
]))

add(box('Where everything is filed', [
  'Google Drive, under <b>HR Management</b> → the financial year → Dashboard or Reports → the '
  'report name. Every report you generate files a copy there automatically, so a month you have '
  'already run can be retrieved without regenerating it.',
]))

doc.build(st)
print('written:', OUT)
