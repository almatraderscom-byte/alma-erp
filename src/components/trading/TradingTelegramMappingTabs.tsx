'use client'

import { Button, Card, Empty, Input } from '@/components/ui'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import {
  accountToSearchableOptions,
  resolveDefaultAlias,
  staffToSearchableOptions,
} from '@/lib/telegram-mapping-options'
import type { TradingAccountAliasRow, TradingTelegramUserRow } from '@/types/trading-telegram'

type NewUserForm = {
  telegramUserId: string
  userId: string
  telegramUsername: string
  defaultAccountAlias: string
  defaultTradingAccountId: string
}

export function TelegramUsersTab({
  users,
  newUser,
  setNewUser,
  saveUser,
  staffOptions,
  accountOptions,
  aliasByAccountId,
  mappingLoading,
  savingUser,
  onRemove,
  removingId,
  canRemove,
}: {
  users: TradingTelegramUserRow[]
  newUser: NewUserForm
  setNewUser: (v: NewUserForm) => void
  saveUser: (e: React.FormEvent) => void
  staffOptions: ReturnType<typeof staffToSearchableOptions>
  accountOptions: ReturnType<typeof accountToSearchableOptions>
  aliasByAccountId: Map<string, string>
  mappingLoading: boolean
  savingUser: boolean
  onRemove?: (u: TradingTelegramUserRow) => void
  removingId?: string | null
  canRemove?: boolean
}) {
  function onAccountChange(accountId: string) {
    setNewUser({
      ...newUser,
      defaultTradingAccountId: accountId,
      defaultAccountAlias: resolveDefaultAlias(accountId, aliasByAccountId),
    })
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <p className="text-sm font-black text-cream">Link Telegram → ERP staff</p>
        <p className="mt-1 text-xs text-zinc-500">
          Map each trader&apos;s Telegram identity to their ERP profile and optional default trading account.
        </p>
        <form onSubmit={e => void saveUser(e)} className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Telegram numeric user ID
            </label>
            <Input
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="e.g. 123456789"
              value={newUser.telegramUserId}
              onChange={e => setNewUser({ ...newUser, telegramUserId: e.target.value.replace(/\D/g, '') })}
              required
            />
            <p className="mt-1 text-[10px] text-zinc-600">
              Open Telegram and message <span className="text-gold-lt">@userinfobot</span> — it replies with your numeric ID.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Telegram @username (optional)
            </label>
            <Input
              placeholder="username (without @)"
              value={newUser.telegramUsername}
              onChange={e => setNewUser({ ...newUser, telegramUsername: e.target.value.replace(/^@/, '') })}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              ERP staff member
            </label>
            <SearchableSelect
              value={newUser.userId}
              onChange={userId => setNewUser({ ...newUser, userId })}
              options={staffOptions}
              placeholder="Search by name, HR ID, or phone…"
              loading={mappingLoading}
              required
              emptyMessage="No staff with Alma Trading access"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Default trading account (optional)
            </label>
            <SearchableSelect
              value={newUser.defaultTradingAccountId}
              onChange={onAccountChange}
              options={accountOptions}
              placeholder="Search account name or alias…"
              loading={mappingLoading}
              emptyMessage="No active trading accounts"
            />
          </div>
          {newUser.defaultTradingAccountId && (
            <div className="sm:col-span-2 rounded-xl border border-border/60 bg-black/[0.03] px-3 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Default alias (auto-filled)</p>
              <p className="text-sm text-cream">
                {newUser.defaultAccountAlias
                  ? newUser.defaultAccountAlias
                  : 'No alias registered for this account — add one in the Aliases tab'}
              </p>
            </div>
          )}
          <Button
            type="submit"
            variant="gold"
            disabled={savingUser || mappingLoading}
            className="sm:col-span-2 w-full sm:w-auto"
          >
            {savingUser ? 'Saving…' : 'Save & approve'}
          </Button>
        </form>
      </Card>
      {!users.length ? (
        <Empty icon="👤" title="No Telegram users linked yet" desc="Add a mapping above to allow draft trades from Telegram." />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          <div className="hidden gap-2 bg-black/[0.03] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500 md:grid md:grid-cols-[1fr_1.2fr_0.6fr_1fr_auto]">
            <span>Telegram</span>
            <span>ERP staff</span>
            <span>Status</span>
            <span>Default account</span>
            <span className="sr-only">Actions</span>
          </div>
          {users.map(u => (
            <TelegramUserRow
              key={u.id}
              u={u}
              onRemove={canRemove ? onRemove : undefined}
              removing={removingId === u.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TelegramUserRow({
  u,
  onRemove,
  removing,
}: {
  u: TradingTelegramUserRow
  onRemove?: (u: TradingTelegramUserRow) => void
  removing?: boolean
}) {
  const hrId = u.user?.employeeIdGas?.trim()
  const showRemove = Boolean(onRemove) && (Boolean(u.userId) || u.approved)
  return (
    <div className="grid gap-1 px-4 py-3 text-xs sm:gap-2 md:grid-cols-[1fr_1.2fr_0.6fr_1fr_auto]">
      <span className="font-bold text-cream">
        {u.telegramUsername ? `@${u.telegramUsername}` : `ID ${u.telegramUserId}`}
      </span>
      <span className="text-zinc-400">
        {u.user?.name || '—'}
        {hrId ? <span className="text-zinc-600"> · {hrId}</span> : null}
        {u.user?.role ? <span className="text-zinc-600"> · {u.user.role}</span> : null}
      </span>
      <span className={u.approved ? 'text-green-400' : 'text-amber-300'}>{u.approved ? 'Approved' : 'Pending'}</span>
      <span className="text-zinc-500">Default alias: {u.defaultAccountAlias || '—'}</span>
      <span className="md:justify-self-end">
        {showRemove ? (
          <button
            type="button"
            onClick={() => onRemove?.(u)}
            disabled={removing}
            className="rounded-lg border border-rose-600/40 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-rose-300 hover:bg-rose-600/10 disabled:opacity-40"
            aria-label={`Unlink Telegram user ${u.telegramUsername || u.telegramUserId}`}
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        ) : null}
      </span>
    </div>
  )
}

export function TelegramAliasesTab({
  aliases,
  newAlias,
  setNewAlias,
  saveAlias,
  accountOptions,
  mappingLoading,
  savingAlias,
}: {
  aliases: TradingAccountAliasRow[]
  newAlias: { alias: string; tradingAccountId: string }
  setNewAlias: (v: { alias: string; tradingAccountId: string }) => void
  saveAlias: (e: React.FormEvent) => void
  accountOptions: ReturnType<typeof accountToSearchableOptions>
  mappingLoading: boolean
  savingAlias: boolean
}) {
  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <p className="text-sm font-black text-cream">Account short aliases</p>
        <p className="mt-1 text-xs text-zinc-500">Traders type these in Telegram (e.g. <span className="text-gold-lt">sh</span>).</p>
        <form onSubmit={e => void saveAlias(e)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1.5fr_auto]">
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-zinc-500">Alias</label>
            <Input
              placeholder="sh"
              value={newAlias.alias}
              onChange={e => setNewAlias({ ...newAlias, alias: e.target.value.toLowerCase() })}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-zinc-500">Trading account</label>
            <SearchableSelect
              value={newAlias.tradingAccountId}
              onChange={tradingAccountId => setNewAlias({ ...newAlias, tradingAccountId })}
              options={accountOptions}
              placeholder="Search account…"
              loading={mappingLoading}
              required
              emptyMessage="No active trading accounts"
            />
          </div>
          <Button type="submit" variant="gold" disabled={savingAlias || mappingLoading} className="w-full lg:self-end">
            {savingAlias ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </Card>
      <div className="divide-y divide-border rounded-2xl border border-border">
        {aliases.map(a => (
          <div key={a.id} className="flex flex-col gap-1 px-4 py-3 text-xs sm:flex-row sm:justify-between sm:gap-3">
            <span className="font-black text-gold-lt">{a.alias}</span>
            <span className="text-cream">{a.tradingAccount?.accountTitle || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
