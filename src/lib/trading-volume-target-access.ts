import { NextResponse } from 'next/server'
import type { AlmaRole } from '@/lib/roles'
import type { TradingContext } from '@/lib/trading'

/** Daily volume target management + penalty enforcement — Super Admin only. */
export function isTradingSuperAdmin(role: AlmaRole | string): boolean {
  return role === 'SUPER_ADMIN'
}

export function canManageTradingVolumeTargets(ctx: Pick<TradingContext, 'role'>): boolean {
  return isTradingSuperAdmin(ctx.role)
}

/** Admins may view dashboards and summaries only. */
export function canViewTradingVolumeTargets(ctx: Pick<TradingContext, 'isAdmin'>): boolean {
  return ctx.isAdmin
}

export function requireTradingSuperAdmin(ctx: Pick<TradingContext, 'role'>) {
  if (!canManageTradingVolumeTargets(ctx)) {
    return NextResponse.json(
      { error: 'Only Super Admin can manage trading volume targets and penalties.' },
      { status: 403 },
    )
  }
  return null
}

export function requireTradingVolumeTargetView(ctx: Pick<TradingContext, 'isAdmin'>) {
  if (!canViewTradingVolumeTargets(ctx)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}
