'use client'
import { Card } from '@/components/ui'
import { signedClass } from '@/components/trading/trading-utils'

export function MiniTrendChart({
  title,
  data,
  valueKey,
  color = '#d6a94a',
}: {
  title: string
  data: Array<{ date: string } & Record<string, number | string>>
  valueKey: string
  color?: string
}) {
  const values = data.map(d => Number(d[valueKey] || 0))
  const min = Math.min(0, ...values)
  const max = Math.max(1, ...values)
  const span = max - min || 1
  const points = values.map((v, i) => {
    const x = values.length <= 1 ? 0 : (i / (values.length - 1)) * 100
    const y = 90 - ((v - min) / span) * 80
    return `${x},${y}`
  }).join(' ')
  return (
    <Card className="p-4">
      <p className="mb-3 text-sm font-bold text-cream">{title}</p>
      {values.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-hi">No trend data</p>
      ) : (
        <svg viewBox="0 0 100 100" className="h-36 w-full overflow-visible">
          <line x1="0" x2="100" y1="90" y2="90" stroke="rgba(0,0,0,.06)" strokeWidth="1" />
          <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {values.map((v, i) => {
            const x = values.length <= 1 ? 0 : (i / (values.length - 1)) * 100
            const y = 90 - ((v - min) / span) * 80
            return <circle key={`${i}-${v}`} cx={x} cy={y} r="1.8" fill={color} />
          })}
        </svg>
      )}
    </Card>
  )
}

export function RankingBars({
  title,
  rows,
  valueKey,
  labelKey = 'accountTitle',
  valuePrefix = '',
  valueSuffix = '',
}: {
  title: string
  rows: Array<Record<string, unknown>>
  valueKey: string
  labelKey?: string
  valuePrefix?: string
  valueSuffix?: string
}) {
  const max = Math.max(1, ...rows.map(r => Math.abs(Number(r[valueKey] || 0))))
  return (
    <Card className="p-4">
      <p className="mb-4 text-sm font-bold text-cream">{title}</p>
      {!rows.length ? <p className="py-8 text-center text-xs text-muted-hi">No data</p> : (
        <div className="space-y-3">
          {rows.slice(0, 8).map((row, idx) => {
            const value = Number(row[valueKey] || 0)
            const width = Math.max(4, (Math.abs(value) / max) * 100)
            return (
              <div key={`${String(row[labelKey])}-${idx}`}>
                <div className="mb-1 flex items-center justify-between gap-3 text-[11px]">
                  <span className="truncate font-bold text-cream">{String(row[labelKey] || '—')}</span>
                  <span className={`font-black tabular-nums ${signedClass(value)}`}>{valuePrefix}{value.toLocaleString('en-BD', { maximumFractionDigits: 2 })}{valueSuffix}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-border">
                  <div className={value >= 0 ? 'h-full rounded-full bg-green-400' : 'h-full rounded-full bg-red-400'} style={{ width: `${width}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
