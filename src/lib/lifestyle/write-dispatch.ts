/**
 * Phase 3 write dispatch — Postgres first when write flag on; else GAS + mirror (Phase 2).
 */
import { isSupabaseWriteEnabled } from '@/lib/migration-flags'
import {
  createCustomerInPostgres,
  createOrderInPostgres,
  createProductInPostgres,
  inventoryActionInPostgres,
  updateCustomerInPostgres,
  updateOrderFieldInPostgres,
  updateOrderStatusInPostgres,
  updateOrderTrackingInPostgres,
  updateProductInPostgres,
  upsertPromoInPostgres,
} from '@/lib/lifestyle/write'
import {
  mirrorAllStockAfterGasWrite,
  mirrorCustomerAfterGasWrite,
  mirrorOrderAfterGasWrite,
  mirrorOrderCreateResult,
  mirrorProductAfterGasWrite,
  mirrorPromoAfterGasWrite,
} from '@/lib/lifestyle/mirror'
import { serverPost } from '@/lib/server-api'

type JsonResult = Record<string, unknown>

async function writeMode(): Promise<boolean> {
  return isSupabaseWriteEnabled()
}

function gasError(result: unknown): string | null {
  if (result && typeof result === 'object' && 'error' in result && (result as { error?: string }).error) {
    return String((result as { error: string }).error)
  }
  return null
}

export async function dispatchCreateOrder(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await createOrderInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('create_order', payload)
  mirrorOrderCreateResult(result as JsonResult, payload)
  return result as JsonResult
}

export async function dispatchUpdateOrderStatus(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await updateOrderStatusInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('update_status', payload)
  mirrorOrderAfterGasWrite(String(payload.id ?? ''))
  return result as JsonResult
}

export async function dispatchUpdateOrderField(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await updateOrderFieldInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('update_field', payload)
  mirrorOrderAfterGasWrite(String(payload.id ?? ''))
  return result as JsonResult
}

export async function dispatchUpdateOrderTracking(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await updateOrderTrackingInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('update_tracking', payload)
  mirrorOrderAfterGasWrite(String(payload.id ?? ''))
  return result as JsonResult
}

export async function dispatchCreateProduct(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await createProductInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('create_product', payload)
  mirrorProductAfterGasWrite(String((result as { product_id?: string }).product_id ?? payload.sku ?? ''))
  return result as JsonResult
}

export async function dispatchUpdateProduct(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await updateProductInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('update_product', payload)
  mirrorProductAfterGasWrite(String(payload.sku ?? payload.id ?? ''))
  return result as JsonResult
}

export async function dispatchCreateCustomer(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await createCustomerInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('create_customer', payload)
  mirrorCustomerAfterGasWrite(String((result as { customer_id?: string; id?: string }).customer_id ?? (result as { id?: string }).id ?? payload.id ?? ''))
  return result as JsonResult
}

export async function dispatchUpdateCustomer(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await updateCustomerInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('update_customer', payload)
  mirrorCustomerAfterGasWrite(String(payload.id ?? ''))
  return result as JsonResult
}

export async function dispatchInventoryAction(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await inventoryActionInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const routeByAction: Record<string, string> = {
    edit: 'inventory_edit',
    archive: 'inventory_archive',
    restore: 'inventory_restore',
    adjust: 'inventory_adjust',
    bulk_update: 'inventory_bulk_update',
    consolidate_lifestyle: 'inventory_consolidate_lifestyle',
  }
  const action = String(payload.action ?? 'adjust')
  const route = routeByAction[action] ?? 'inventory_adjust'
  const result = await serverPost(route, payload)
  mirrorAllStockAfterGasWrite()
  return result as JsonResult
}

export async function dispatchCreatePromo(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await upsertPromoInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('create_promo', payload)
  mirrorPromoAfterGasWrite(payload, result as JsonResult)
  return result as JsonResult
}

export async function dispatchUpdatePromo(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await upsertPromoInPostgres(payload)
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('update_promo', payload)
  mirrorPromoAfterGasWrite(payload, result as JsonResult)
  return result as JsonResult
}

export async function dispatchDeactivatePromo(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await upsertPromoInPostgres(payload, { deactivate: true })
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('deactivate_promo', payload)
  mirrorPromoAfterGasWrite({ ...payload, deactivate: true }, result as JsonResult)
  return result as JsonResult
}

export async function dispatchDeletePromo(payload: Record<string, unknown>): Promise<JsonResult> {
  if (await writeMode()) {
    const result = await upsertPromoInPostgres(payload, { delete: true })
    const err = gasError(result)
    if (err) throw new Error(err)
    return result
  }
  const result = await serverPost('delete_promo', payload)
  mirrorPromoAfterGasWrite({ ...payload, delete: true }, result as JsonResult)
  return result as JsonResult
}
