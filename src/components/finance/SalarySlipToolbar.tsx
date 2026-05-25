'use client'
import { useCallback, useState } from 'react'
import type { SalarySlipModel } from '@/components/pdf/SalarySlipDocument'
import { Button } from '@/components/ui'
import { printPdfBlob } from '@/lib/pdf/print'
import { pdfMoney } from '@/lib/pdf/format'
import { fetchLogoDataUrl } from '@/lib/pdf/branding'
import toast from 'react-hot-toast'

export function SalarySlipToolbar({ model }: { model: SalarySlipModel }) {
  const [busy, setBusy] = useState(false)

  const withPdf = useCallback(
    async (fn: (blob: Blob, fileBase: string) => void | Promise<void>) => {
      setBusy(true)
      try {
        const [{ pdf }, { SalarySlipDocument }] = await Promise.all([
          import('@react-pdf/renderer'),
          import('@/components/pdf/SalarySlipDocument'),
        ])
        const logoDataUrl = await fetchLogoDataUrl(model.logoUrl ?? undefined)
        const blob = await pdf(
          <SalarySlipDocument model={model} branding={{ logoDataUrl }} />,
        ).toBlob()
        const safe = `${model.employee.name || 'salary-slip'}`.replace(/[^\w\s-]/g, '').trim().slice(0, 40)
        await fn(blob, safe)
      } catch {
        toast.error('Could not build PDF — check branding logo URL availability')
      } finally {
        setBusy(false)
      }
    },
    [model],
  )

  return (
    <div className="flex flex-wrap gap-2 justify-end">
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void withPdf(blob => {
            window.open(URL.createObjectURL(blob), '_blank')
          })}
      >
        Preview
      </Button>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void withPdf((blob, base) => {
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${base}-${model.periodLabel}.pdf`
            a.click()
            URL.revokeObjectURL(url)
          })}
      >
        Download
      </Button>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void withPdf(blob => {
            printPdfBlob(blob)
          })}
      >
        Print
      </Button>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          const lines = [
            `Salary slip — ${model.companyName}`,
            `${model.employee.name} (${model.employee.emp_id})`,
            `Period ${model.periodLabel}`,
            `Net pay ${pdfMoney(model.breakdown.netPay)}`,
          ]
          window.open(`https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`, '_blank')
        }}
      >
        WhatsApp
      </Button>
      <Button
        variant="ghost"
        disabled={busy || !model.employee.email}
        onClick={() => {
          const sub = encodeURIComponent(`Salary slip · ${model.periodLabel}`)
          const body = encodeURIComponent(`Dear ${model.employee.name},\n\nPlease find your salary slip summary attached as PDF from Alma ERP.\n\nPeriod: ${model.periodLabel}`)
          window.location.href = `mailto:${model.employee.email}?subject=${sub}&body=${body}`
        }}
      >
        Email
      </Button>
    </div>
  )
}
