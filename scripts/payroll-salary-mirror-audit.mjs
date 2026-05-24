/**
 * Audit (and optionally correct) WITHDRAWAL ledger rows that may have been
 * intended as salary credits via legacy "salary_payment" mirror.
 *
 * List candidates (default):
 *   node --env-file=.env scripts/payroll-salary-mirror-audit.mjs
 *
 * Apply EMP-51-style correction (manual supervision — requires --confirm):
 *   node --env-file=.env scripts/payroll-salary-mirror-audit.mjs \
 *     --apply-emp EMP-51 --business-id ALMA_LIFESTYLE \
 *     --amount 20000 --period-ym 2026-05 --confirm
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const NOTE_NEEDLES = ['salary', 'maine', 'bonus']

function parseArgs(argv) {
  const out = {
    applyEmp: '',
    businessId: process.env.PAYROLL_AUDIT_BUSINESS_ID || 'ALMA_LIFESTYLE',
    amount: 0,
    periodYm: '',
    confirm: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply-emp') out.applyEmp = String(argv[++i] || '').trim()
    else if (a === '--business-id') out.businessId = String(argv[++i] || '').trim()
    else if (a === '--amount') out.amount = Number(argv[++i] || 0)
    else if (a === '--period-ym') out.periodYm = String(argv[++i] || '').trim()
    else if (a === '--confirm') out.confirm = true
  }
  return out
}

async function listCandidates() {
  const rows = await p.employeeLedgerEntry.findMany({
    where: {
      type: 'WITHDRAWAL',
      isArchived: false,
      OR: [
        { source: 'legacy_hr_payroll' },
        { source: 'legacy_payroll_mirror' },
      ],
      AND: [
        {
          OR: NOTE_NEEDLES.map(needle => ({
            note: { contains: needle, mode: 'insensitive' },
          })),
        },
      ],
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      employeeId: true,
      businessId: true,
      date: true,
      amount: true,
      note: true,
      source: true,
      sourceRef: true,
      createdAt: true,
    },
  })

  const users = await p.user.findMany({
    where: { employeeIdGas: { in: [...new Set(rows.map(r => r.employeeId))] } },
    select: { employeeIdGas: true, name: true, email: true },
  })
  const nameByEmp = new Map(users.map(u => [u.employeeIdGas, u.name]))

  const candidates = rows.map(r => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeName: nameByEmp.get(r.employeeId) || '(no linked user)',
    businessId: r.businessId,
    amount: Number(r.amount || 0),
    date: r.date.toISOString().slice(0, 10),
    note: r.note,
    source: r.source,
    sourceRef: r.sourceRef,
    createdAt: r.createdAt.toISOString(),
  }))

  console.log(JSON.stringify({ mode: 'list', count: candidates.length, candidates }, null, 2))
  console.error(
    '\nReview candidates above. Do NOT auto-fix. To apply EMP correction:\n' +
      '  node --env-file=.env scripts/payroll-salary-mirror-audit.mjs \\\n' +
      '    --apply-emp EMP-51 --business-id ALMA_LIFESTYLE --amount 20000 --period-ym 2026-05 --confirm\n',
  )
}

async function applyCorrection(args) {
  if (!args.applyEmp) {
    console.error('--apply-emp required for correction mode')
    process.exit(1)
  }
  if (!args.confirm) {
    console.error('Refusing to write without --confirm (supervised run only)')
    process.exit(1)
  }
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    console.error('--amount must be a positive number')
    process.exit(1)
  }

  const adjustment = await p.employeeLedgerEntry.create({
    data: {
      employeeId: args.applyEmp,
      businessId: args.businessId,
      date: new Date(),
      type: 'ADJUSTMENT',
      amount: args.amount,
      note: 'Correction: reclassify wrong WITHDRAWAL to salary',
      source: 'payroll_salary_mirror_audit',
      sourceRef: `correction-adjust:${args.businessId}:${args.applyEmp}:${Date.now()}`,
      createdById: null,
      approvedById: null,
    },
  })

  const accrual = await p.employeeLedgerEntry.create({
    data: {
      employeeId: args.applyEmp,
      businessId: args.businessId,
      date: new Date(),
      periodYm: args.periodYm || null,
      type: 'SALARY_ACCRUAL',
      amount: args.amount,
      note: args.periodYm ? `Salary of ${args.periodYm}` : 'Salary credit (manual correction)',
      source: 'payroll_salary_mirror_audit',
      sourceRef: `correction-accrual:${args.businessId}:${args.applyEmp}:${args.periodYm || 'na'}:${Date.now()}`,
      createdById: null,
      approvedById: null,
    },
  })

  console.log(
    JSON.stringify(
      {
        mode: 'apply',
        employeeId: args.applyEmp,
        businessId: args.businessId,
        amount: args.amount,
        periodYm: args.periodYm || null,
        created: [
          { id: adjustment.id, type: adjustment.type, amount: Number(adjustment.amount) },
          { id: accrual.id, type: accrual.type, amount: Number(accrual.amount) },
        ],
      },
      null,
      2,
    ),
  )
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.applyEmp) {
    await applyCorrection(args)
  } else {
    await listCandidates()
  }
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => p.$disconnect())
