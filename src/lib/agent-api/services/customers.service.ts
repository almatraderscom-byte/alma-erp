import { getLifestyleCustomers } from '@/lib/lifestyle/read'
import {
  dispatchCreateCustomer,
  dispatchUpdateCustomer,
} from '@/lib/lifestyle/write-dispatch'
import { agentActorPayload } from '@/lib/agent-api/route-handler'
import { listAgentOrders } from '@/lib/agent-api/orders.service'
import type { Customer } from '@/types'

const customerTags = new Map<string, Set<string>>()

function mapCustomer(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone || null,
    district: c.district || null,
    segment: c.segment || null,
    totalOrders: Number(c.total_orders ?? 0),
    totalSpent: Number(c.total_spent ?? 0),
    notes: c.notes || null,
    tags: [...(customerTags.get(c.id) ?? [])],
  }
}

export async function listCustomers(input: { search?: string; segment?: string; limit?: number }) {
  const data = await getLifestyleCustomers({})
  let customers = (data.customers ?? []).map(mapCustomer)
  if (input.search) {
    const q = input.search.toLowerCase()
    customers = customers.filter(
      c => c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q),
    )
  }
  if (input.segment) customers = customers.filter(c => c.segment === input.segment)
  const limit = input.limit ?? 50
  return { customers: customers.slice(0, limit), meta: { count: customers.length, limit } }
}

export async function getCustomer(id: string) {
  const { customers } = await listCustomers({ limit: 500 })
  return customers.find(c => c.id === id) ?? null
}

export async function getCustomerOrders(id: string, limit = 20) {
  const { orders } = await listAgentOrders({ limit: 200 })
  const filtered = orders.filter(o => o.customerPhone && o.id.includes(id))
  return { customerId: id, orders: filtered.slice(0, limit), meta: { count: filtered.length } }
}

export async function createCustomer(body: Record<string, unknown>) {
  const result = await dispatchCreateCustomer(agentActorPayload(body))
  const id = String((result as { customer_id?: string; id?: string }).customer_id ?? (result as { id?: string }).id ?? '')
  return { id, status: 'created', createdAt: new Date().toISOString() }
}

export async function patchCustomer(id: string, body: Record<string, unknown>) {
  await dispatchUpdateCustomer(agentActorPayload({ id, ...body }))
  return { id, status: 'updated', updatedAt: new Date().toISOString() }
}

export async function addCustomerNote(id: string, note: string) {
  await dispatchUpdateCustomer(agentActorPayload({ id, notes_append: note }))
  return { id, status: 'note_added' }
}

export async function addCustomerTag(id: string, tag: string) {
  if (!customerTags.has(id)) customerTags.set(id, new Set())
  customerTags.get(id)!.add(tag)
  return { id, tag, status: 'tagged' }
}

export async function removeCustomerTag(id: string, tag: string) {
  customerTags.get(id)?.delete(tag)
  return { id, tag, status: 'tag_removed' }
}
