/**
 * Instant first-paint skeleton for the agent route. Shows immediately during the
 * server session check / cold Tokyo round-trip so the app never feels stuck on a
 * blank screen while opening. Pure CSS, no JS, theme-matched (cream).
 */
export default function AgentLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#FAF9F6]">
      {/* Header placeholder */}
      <div className="safe-top safe-x flex shrink-0 items-center gap-3 border-b border-black/[0.06] bg-white px-3 py-2.5 md:px-4">
        <div className="skeleton h-9 w-9 rounded-xl" />
        <div className="mx-auto h-4 w-28 rounded-md bg-black/[0.06]" />
        <div className="skeleton h-9 w-9 rounded-xl" />
      </div>

      {/* Centered orb + greeting placeholder */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <div
          className="h-28 w-28 rounded-full"
          style={{
            background:
              'radial-gradient(circle at 35% 30%, #F6E6DF 0%, #E8B4A0 30%, #E07A5F 60%, #c45a42 90%)',
            opacity: 0.5,
            animation: 'almaPulse 1.6s ease-in-out infinite',
          }}
        />
        <div className="h-3.5 w-40 rounded-md bg-black/[0.05]" />
        <div className="h-3 w-56 rounded-md bg-black/[0.04]" />
      </div>

      {/* Composer placeholder */}
      <div className="safe-x shrink-0 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:px-5 md:pb-5">
        <div className="h-12 w-full rounded-2xl border border-black/[0.08] bg-white" />
      </div>

      <style>{`@keyframes almaPulse{0%,100%{opacity:.4;transform:scale(.96)}50%{opacity:.7;transform:scale(1.02)}}`}</style>
    </div>
  )
}
