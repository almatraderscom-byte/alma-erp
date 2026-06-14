/**
 * Phase 4 — Postgres-only lifestyle writes (GAS per-request mirror removed; nightly export handles sheet sync).
 */
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

type JsonResult = Record<string, unknown>

function assertOk(result: unknown): JsonResult {
  if (result && typeof result === 'object' && 'error' in result && (result as { error?: string }).error) {
    throw new Error(String((result as { error: string }).error))
  }
  return result as JsonResult
}

export async function dispatchCreateOrder(payload: Record<string, unknown>) {
  return assertOk(await createOrderInPostgres(payload))
}

export async function dispatchUpdateOrderStatus(payload: Record<string, unknown>) {
  return assertOk(await updateOrderStatusInPostgres(payload))
}

export async function dispatchUpdateOrderField(payload: Record<string, unknown>) {
  return assertOk(await updateOrderFieldInPostgres(payload))
}

export async function dispatchUpdateOrderTracking(payload: Record<string, unknown>) {
  return assertOk(await updateOrderTrackingInPostgres(payload))
}

export async function dispatchCreateProduct(payload: Record<string, unknown>) {
  return assertOk(await createProductInPostgres(payload))
}

export async function dispatchUpdateProduct(payload: Record<string, unknown>) {
  return assertOk(await updateProductInPostgres(payload))
}

export async function dispatchCreateCustomer(payload: Record<string, unknown>) {
  return assertOk(await createCustomerInPostgres(payload))
}

export async function dispatchUpdateCustomer(payload: Record<string, unknown>) {
  return assertOk(await updateCustomerInPostgres(payload))
}

export async function dispatchInventoryAction(payload: Record<string, unknown>) {
  return assertOk(await inventoryActionInPostgres(payload))
}

export async function dispatchCreatePromo(payload: Record<string, unknown>) {
  return assertOk(await upsertPromoInPostgres(payload))
}

export async function dispatchUpdatePromo(payload: Record<string, unknown>) {
  return assertOk(await upsertPromoInPostgres(payload))
}

export async function dispatchDeactivatePromo(payload: Record<string, unknown>) {
  return assertOk(await upsertPromoInPostgres(payload, { deactivate: true }))
}

export async function dispatchDeletePromo(payload: Record<string, unknown>) {
  return assertOk(await upsertPromoInPostgres(payload, { delete: true }))
}
