'use client'
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts'

const T = { gold:'#C9A84C', goldLt:'#E8C96A', green:'#2ECC71', blue:'#4A9EFF', red:'#E74C3C', amber:'#F5A623', muted:'#6B6B72', border:'#1E1E24', card:'#141418' }

function Tip({ active, payload, label }: Record<string, unknown>) {
  if (!active || !(payload as unknown[])?.length) return null
  return (
    <div className="bg-card border border-border rounded-xl p-3 text-xs shadow-xl">
      <p className="text-zinc-500 mb-2 font-mono">{label as string}</p>
      {(payload as Array<{name:string;value:number;color:string}>).map((p, i) => (
        <p key={i} style={{ color: p.color }} className="font-bold">
          {p.name}: {typeof p.value === 'number' && p.value > 999 ? `৳${Math.round(p.value).toLocaleString('en-IN')}` : p.value}
        </p>
      ))}
    </div>
  )
}

export function RevenueChart({ data }: { data: Array<{ month: string; revenue: number; profit: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={T.gold} stopOpacity={0.3} />
            <stop offset="100%" stopColor={T.gold} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="proGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={T.green} stopOpacity={0.25} />
            <stop offset="100%" stopColor={T.green} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="month" tick={{ fill: T.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: T.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `৳${(v/1000).toFixed(0)}k`} width={44} />
        <Tooltip content={<Tip />} />
        <Area type="monotone" dataKey="revenue" name="Revenue" stroke={T.gold} fill="url(#revGrad)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="profit" name="Profit" stroke={T.green} fill="url(#proGrad)" strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function BarSourceChart({ data }: { data: Array<{ source: string; orders: number; revenue: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }} barSize={10}>
        <XAxis type="number" tick={{ fill: T.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="source" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
        <Tooltip content={<Tip />} />
        <Bar dataKey="orders" name="Orders" fill={T.gold} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function DonutChart({ data }: { data: Array<{ name: string; value: number; color: string }> }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={48} outerRadius={72} paddingAngle={2} dataKey="value">
          {data.map((e, i) => <Cell key={i} fill={e.color} />)}
        </Pie>
        <Tooltip formatter={(v: number) => [`${v}%`, '']} contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

export function ExpenseBarChart({ data }: { data: Array<{ category: string; amount: number; color: string }> }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }} barSize={8}>
        <XAxis type="number" tick={{ fill: T.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `৳${(v/1000).toFixed(0)}k`} />
        <YAxis type="category" dataKey="category" tick={{ fill: T.muted, fontSize: 10 }} axisLine={false} tickLine={false} width={110} />
        <Tooltip content={<Tip />} />
        <Bar dataKey="amount" name="Amount" radius={[0, 4, 4, 0]}>
          {data.map((e, i) => <Cell key={i} fill={e.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function TrendLine({ data, color = '#C9A84C' }: { data: Array<{ value: number }>; color?: string }) {
  return (
    <ResponsiveContainer width="100%" height={48}>
      <LineChart data={data}>
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
