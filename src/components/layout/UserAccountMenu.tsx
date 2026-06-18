'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { useActor } from '@/contexts/ActorContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'
import { can } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useMyProfileImage } from '@/hooks/useMyProfileImage'

type UserAccountMenuProps = {
  collapsed?: boolean
  mobile?: boolean
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-gold/25 bg-gold/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-gold">
      {role.replace(/_/g, ' ')}
    </span>
  )
}

export function UserAccountMenu({ collapsed = false, mobile = false }: UserAccountMenuProps) {
  const { data } = useSession()
  const { role } = useActor()
  const { business, businessId, setBusinessId, allowedBusinessIds } = useBusiness()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [businessOpen, setBusinessOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notifications, setNotifications] = useState<Array<{ id: string; title: string; message: string; type: string; readAt: string | null; createdAt: string }>>([])
  const [unread, setUnread] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const { userId, profileImageUrl } = useMyProfileImage()
  const displayName = data?.user?.name || 'Account'
  const email = data?.user?.email || ''
  const businessChoices = BUSINESS_LIST.filter(item => allowedBusinessIds.includes(item.id))
  const canManageTeam = can(role, 'userManage')
  const canOpenAdminSettings = role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'HR'

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      const res = await fetch('/api/notifications', { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!cancelled && res.ok) {
        setNotifications(j.notifications ?? [])
        setUnread(j.unread ?? 0)
      }
    })()
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return

    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setBusinessOpen(false)
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        setBusinessOpen(false)
      }
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    setOpen(false)
    setBusinessOpen(false)
  }, [pathname])

  async function logout() {
    setOpen(false)
    setBusinessOpen(false)
    await signOut({ callbackUrl: '/login' })
  }

  const menu = (
    <motion.div
      id={menuId}
      role="menu"
      initial={{ opacity: 0, y: mobile ? 8 : 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: mobile ? 8 : 10, scale: 0.98 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className={cn(
        'absolute z-[140] w-72 overflow-hidden rounded-2xl border border-border-subtle bg-card/98 shadow-xl shadow-black/10 backdrop-blur-xl',
        mobile ? 'bottom-full right-2 mb-3' : 'bottom-full left-0 mb-3',
      )}
    >
      <div className="border-b border-border-subtle bg-gradient-to-br from-gold/[0.06] to-transparent p-4">
        <div className="flex items-start gap-3">
          <EmployeeAvatar userId={userId} name={displayName} email={email} imageUrl={profileImageUrl} size="md" showStatus className="rounded-2xl" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-cream">{displayName}</p>
            <div className="mt-1"><RoleBadge role={role} /></div>
            <p className="mt-2 truncate font-mono text-[10px] text-muted">{email}</p>
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-border-subtle bg-bg-2 px-3 py-2">
          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-muted">Current business</p>
          <p className="mt-0.5 truncate text-[11px] font-semibold text-cream">{business.name}</p>
        </div>
      </div>

      <div className="p-2">
        <MenuLink href="/portal" label="My profile" detail="Personal desk and payroll snapshot" onSelect={() => setOpen(false)} />
        <MenuLink href="/portal#profile-photo" label="Profile photo" detail="Upload or update your avatar" onSelect={() => setOpen(false)} />
        <MenuLink href="/settings/session#profile-photo" label="Session & Security" detail="Photo, name, diagnostics, password" onSelect={() => setOpen(false)} />

        <button
          type="button"
          role="menuitem"
          onClick={() => setBusinessOpen(value => !value)}
          className="group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-2 focus:outline-none focus:ring-1 focus:ring-gold/30"
        >
          <span>
            <span className="block text-[12px] font-semibold text-cream">Switch business</span>
            <span className="block text-[10px] text-muted">{businessChoices.length} available</span>
          </span>
          <span className={cn('text-xs text-muted transition-transform group-hover:text-gold', businessOpen && 'rotate-180')}>⌄</span>
        </button>

        <AnimatePresence initial={false}>
          {businessOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden px-1 pb-1"
            >
              {businessChoices.map(item => {
                const active = item.id === businessId
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setBusinessId(item.id as BusinessId)
                      setBusinessOpen(false)
                      setOpen(false)
                    }}
                    className={cn(
                      'mt-1 flex w-full items-center gap-2 rounded-xl border px-2 py-2 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-gold/30',
                      active
                        ? 'border-gold/30 bg-gold/10 text-gold'
                        : 'border-transparent text-muted-hi hover:bg-bg-2 hover:text-cream',
                    )}
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border-subtle bg-card text-[10px] font-black text-gold">
                      {item.brandInitial}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{item.name}</span>
                    {active && <span className="text-[10px]">Active</span>}
                  </button>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>

        <button
          type="button"
          role="menuitem"
          onClick={() => setNotificationsOpen(value => !value)}
          className="group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-2 focus:outline-none focus:ring-1 focus:ring-gold/30"
        >
          <span>
            <span className="block text-[12px] font-semibold text-cream">Notifications</span>
            <span className="block text-[10px] text-muted">{unread} unread payroll/system alerts</span>
          </span>
          {unread > 0 && <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold">{unread}</span>}
        </button>
        <AnimatePresence initial={false}>
          {notificationsOpen && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden px-1 pb-1">
              {!notifications.length ? (
                <p className="px-3 py-2 text-[10px] text-muted">No notifications yet.</p>
              ) : notifications.slice(0, 5).map(n => (
                <div key={n.id} className="mt-1 rounded-xl border border-border-subtle bg-bg-2 px-3 py-2">
                  <p className="text-[11px] font-semibold text-cream">{n.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-[10px] text-muted">{n.message}</p>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <MenuLink
          href="/settings/users"
          label="Manage team"
          detail={canManageTeam ? 'Users, roles, passwords' : 'Admin access required'}
          disabled={!canManageTeam}
          onSelect={() => setOpen(false)}
        />
        <MenuLink
          href="/settings/notifications"
          label="Notification admin"
          detail={canManageTeam ? 'Broadcasts and delivery analytics' : 'Admin access required'}
          disabled={!canManageTeam}
          onSelect={() => setOpen(false)}
        />
        <MenuLink
          href="/settings/database"
          label="Admin settings"
          detail={canOpenAdminSettings ? 'Database and system health' : 'Admin access required'}
          disabled={!canOpenAdminSettings}
          onSelect={() => setOpen(false)}
        />
      </div>

      <div className="border-t border-border-subtle p-2">
        <button
          type="button"
          role="menuitem"
          onClick={() => void logout()}
          className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[12px] font-semibold text-danger transition-colors hover:bg-danger/10 focus:outline-none focus:ring-1 focus:ring-danger/40"
        >
          <span>Logout</span>
          <span className="text-[10px] text-danger/70">Clear session</span>
        </button>
      </div>
    </motion.div>
  )

  return (
    <div ref={rootRef} className={cn('relative', mobile ? 'w-full' : 'mx-2')}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(
          'group flex w-full items-center gap-3 rounded-2xl border border-border-subtle bg-card p-2 text-left transition-all duration-200 hover:border-gold/30 hover:bg-gold/[0.04] focus:outline-none focus:ring-1 focus:ring-gold/30',
          collapsed && !mobile && 'justify-center px-2',
          mobile && 'justify-center border-transparent bg-transparent p-0 hover:bg-transparent',
        )}
      >
        <EmployeeAvatar userId={userId} name={displayName} email={email} imageUrl={profileImageUrl} size="md" showStatus className="rounded-2xl" />
        {!collapsed && !mobile && (
          <span className="min-w-0 flex-1 overflow-hidden">
            <span className="block truncate text-[12px] font-bold text-cream">{displayName}</span>
            <span className="mt-0.5 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              <span className="truncate text-[10px] font-medium text-muted">{role.replace(/_/g, ' ')}</span>
            </span>
          </span>
        )}
        {!collapsed && !mobile && <span className="text-xs text-muted transition-colors group-hover:text-gold">⌄</span>}
      </button>

      <AnimatePresence>{open && menu}</AnimatePresence>
    </div>
  )
}

function MenuLink({
  href,
  label,
  detail,
  disabled,
  onSelect,
}: {
  href: string
  label: string
  detail: string
  disabled?: boolean
  onSelect: () => void
}) {
  if (disabled) {
    return <MenuButton label={label} detail={detail} disabled />
  }
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onSelect}
      className="block rounded-xl px-3 py-2.5 transition-colors hover:bg-bg-2 focus:outline-none focus:ring-1 focus:ring-gold/30"
    >
      <span className="block text-[12px] font-semibold text-cream">{label}</span>
      <span className="block text-[10px] text-muted">{detail}</span>
    </Link>
  )
}

function MenuButton({
  label,
  detail,
  disabled,
}: {
  label: string
  detail: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className="block w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="block text-[12px] font-semibold text-cream">{label}</span>
      <span className="block text-[10px] text-muted">{detail}</span>
    </button>
  )
}
