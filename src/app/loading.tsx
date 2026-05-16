export default function Loading() {
  return (
    <div className="min-h-[100dvh] bg-black flex items-center justify-center">
      <div className="rounded-2xl border border-gold-dim/30 bg-card px-5 py-4 shadow-2xl shadow-black/50">
        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">Alma ERP</p>
        <p className="mt-1 text-xs text-zinc-500">Loading secure workspace…</p>
      </div>
    </div>
  )
}
