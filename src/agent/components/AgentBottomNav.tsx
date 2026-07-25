'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { selection } from '@/lib/haptics'

const NAV_ITEMS = [
  { href: '/', label: 'ERP', icon: ErpIcon, matchExact: true },
  { href: '/agent', label: 'Chat', icon: ChatIcon, matchExact: true },
  { href: '/agent/creative-studio', label: 'Studio', icon: StudioIcon },
  { href: '/agent/whatsapp', label: 'WhatsApp', icon: WhatsAppIcon },
  { href: '/agent/phone', label: 'Phone', icon: PhoneIcon },
  { href: '/agent/staff-monitor', label: 'Monitor', icon: MonitorIcon },
  { href: '/agent/costs', label: 'Costs', icon: CostsIcon },
]

export function AgentBottomNav() {
  const pathname = usePathname()

  if (pathname.startsWith('/agent/creative-studio')) {
    return null
  }

  return (
    <nav className="agent-bottom-nav fixed bottom-0 left-0 right-0 z-50 md:hidden">
      <div className="glass-panel absolute inset-0 rounded-none border-x-0 border-b-0 border-t border-white/[0.10]" />

      <div
        className="relative flex items-center justify-around px-4 pt-2"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === '/'
            ? false
            : item.matchExact
              ? pathname === item.href
              : pathname.startsWith(item.href)

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => selection()}
              className={cn(
                'group relative flex flex-col items-center gap-0.5 px-2.5 py-1.5 transition-all',
                isActive ? 'text-[#E07A5F]' : 'text-muted',
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="bottomNavIndicator"
                  className="absolute -top-0.5 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-[#E07A5F]"
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}
              <item.icon className="h-5 w-5 transition-transform duration-150 group-active:scale-[0.82]" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function StudioIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l1.2 2.8L9 7 6.2 8.2 5 11 3.8 8.2 1 7l2.8-1.2z" />
      <path d="M17 11l1.5 3.5L22 16l-3.5 1.5L17 21l-1.5-3.5L12 16l3.5-1.5z" />
    </svg>
  )
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21l1.7-4.2A8 8 0 1 1 12 20a8 8 0 0 1-4.2-1.2z" />
      <path d="M8.5 9.5c0 3 2 5 5 5 .6 0 1.2-.4 1.2-1l-.1-.9c-.1-.5-.7-.7-1.1-.5l-.7.3c-.9-.4-1.6-1.1-2-2l.3-.7c.2-.4 0-1-.5-1.1l-.9-.1c-.6 0-1 .6-1 1.2z" />
    </svg>
  )
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

function CostsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v12M9 9h6M9 15h6" />
    </svg>
  )
}

function ErpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}
