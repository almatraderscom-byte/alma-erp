'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import toast from 'react-hot-toast'
import { Button, Card, Empty, Skeleton } from '@/components/ui'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { TradingTelegramLiveFeed } from '@/components/trading/TradingTelegramLiveFeed'
import { TelegramAliasesTab, TelegramUsersTab } from '@/components/trading/TradingTelegramMappingTabs'
import { TradingTelegramChatsTab } from '@/components/trading/TradingTelegramChatsTab'
import {
  accountToSearchableOptions,
  aliasByAccountIdFromRows,
  resolveDefaultAlias,
  staffToSearchableOptions,
  type AccountOptionSource,
  type StaffOptionSource,
} from '@/lib/telegram-mapping-options'
import { TradingTelegramMonitorTab } from '@/components/trading/TradingTelegramMonitorTab'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { PLATFORM_Z } from '@/lib/platform-z-index'
import type {
  TradingAccountAliasRow,
  TradingTelegramChatRow,
  TradingTelegramDraftDayGroup,
  TradingTelegramDraftGroup,
  TradingTelegramDraftRow,
  TradingTelegramDraftStatus,
  TradingTelegramUserRow,
} from '@/types/trading-telegram'

type Tab = 'drafts' | 'monitor' | 'live' | 'users' | 'aliases' | 'chats' | 'setup'

export function TradingTelegramAdmin({
  userId,
  isAdmin,
  isSuperAdmin,
  canReviewDrafts,
}: {
  userId: string
  isAdmin: boolean
  isSuperAdmin: boolean
  canReviewDrafts: boolean
}) {
  const isStaffView = canReviewDrafts && !isAdmin
  const [tab, setTab] = useState<Tab>('drafts')
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<TradingTelegramDraftRow[]>([])
  const [draftGroups, setDraftGroups] = useState<TradingTelegramDraftGroup[]>([])
  const [draftDayGroups, setDraftDayGroups] = useState<TradingTelegramDraftDayGroup[]>([])
  const [users, setUsers] = useState<TradingTelegramUserRow[]>([])
  const [aliases, setAliases] = useState<TradingAccountAliasRow[]>([])
  const [chats, setChats] = useState<TradingTelegramChatRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editId, setEditId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({
    tradeType: 'BUY' as 'BUY' | 'SELL',
    usdtAmount: '',
    bdtRate: '',
    feeUsdt: '',
    tradingAccountId: '',
  })
  const [setupInfo, setSetupInfo] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draftStatus, setDraftStatus] = useState<TradingTelegramDraftStatus | 'ALL'>('PENDING')
  const [filterUserId, setFilterUserId] = useState('')
  const [filterAccountId, setFilterAccountId] = useState('')
  const [duplicateOnly, setDuplicateOnly] = useState(false)
  const [staffList, setStaffList] = useState<StaffOptionSource[]>([])
  const [accountList, setAccountList] = useState<AccountOptionSource[]>([])
  const [mappingLoading, setMappingLoading] = useState(false)
  const [savingUser, setSavingUser] = useState(false)
  const [savingAlias, setSavingAlias] = useState(false)
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)

  const [newAlias, setNewAlias] = useState({ alias: '', tradingAccountId: '' })
  const [newChat, setNewChat] = useState({ chatId: '', title: '' })
  const [newUser, setNewUser] = useState({
    telegramUserId: '',
    userId: '',
    telegramUsername: '',
    defaultAccountAlias: '',
    defaultTradingAccountId: '',
  })

  const pendingCount = useMemo(() => drafts.filter(d => d.status === 'PENDING').length, [drafts])

  const load = useCallback(async () => {
    if (!canReviewDrafts) return
    setLoading(true)
    setError(null)
    try {
      const draftQs = new URLSearchParams({
        status: draftStatus,
        limit: '100',
      })
      if (isStaffView) {
        draftQs.set('byDay', '1')
      } else {
        draftQs.set('grouped', '1')
        if (filterUserId) draftQs.set('userId', filterUserId)
      }
      if (filterAccountId) draftQs.set('tradingAccountId', filterAccountId)
      if (duplicateOnly) draftQs.set('duplicateOnly', '1')

      setMappingLoading(true)
      const draftRes = await fetch(`/api/trading/telegram/drafts?${draftQs}`).then(r => r.json())
      if (draftRes.error) throw new Error(draftRes.error)

      setDrafts(draftRes.drafts ?? [])
      setDraftGroups(draftRes.groups ?? [])
      setDraftDayGroups(draftRes.dayGroups ?? [])

      if (isAdmin) {
        const [u, a, c, s, staffRes, accountsRes] = await Promise.all([
          fetch('/api/trading/telegram/users').then(r => r.json()),
          fetch('/api/trading/telegram/aliases').then(r => r.json()),
          fetch('/api/trading/telegram/chats').then(r => r.json()),
          fetch('/api/trading/telegram/setup').then(r => r.json()),
          fetch('/api/trading/staff').then(r => r.json()),
          fetch('/api/trading/accounts?status=ACTIVE').then(r => r.json()),
        ])
        setUsers(u.users ?? [])
        setAliases(a.aliases ?? [])
        setChats(c.chats ?? [])
        setSetupInfo(s)
        setStaffList(staffRes.staff ?? [])
        setAccountList(
          (accountsRes.accounts ?? []).map((acc: AccountOptionSource & { assignedUser?: { name: string } | null }) => ({
            id: acc.id,
            accountTitle: acc.accountTitle,
            assignedUser: acc.assignedUser,
          })),
        )
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
      setMappingLoading(false)
    }
  }, [canReviewDrafts, isStaffView, isAdmin, draftStatus, filterUserId, filterAccountId, duplicateOnly])

  useEffect(() => { void load() }, [load])

  useRegisterMobileRefresh(load, canReviewDrafts)

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllPending() {
    setSelected(new Set(drafts.filter(d => d.status === 'PENDING' || d.status === 'LOCKED').map(d => d.id)))
  }

  async function approveDraft(id: string) {
    setBusy(true)
    const res = await fetch(`/api/trading/telegram/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    })
    setBusy(false)
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error || 'Confirm failed')
      return
    }
    toast.success('Trade confirmed to ledger')
    void load()
  }

  async function requestDeleteDraft(id: string) {
    const reason = window.prompt('Reason for delete request?')?.trim()
    if (!reason) return
    setBusy(true)
    const res = await fetch(`/api/trading/telegram/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request_delete', deleteReason: reason }),
    })
    setBusy(false)
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error || 'Delete request failed')
      return
    }
    toast.success('Delete request sent to admin for approval')
    void load()
  }

  async function bulkReject() {
    if (!selected.size) return
    const reason = window.prompt('Bulk reject reason?') || 'Rejected'
    setBusy(true)
    const res = await fetch('/api/trading/telegram/drafts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftIds: [...selected], action: 'reject', reason }),
    })
    setBusy(false)
    const data = await res.json()
    if (!res.ok) {
      alert(data.error || 'Bulk reject failed')
      return
    }
    alert(`Rejected ${data.rejected} draft(s). Failed: ${data.failed}`)
    setSelected(new Set())
    void load()
  }

  async function reopenDraft(id: string) {
    setBusy(true)
    const res = await fetch(`/api/trading/telegram/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reopen' }),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Reopen failed')
      return
    }
    void load()
  }

  async function bulkConfirm() {
    if (!selected.size) return
    if (!window.confirm(`Post ${selected.size} draft(s) to the ledger? This updates balances and P/L.`)) return
    setBusy(true)
    const res = await fetch('/api/trading/telegram/drafts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftIds: [...selected] }),
    })
    setBusy(false)
    const data = await res.json()
    if (!res.ok) {
      alert(data.error || 'Bulk confirm failed')
      return
    }
    alert(`Posted ${data.posted} trade(s). Failed: ${data.failed}`)
    setSelected(new Set())
    void load()
  }

  async function rejectDraft(id: string) {
    const reason = window.prompt('Reject reason?') || 'Rejected'
    setBusy(true)
    const res = await fetch(`/api/trading/telegram/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', reason }),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Reject failed')
      return
    }
    void load()
  }

  function openEdit(d: TradingTelegramDraftRow) {
    setEditId(d.id)
    setEditForm({
      tradeType: (d.tradeType as 'BUY' | 'SELL') || 'BUY',
      usdtAmount: String(d.usdtAmount ?? ''),
      bdtRate: String(d.bdtRate ?? ''),
      feeUsdt: String(d.feeUsdt ?? ''),
      tradingAccountId: d.tradingAccountId || '',
    })
  }

  async function saveEdit() {
    if (!editId) return
    setBusy(true)
    const res = await fetch(`/api/trading/telegram/drafts/${editId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'edit',
        tradeType: editForm.tradeType,
        usdtAmount: Number(editForm.usdtAmount),
        bdtRate: Number(editForm.bdtRate),
        feeUsdt: Number(editForm.feeUsdt),
        tradingAccountId: editForm.tradingAccountId || undefined,
      }),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Save failed')
      return
    }
    setEditId(null)
    void load()
  }

  async function registerWebhook() {
    setBusy(true)
    const res = await fetch('/api/trading/telegram/setup', { method: 'POST' })
    setBusy(false)
    const data = await res.json()
    if (!res.ok) {
      alert(data.error || 'Webhook registration failed')
      return
    }
    alert('Webhook registered successfully')
    void load()
  }

  async function saveAlias(e: React.FormEvent) {
    e.preventDefault()
    const alias = newAlias.alias.trim().toLowerCase()
    if (!alias || !/^[a-z0-9_-]{1,16}$/.test(alias)) {
      toast.error('Alias must be 1–16 characters (a-z, 0-9, _, -)')
      return
    }
    if (!newAlias.tradingAccountId) {
      toast.error('Select a trading account')
      return
    }
    const duplicate = aliases.some(
      a => a.active && a.alias === alias && a.tradingAccountId !== newAlias.tradingAccountId,
    )
    if (duplicate) {
      toast.error(`Alias "${alias}" is already used for another account`)
      return
    }
    setSavingAlias(true)
    try {
      const res = await fetch('/api/trading/telegram/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, tradingAccountId: newAlias.tradingAccountId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Could not save alias')
        return
      }
      toast.success('Account alias saved')
      setNewAlias({ alias: '', tradingAccountId: '' })
      void load()
    } finally {
      setSavingAlias(false)
    }
  }

  async function removeUser(u: TradingTelegramUserRow) {
    const label = u.user?.name?.trim() || u.telegramUsername?.trim() || `ID ${u.telegramUserId}`
    if (!window.confirm(`Unlink Telegram user ${label} from the ERP staff mapping?\n\nThis clears the link (userId + approved + default account) but preserves the row, drafts, and history. You can re-link later from this page.`)) {
      return
    }
    setRemovingUserId(u.id)
    try {
      const res = await fetch(`/api/trading/telegram/users/${u.id}`, { method: 'DELETE' })
      let payload: { ok?: boolean; idempotentReplay?: boolean; error?: string; data?: { ok?: boolean; idempotentReplay?: boolean } } = {}
      try { payload = (await res.json()) as typeof payload } catch { /* tolerate empty body */ }
      const inner = payload.data || payload
      if (!res.ok || !inner.ok) {
        toast.error(payload.error || 'Could not remove Telegram mapping')
        return
      }
      toast.success(inner.idempotentReplay ? 'Telegram mapping was already removed' : `Telegram mapping removed for ${label}`)
      await load()
    } catch (err) {
      toast.error((err as Error)?.message || 'Could not remove Telegram mapping')
    } finally {
      setRemovingUserId(null)
    }
  }

  async function saveUser(e: React.FormEvent) {
    e.preventDefault()
    const telegramUserId = newUser.telegramUserId.trim()
    if (!/^\d+$/.test(telegramUserId)) {
      toast.error('Telegram user ID must be numeric. Use @userinfobot in Telegram.')
      return
    }
    if (!newUser.userId) {
      toast.error('Select an ERP staff member')
      return
    }
    const existing = users.find(u => u.telegramUserId === telegramUserId)
    if (existing && existing.userId && existing.userId !== newUser.userId) {
      toast.error(`Telegram ID already linked to ${existing.user?.name ?? 'another staff member'}. Saving will reassign.`)
    }
    setSavingUser(true)
    try {
      const res = await fetch('/api/trading/telegram/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId,
          telegramUsername: newUser.telegramUsername.trim() || undefined,
          userId: newUser.userId,
          defaultTradingAccountId: newUser.defaultTradingAccountId || undefined,
          defaultAccountAlias: newUser.defaultAccountAlias || undefined,
          approved: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Could not save Telegram mapping')
        return
      }
      toast.success(existing ? 'Telegram mapping updated' : 'Telegram user linked and approved')
      setNewUser({
        telegramUserId: '',
        userId: '',
        telegramUsername: '',
        defaultAccountAlias: '',
        defaultTradingAccountId: '',
      })
      void load()
    } finally {
      setSavingUser(false)
    }
  }

  const aliasByAccountId = useMemo(() => aliasByAccountIdFromRows(aliases), [aliases])
  const staffOptions = useMemo(() => staffToSearchableOptions(staffList), [staffList])
  const accountOptions = useMemo(
    () => accountToSearchableOptions(accountList, aliasByAccountId),
    [accountList, aliasByAccountId],
  )

  if (!canReviewDrafts) {
    return <Empty icon="✉" title="Trading access required" desc="Your role cannot review Telegram drafts." />
  }

  const tabs: { id: Tab; label: string; badge?: number }[] = isStaffView
    ? [{ id: 'drafts', label: 'My Drafts', badge: pendingCount }]
    : [
        { id: 'drafts', label: 'All Drafts', badge: pendingCount },
        { id: 'monitor', label: 'Monitor' },
        ...(isSuperAdmin ? [{ id: 'live' as Tab, label: 'Live Feed' }] : []),
        { id: 'users', label: 'Users' },
        { id: 'aliases', label: 'Aliases' },
        { id: 'chats', label: 'Groups' },
        { id: 'setup', label: 'Webhook' },
      ]

  return (
    <TelegramAdminInner
      tabs={tabs}
      tab={tab}
      setTab={setTab}
      loading={loading}
      error={error}
      busy={busy}
      drafts={drafts}
      draftGroups={draftGroups}
      users={users}
      aliases={aliases}
      chats={chats}
      setupInfo={setupInfo}
      selected={selected}
      toggleSelect={toggleSelect}
      selectAllPending={selectAllPending}
      bulkConfirm={bulkConfirm}
      bulkReject={bulkReject}
      reopenDraft={reopenDraft}
      requestDeleteDraft={requestDeleteDraft}
      draftStatus={draftStatus}
      setDraftStatus={setDraftStatus}
      filterUserId={filterUserId}
      setFilterUserId={setFilterUserId}
      filterAccountId={filterAccountId}
      setFilterAccountId={setFilterAccountId}
      duplicateOnly={duplicateOnly}
      setDuplicateOnly={setDuplicateOnly}
      isAdmin={isAdmin}
      isSuperAdmin={isSuperAdmin}
      isStaffView={isStaffView}
      userId={userId}
      draftDayGroups={draftDayGroups}
      approveDraft={approveDraft}
      rejectDraft={rejectDraft}
      openEdit={openEdit}
      editId={editId}
      editForm={editForm}
      setEditForm={setEditForm}
      saveEdit={saveEdit}
      setEditId={setEditId}
      registerWebhook={registerWebhook}
      newAlias={newAlias}
      setNewAlias={setNewAlias}
      saveAlias={saveAlias}
      newChat={newChat}
      setNewChat={setNewChat}
      onReload={load}
      newUser={newUser}
      setNewUser={setNewUser}
      saveUser={saveUser}
      removeUser={removeUser}
      removingUserId={removingUserId}
      staffOptions={staffOptions}
      accountOptions={accountOptions}
      aliasByAccountId={aliasByAccountId}
      mappingLoading={mappingLoading}
      savingUser={savingUser}
      savingAlias={savingAlias}
    />
  )
}

function TelegramAdminInner(props: Record<string, unknown>) {
  const {
    tabs,
    tab,
    setTab,
    loading,
    error,
    busy,
    drafts,
    draftGroups,
    selected,
    toggleSelect,
    selectAllPending,
    bulkConfirm,
    bulkReject,
    reopenDraft,
    draftStatus,
    setDraftStatus,
    filterUserId,
    setFilterUserId,
    filterAccountId,
    setFilterAccountId,
    duplicateOnly,
    setDuplicateOnly,
    isAdmin,
    isSuperAdmin,
    isStaffView,
    userId,
    draftDayGroups,
    approveDraft,
    rejectDraft,
    requestDeleteDraft,
    openEdit,
    editId,
    editForm,
    setEditForm,
    saveEdit,
    setEditId,
    registerWebhook,
    setupInfo,
    newAlias,
    setNewAlias,
    saveAlias,
    newChat,
    setNewChat,
    onReload,
    newUser,
    setNewUser,
    saveUser,
    removeUser,
    removingUserId,
    staffOptions,
    accountOptions,
    aliasByAccountId,
    mappingLoading,
    savingUser,
    savingAlias,
    users,
    aliases,
    chats,
  } = props as {
    tabs: { id: Tab; label: string; badge?: number }[]
    tab: Tab
    setTab: (t: Tab) => void
    loading: boolean
    error: string | null
    busy: boolean
    drafts: TradingTelegramDraftRow[]
    draftGroups: TradingTelegramDraftGroup[]
    selected: Set<string>
    toggleSelect: (id: string) => void
    selectAllPending: () => void
    bulkConfirm: () => void
    bulkReject: () => void
    reopenDraft: (id: string) => void
    draftStatus: TradingTelegramDraftStatus | 'ALL'
    setDraftStatus: (v: TradingTelegramDraftStatus | 'ALL') => void
    filterUserId: string
    setFilterUserId: (v: string) => void
    filterAccountId: string
    setFilterAccountId: (v: string) => void
    duplicateOnly: boolean
    setDuplicateOnly: (v: boolean) => void
    isAdmin: boolean
    isSuperAdmin: boolean
    isStaffView: boolean
    userId: string
    draftDayGroups: TradingTelegramDraftDayGroup[]
    approveDraft: (id: string) => void
    rejectDraft: (id: string) => void
    requestDeleteDraft: (id: string) => void
    openEdit: (d: TradingTelegramDraftRow) => void
    editId: string | null
    editForm: { tradeType: 'BUY' | 'SELL'; usdtAmount: string; bdtRate: string; feeUsdt: string; tradingAccountId: string }
    setEditForm: (v: typeof editForm) => void
    saveEdit: () => void
    setEditId: (v: string | null) => void
    registerWebhook: () => void
    setupInfo: Record<string, unknown> | null
    newAlias: { alias: string; tradingAccountId: string }
    setNewAlias: (v: { alias: string; tradingAccountId: string }) => void
    saveAlias: (e: React.FormEvent) => void
    newChat: { chatId: string; title: string }
    setNewChat: (v: { chatId: string; title: string }) => void
    onReload: () => void
    newUser: { telegramUserId: string; userId: string; telegramUsername: string; defaultAccountAlias: string; defaultTradingAccountId: string }
    setNewUser: (v: typeof newUser) => void
    saveUser: (e: React.FormEvent) => void
    removeUser: (u: TradingTelegramUserRow) => void
    removingUserId: string | null
    staffOptions: ReturnType<typeof staffToSearchableOptions>
    accountOptions: ReturnType<typeof accountToSearchableOptions>
    aliasByAccountId: Map<string, string>
    mappingLoading: boolean
    savingUser: boolean
    savingAlias: boolean
    users: TradingTelegramUserRow[]
    aliases: TradingAccountAliasRow[]
    chats: TradingTelegramChatRow[]
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-xl px-3 py-2 text-xs font-bold ${tab === item.id ? 'bg-gold/20 text-gold-lt' : 'bg-black/30 text-zinc-400'}`}
          >
            {item.label}
            {item.badge ? ` (${item.badge})` : ''}
          </button>
        ))}
      </div>

      {error && <p className="mb-4 text-sm text-red-300">{String(error)}</p>}
      {loading && <Skeleton className="mb-4 h-40 w-full" />}

      {!loading && tab === 'monitor' && isAdmin && (
        <TradingTelegramMonitorTab isSuperAdmin={isSuperAdmin} />
      )}

      {!loading && tab === 'drafts' && (
        <div className="space-y-3">
          <Card className="border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-100/90">
            {isStaffView ? (
              <>
                <strong className="text-cream">Your drafts only.</strong> Confirm when ready — balances and P/L update
                only after you press Confirm. No super-admin approval needed for normal trades.
              </>
            ) : (
              <>
                Staff confirm their own drafts. You monitor operations, approve deletes, and audit risk — not daily
                data entry. Drafts never change balances until confirmed.
              </>
            )}
          </Card>
          <DraftFiltersBar
            isStaffView={isStaffView}
            users={users}
            aliases={aliases}
            draftStatus={draftStatus}
            setDraftStatus={setDraftStatus}
            filterUserId={filterUserId}
            setFilterUserId={setFilterUserId}
            filterAccountId={filterAccountId}
            setFilterAccountId={setFilterAccountId}
            duplicateOnly={duplicateOnly}
            setDuplicateOnly={setDuplicateOnly}
          />
          <DraftToolbar
            selected={selected}
            busy={busy}
            selectAllPending={selectAllPending}
            bulkConfirm={bulkConfirm}
            bulkReject={bulkReject}
          />
          {!drafts.length ? (
            <Empty icon="✉" title={isStaffView ? 'No drafts in this view' : 'No Telegram drafts'} />
          ) : isStaffView && draftDayGroups.length ? (
            draftDayGroups.map(dayGroup => (
              <Card key={`${dayGroup.key.ymd}:${dayGroup.key.tradingAccountId}`} className="p-4">
                <div className="mb-3 border-b border-white/10 pb-2">
                  <p className="text-sm font-black text-cream">{dayGroup.key.ymd}</p>
                  <p className="text-xs text-zinc-400">
                    Account: {dayGroup.key.accountTitle || dayGroup.key.accountAlias || '—'}
                    {dayGroup.key.accountAlias && dayGroup.key.accountTitle ? ` (${dayGroup.key.accountAlias})` : ''}
                  </p>
                  <p className="text-[10px] text-zinc-500">{dayGroup.drafts.length} draft(s)</p>
                </div>
                <div className="space-y-3">
                  {dayGroup.drafts.map(d => (
                    <div key={d.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
                      <DraftRow
                        d={d}
                        isStaffView={isStaffView}
                        selected={selected.has(d.id)}
                        onToggle={() => toggleSelect(d.id)}
                        onApprove={() => approveDraft(d.id)}
                        onReject={() => rejectDraft(d.id)}
                        onEdit={() => openEdit(d)}
                        onReopen={() => reopenDraft(d.id)}
                        onRequestDelete={() => requestDeleteDraft(d.id)}
                        busy={busy}
                      />
                    </div>
                  ))}
                </div>
              </Card>
            ))
          ) : !draftGroups.length ? (
            drafts.map(d => (
              <Card key={d.id} className="p-4">
                <DraftRow
                  d={d}
                  isStaffView={isStaffView}
                  selected={selected.has(d.id)}
                  onToggle={() => toggleSelect(d.id)}
                  onApprove={() => approveDraft(d.id)}
                  onReject={() => rejectDraft(d.id)}
                  onEdit={() => openEdit(d)}
                  onReopen={() => reopenDraft(d.id)}
                  onRequestDelete={() => requestDeleteDraft(d.id)}
                  busy={busy}
                />
              </Card>
            ))
          ) : (
            draftGroups.map(group => (
              <Card key={`${group.key.userId}:${group.key.tradingAccountId}:${group.key.telegramUserId}`} className="p-4">
                <div className="mb-3 flex items-center gap-3 border-b border-white/10 pb-2">
                  <EmployeeAvatar
                    userId={group.key.userId}
                    name={group.key.userName}
                    imageUrl={group.key.profileImageUrl}
                    size="md"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-black text-cream">{group.key.userName}</p>
                    <p className="text-xs text-zinc-400">
                      Telegram @{group.key.telegramUsername || group.key.telegramUserId}
                      {' · '}
                      Account: {group.key.accountTitle || group.key.accountAlias || '—'}
                      {group.key.accountAlias && group.key.accountTitle ? ` (${group.key.accountAlias})` : ''}
                    </p>
                    <p className="text-[10px] text-zinc-500">{group.drafts.length} pending draft(s)</p>
                  </div>
                </div>
                <div className="space-y-3">
                  {group.drafts.map(d => (
                    <div key={d.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
                      <DraftRow
                        d={d}
                        isStaffView={isStaffView}
                        selected={selected.has(d.id)}
                        onToggle={() => toggleSelect(d.id)}
                        onApprove={() => approveDraft(d.id)}
                        onReject={() => rejectDraft(d.id)}
                        onEdit={() => openEdit(d)}
                        onReopen={() => reopenDraft(d.id)}
                        onRequestDelete={() => requestDeleteDraft(d.id)}
                        busy={busy}
                      />
                    </div>
                  ))}
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {!loading && tab === 'live' && isSuperAdmin && <TradingTelegramLiveFeed />}

      {!loading && tab === 'setup' && (
        <Card className="space-y-3 p-4 text-sm">
          <p className="font-black text-cream">Production webhook</p>
          <p className="text-xs text-zinc-500">
            Set <code className="text-gold-lt">TELEGRAM_BOT_TOKEN</code> and <code className="text-gold-lt">TELEGRAM_WEBHOOK_SECRET</code> in Vercel env (never commit tokens).
          </p>
          <pre className="max-h-40 overflow-auto rounded-xl bg-black/40 p-3 text-[10px] text-zinc-400">
            {JSON.stringify(setupInfo, null, 2)}
          </pre>
          <Button variant="gold" disabled={busy} onClick={() => void registerWebhook()}>
            Register webhook with Telegram
          </Button>
        </Card>
      )}

      {!loading && tab === 'users' && (
        <TelegramUsersTab
          users={users}
          newUser={newUser}
          setNewUser={setNewUser}
          saveUser={saveUser}
          staffOptions={staffOptions}
          accountOptions={accountOptions}
          aliasByAccountId={aliasByAccountId}
          mappingLoading={mappingLoading}
          savingUser={savingUser}
          onRemove={removeUser}
          removingId={removingUserId}
          canRemove={isSuperAdmin}
        />
      )}

      {!loading && tab === 'aliases' && (
        <TelegramAliasesTab
          aliases={aliases}
          newAlias={newAlias}
          setNewAlias={setNewAlias}
          saveAlias={saveAlias}
          accountOptions={accountOptions}
          mappingLoading={mappingLoading}
          savingAlias={savingAlias}
        />
      )}

      {!loading && tab === 'chats' && (
        <TradingTelegramChatsTab
          chats={chats}
          newChat={newChat}
          setNewChat={setNewChat}
          onSaved={() => onReload()}
        />
      )}

      {editId && (
        <EditModal
          editForm={editForm}
          setEditForm={setEditForm}
          busy={busy}
          onClose={() => setEditId(null)}
          onSave={() => void saveEdit()}
        />
      )}
    </>
  )
}

function DraftFiltersBar({
  isStaffView,
  users,
  aliases,
  draftStatus,
  setDraftStatus,
  filterUserId,
  setFilterUserId,
  filterAccountId,
  setFilterAccountId,
  duplicateOnly,
  setDuplicateOnly,
}: {
  isStaffView: boolean
  users: TradingTelegramUserRow[]
  aliases: TradingAccountAliasRow[]
  draftStatus: TradingTelegramDraftStatus | 'ALL'
  setDraftStatus: (v: TradingTelegramDraftStatus | 'ALL') => void
  filterUserId: string
  setFilterUserId: (v: string) => void
  filterAccountId: string
  setFilterAccountId: (v: string) => void
  duplicateOnly: boolean
  setDuplicateOnly: (v: boolean) => void
}) {
  const erpUsers = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of users) {
      if (u.userId && u.user?.name) map.set(u.userId, u.user.name)
    }
    return [...map.entries()]
  }, [users])

  return (
    <Card className="flex flex-wrap gap-2 p-3">
      <select
        value={draftStatus}
        onChange={e => setDraftStatus(e.target.value as TradingTelegramDraftStatus | 'ALL')}
        className="rounded-lg bg-black/40 px-2 py-1 text-xs text-cream"
      >
        <option value="PENDING">Pending</option>
        <option value="LOCKED">Locked</option>
        <option value="ALL">All statuses</option>
        <option value="REJECTED">Rejected</option>
        <option value="POSTED">Posted</option>
      </select>
      {!isStaffView && (
        <select
          value={filterUserId}
          onChange={e => setFilterUserId(e.target.value)}
          className="rounded-lg bg-black/40 px-2 py-1 text-xs text-cream"
        >
          <option value="">All ERP users</option>
          {erpUsers.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      )}
      <select
        value={filterAccountId}
        onChange={e => setFilterAccountId(e.target.value)}
        className="rounded-lg bg-black/40 px-2 py-1 text-xs text-cream"
      >
        <option value="">All accounts</option>
        {aliases.map(a => (
          <option key={a.tradingAccountId} value={a.tradingAccountId}>
            {a.tradingAccount?.accountTitle || a.alias}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-zinc-400">
        <input type="checkbox" checked={duplicateOnly} onChange={e => setDuplicateOnly(e.target.checked)} />
        Duplicates only
      </label>
    </Card>
  )
}

function DraftToolbar({
  selected,
  busy,
  selectAllPending,
  bulkConfirm,
  bulkReject,
}: {
  selected: Set<string>
  busy: boolean
  selectAllPending: () => void
  bulkConfirm: () => void
  bulkReject: () => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={selectAllPending}>Select all pending</Button>
      <Button variant="gold" size="sm" disabled={busy || !selected.size} onClick={() => void bulkConfirm()}>
        Bulk confirm ({selected.size})
      </Button>
      <Button variant="ghost" size="sm" disabled={busy || !selected.size} onClick={() => void bulkReject()}>
        Bulk reject ({selected.size})
      </Button>
    </div>
  )
}

function DraftRow({
  d,
  isStaffView,
  selected,
  onToggle,
  onApprove,
  onReject,
  onEdit,
  onReopen,
  onRequestDelete,
  busy,
}: {
  d: TradingTelegramDraftRow
  isStaffView: boolean
  selected: boolean
  onToggle: () => void
  onApprove: () => void
  onReject: () => void
  onEdit: () => void
  onReopen: () => void
  onRequestDelete: () => void
  busy: boolean
}) {
  const isLocked = d.status === 'LOCKED'
  const canConfirm = d.status === 'PENDING'
  const isPosted = d.status === 'POSTED'

  return (
    <>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1" disabled={d.status === 'POSTED'} />
        <EmployeeAvatar
          userId={d.userId || d.user?.id}
          name={d.user?.name}
          email={d.user?.email}
          imageUrl={d.user?.profileImageUrl}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-cream">
            {d.tradeNumber != null ? `#${d.tradeNumber} · ` : ''}
            {d.tradeType} · {d.usdtAmount} USDT @ {d.bdtRate} · fee {d.feeUsdt}
            {isLocked && <span className="ml-2 text-orange-300">LOCKED</span>}
          </p>
          {d.lockedReason && <p className="text-[10px] text-orange-200/80">{d.lockedReason}</p>}
          <p className="mt-1 text-xs text-zinc-400">
            ERP: {d.user?.name || '—'} · Telegram: @{d.telegramUsername || d.telegramUserId}
          </p>
          <p className="text-xs text-zinc-500">
            Account: {d.accountTitle || d.accountAlias || '—'}
          </p>
          <p className="mt-2 rounded-lg bg-black/30 p-2 font-mono text-[11px] text-zinc-300">{d.rawMessage}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {canConfirm && (
          <Button variant="gold" size="sm" disabled={busy} onClick={onApprove}>Confirm → ledger</Button>
        )}
        {isLocked && !isStaffView && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onReopen}>Reopen</Button>
        )}
        {canConfirm && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onEdit}>Edit</Button>
        )}
        {isPosted && d.tradingTradeId && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRequestDelete}>
            Request delete
          </Button>
        )}
        {(canConfirm || (isLocked && !isStaffView)) && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onReject}>
            {isLocked && !isStaffView ? 'Force reject' : 'Reject'}
          </Button>
        )}
      </div>
    </>
  )
}


function ChatsTab({
  chats,
  newChat,
  setNewChat,
  saveChat,
}: {
  chats: TradingTelegramChatRow[]
  newChat: { chatId: string; title: string }
  setNewChat: (v: typeof newChat) => void
  saveChat: (e: React.FormEvent) => void
}) {
  return (
    <ChatsTabBody chats={chats} newChat={newChat} setNewChat={setNewChat} saveChat={saveChat} />
  )
}

function ChatsTabBody({
  chats,
  newChat,
  setNewChat,
  saveChat,
}: {
  chats: TradingTelegramChatRow[]
  newChat: { chatId: string; title: string }
  setNewChat: (v: { chatId: string; title: string }) => void
  saveChat: (e: React.FormEvent) => void
}) {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="mb-2 text-xs text-zinc-500">Add bot to group, send any message — if unregistered, bot replies with chat ID.</p>
        <form onSubmit={e => void saveChat(e)} className="grid gap-2 md:grid-cols-3">
          <input placeholder="Chat ID (-100…)" value={newChat.chatId} onChange={e => setNewChat({ ...newChat, chatId: e.target.value })} className="rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream" required />
          <input placeholder="Title" value={newChat.title} onChange={e => setNewChat({ ...newChat, title: e.target.value })} className="rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream" />
          <Button type="submit" variant="gold">Approve group</Button>
        </form>
      </Card>
      <div className="divide-y divide-border rounded-2xl border border-border">
        {chats.map(c => (
          <div key={c.id} className="flex justify-between gap-3 px-4 py-3 text-xs">
            <span className="font-mono text-cream">{c.chatId}</span>
            <span className="text-zinc-400">{c.title || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function EditModal({
  editForm,
  setEditForm,
  busy,
  onClose,
  onSave,
}: {
  editForm: { tradeType: 'BUY' | 'SELL'; usdtAmount: string; bdtRate: string; feeUsdt: string; tradingAccountId: string }
  setEditForm: (v: typeof editForm) => void
  busy: boolean
  onClose: () => void
  onSave: () => void
}) {
  return (
    <MobileModalPortal open zIndex={PLATFORM_Z.pageModal} onBackdropClick={onClose}>
      <Card className="mobile-modal-shell w-full max-w-md sm:rounded-2xl">
        <div className="mobile-modal-header p-4 pb-3">
          <p className="text-sm font-black text-cream">Edit draft</p>
        </div>
        <div className="mobile-modal-body space-y-3 px-4 pb-4">
          <select value={editForm.tradeType} onChange={e => setEditForm({ ...editForm, tradeType: e.target.value as 'BUY' | 'SELL' })} className="w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-cream">
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
          <input placeholder="USDT" value={editForm.usdtAmount} onChange={e => setEditForm({ ...editForm, usdtAmount: e.target.value })} className="w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-cream" />
          <input placeholder="Rate" value={editForm.bdtRate} onChange={e => setEditForm({ ...editForm, bdtRate: e.target.value })} className="w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-cream" />
          <input placeholder="Fee USDT" value={editForm.feeUsdt} onChange={e => setEditForm({ ...editForm, feeUsdt: e.target.value })} className="w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-cream" />
          <input placeholder="Trading account ID" value={editForm.tradingAccountId} onChange={e => setEditForm({ ...editForm, tradingAccountId: e.target.value })} className="w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-cream" />
        </div>
        <div className="mobile-modal-footer px-4 pt-3">
          <EditModalActions busy={busy} onClose={onClose} onSave={onSave} />
        </div>
      </Card>
    </MobileModalPortal>
  )
}

function EditModalActions({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: () => void }) {
  return (
    <div className="flex gap-2">
      <Button variant="gold" disabled={busy} onClick={onSave}>Save</Button>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
    </div>
  )
}
