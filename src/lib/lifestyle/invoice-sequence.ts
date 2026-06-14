import { prisma } from '@/lib/prisma'

function formatInvoiceNumber(year: number, seq: number): string {
  return `AL-INV-${year}-${String(seq).padStart(4, '0')}`
}

function parseInvoiceSeq(invoiceNumber: string | null | undefined): number {
  if (!invoiceNumber) return 0
  const m = invoiceNumber.match(/^AL-INV-\d{4}-(\d+)$/)
  return m ? parseInt(m[1], 10) : 0
}

async function resolveLastInvoiceNumber(businessId: string, year: number): Promise<number> {
  const [seqRow, maxRecord] = await Promise.all([
    prisma.lifestyleInvoiceSequence.findUnique({
      where: { businessId_year: { businessId, year } },
    }),
    prisma.invoiceRecord.findFirst({
      where: {
        businessId,
        invoiceNumber: { startsWith: `AL-INV-${year}-` },
        deletedAt: null,
      },
      orderBy: { invoiceNumber: 'desc' },
      select: { invoiceNumber: true },
    }),
  ])
  return Math.max(seqRow?.lastNumber ?? 0, parseInvoiceSeq(maxRecord?.invoiceNumber))
}

/** Peek next AL-INV number without consuming it (matches legacy GAS GET behavior). */
export async function peekNextInvoiceNumber(businessId = 'ALMA_LIFESTYLE'): Promise<string> {
  const year = new Date().getFullYear()
  const last = await resolveLastInvoiceNumber(businessId, year)
  return formatInvoiceNumber(year, last + 1)
}

/** Atomically reserve the next invoice number when generating a new invoice. */
export async function reserveNextInvoiceNumber(businessId = 'ALMA_LIFESTYLE'): Promise<string> {
  const year = new Date().getFullYear()
  return prisma.$transaction(async tx => {
    const seqRow = await tx.lifestyleInvoiceSequence.findUnique({
      where: { businessId_year: { businessId, year } },
    })
    const maxRecord = await tx.invoiceRecord.findFirst({
      where: {
        businessId,
        invoiceNumber: { startsWith: `AL-INV-${year}-` },
        deletedAt: null,
      },
      orderBy: { invoiceNumber: 'desc' },
      select: { invoiceNumber: true },
    })
    const last = Math.max(seqRow?.lastNumber ?? 0, parseInvoiceSeq(maxRecord?.invoiceNumber))
    const next = last + 1
    await tx.lifestyleInvoiceSequence.upsert({
      where: { businessId_year: { businessId, year } },
      create: { businessId, year, lastNumber: next },
      update: { lastNumber: next },
    })
    return formatInvoiceNumber(year, next)
  })
}
