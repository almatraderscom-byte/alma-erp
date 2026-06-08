#!/usr/bin/env node
/**
 * Generates /api/agent/* route handlers from manifest.
 * Run: node scripts/generate-agent-routes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const AGENT = path.join(ROOT, 'src/app/api/agent')

const HEADER = `import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'
`

function write(rel, content) {
  const file = path.join(AGENT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return rel
}

const created = []

// --- EMPLOYEES ---
created.push(write('employees/route.ts', `${HEADER}
import { ListEmployeesQuerySchema, CreateEmployeeBodySchema } from '@/lib/agent-api/schemas/employees.schema'
import * as svc from '@/lib/agent-api/services/employees.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListEmployeesQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const { active, limit, search } = parsed.data
  const data = await svc.listEmployees({ active: active === 'true' ? true : active === 'false' ? false : undefined, limit, search })
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateEmployeeBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'employee.created', null, body.data, () => svc.createEmployee(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('employees/[id]/route.ts', `${HEADER}
import { PatchEmployeeBodySchema } from '@/lib/agent-api/schemas/employees.schema'
import * as svc from '@/lib/agent-api/services/employees.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getEmployee(params.id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchEmployeeBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'employee.updated', params.id, body.data, () => svc.patchEmployee(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'employee.deactivated', params.id, {}, () => svc.softDeleteEmployee(params.id))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

// --- ATTENDANCE ---
created.push(write('attendance/today/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/attendance.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.getAttendanceToday()
  return NextResponse.json({ data })
}
`))

created.push(write('attendance/history/route.ts', `${HEADER}
import { AttendanceHistoryQuerySchema } from '@/lib/agent-api/schemas/attendance.schema'
import * as svc from '@/lib/agent-api/services/attendance.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = AttendanceHistoryQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.getAttendanceHistory(parsed.data.employee_id, parsed.data.days)
  return NextResponse.json({ data })
}
`))

created.push(write('attendance/manual/route.ts', `${HEADER}
import { ManualAttendanceBodySchema } from '@/lib/agent-api/schemas/attendance.schema'
import * as svc from '@/lib/agent-api/services/attendance.service'

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = ManualAttendanceBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'attendance.manual_created', body.data.employeeId, body.data, () => svc.createManualAttendance(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('attendance/[id]/route.ts', `${HEADER}
import { PatchAttendanceBodySchema } from '@/lib/agent-api/schemas/attendance.schema'
import * as svc from '@/lib/agent-api/services/attendance.service'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchAttendanceBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'attendance.updated', params.id, body.data, () => svc.patchAttendance(params.id, body.data))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'attendance.deleted', params.id, {}, () => svc.deleteAttendance(params.id))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

// --- TASKS ---
created.push(write('tasks/route.ts', `${HEADER}
import { ListTasksQuerySchema, CreateTaskBodySchema } from '@/lib/agent-api/schemas/tasks.schema'
import * as svc from '@/lib/agent-api/services/tasks.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListTasksQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const { status, assigned_to, due_before, limit } = parsed.data
  const data = await svc.listTasks({ status, assignedTo: assigned_to, dueBefore: due_before, limit })
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateTaskBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'task.created', null, body.data, () => svc.createTask(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('tasks/[id]/route.ts', `${HEADER}
import { PatchTaskBodySchema } from '@/lib/agent-api/schemas/tasks.schema'
import * as svc from '@/lib/agent-api/services/tasks.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getTask(params.id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchTaskBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'task.updated', params.id, body.data, () => svc.patchTask(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'task.deleted', params.id, {}, () => svc.deleteTask(params.id))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e, 409) }
}
`))

created.push(write('tasks/[id]/complete/route.ts', `${HEADER}
import { CompleteTaskBodySchema } from '@/lib/agent-api/schemas/tasks.schema'
import * as svc from '@/lib/agent-api/services/tasks.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CompleteTaskBodySchema.safeParse(await req.json().catch(() => ({})))
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'task.completed', params.id, body.data, () => svc.completeTask(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('tasks/[id]/cancel/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/tasks.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'task.cancelled', params.id, {}, () => svc.cancelTask(params.id))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

// --- FINES ---
created.push(write('fines/route.ts', `${HEADER}
import { ListFinesQuerySchema, CreateFineBodySchema } from '@/lib/agent-api/schemas/fines.schema'
import * as svc from '@/lib/agent-api/services/fines.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListFinesQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listFines(parsed.data)
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateFineBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'fine.created', null, body.data, () => svc.createFine(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('fines/pending/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/fines.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.listPendingFines()
  return NextResponse.json({ data })
}
`))

created.push(write('fines/[id]/approve/route.ts', `${HEADER}
import { ApproveFineBodySchema } from '@/lib/agent-api/schemas/fines.schema'
import * as svc from '@/lib/agent-api/services/fines.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = ApproveFineBodySchema.safeParse(await req.json().catch(() => ({ approvedBy: 'agent_via_sir' })))
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'fine.approved', params.id, body.data, () => svc.approveFine(params.id, body.data.note))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('fines/[id]/waive/route.ts', `${HEADER}
import { WaiveFineBodySchema } from '@/lib/agent-api/schemas/fines.schema'
import * as svc from '@/lib/agent-api/services/fines.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = WaiveFineBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'fine.waived', params.id, body.data, () => svc.waiveFine(params.id, body.data.reason))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('fines/[id]/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/fines.service'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'fine.deleted', params.id, {}, () => svc.deleteFine(params.id))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e, 409) }
}
`))

// --- PRODUCTS ---
created.push(write('products/route.ts', `${HEADER}
import { ListProductsQuerySchema, CreateProductBodySchema } from '@/lib/agent-api/schemas/products.schema'
import * as svc from '@/lib/agent-api/services/products.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListProductsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listProducts(parsed.data)
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateProductBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'product.created', null, body.data, () => svc.createProduct(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('products/low-stock/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/products.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.listLowStock()
  return NextResponse.json({ data })
}
`))

created.push(write('products/[id]/route.ts', `${HEADER}
import { PatchProductBodySchema } from '@/lib/agent-api/schemas/products.schema'
import * as svc from '@/lib/agent-api/services/products.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getProduct(params.id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchProductBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'product.updated', params.id, body.data, () => svc.patchProduct(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'product.archived', params.id, {}, () => svc.softDeleteProduct(params.id))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('products/[id]/pricing/route.ts', `${HEADER}
import { PatchProductPricingBodySchema } from '@/lib/agent-api/schemas/products.schema'
import * as svc from '@/lib/agent-api/services/products.service'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchProductPricingBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'product.pricing_updated', params.id, body.data, () => svc.patchProductPricing(params.id, body.data.price, body.data.note))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('products/[id]/inventory/route.ts', `${HEADER}
import { PatchProductInventoryBodySchema } from '@/lib/agent-api/schemas/products.schema'
import * as svc from '@/lib/agent-api/services/products.service'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchProductInventoryBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'product.inventory_adjusted', params.id, body.data, () => svc.patchProductInventory(params.id, body.data.delta, body.data.reason))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

// --- INVENTORY ---
created.push(write('inventory/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/inventory.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.listInventory()
  return NextResponse.json({ data })
}
`))

created.push(write('inventory/[product_id]/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/inventory.service'

export async function GET(_req: NextRequest, { params }: { params: { product_id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getInventoryProduct(params.product_id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}
`))

created.push(write('inventory/adjust/route.ts', `${HEADER}
import { InventoryAdjustBodySchema } from '@/lib/agent-api/schemas/inventory.schema'
import * as svc from '@/lib/agent-api/services/inventory.service'

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = InventoryAdjustBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'inventory.adjusted', null, body.data, () => svc.adjustInventory(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('inventory/movements/route.ts', `${HEADER}
import { InventoryMovementsQuerySchema } from '@/lib/agent-api/schemas/inventory.schema'
import * as svc from '@/lib/agent-api/services/inventory.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = InventoryMovementsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listInventoryMovements(parsed.data)
  return NextResponse.json({ data })
}
`))

// --- ORDERS WRITE ---
created.push(write('orders/today/live/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/orders-write.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.listTodayLiveOrders()
  return NextResponse.json({ data })
}
`))

created.push(write('orders/[id]/cancel/route.ts', `${HEADER}
import { OrderCancelBodySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/orders-write.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = OrderCancelBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'order.cancelled', params.id, body.data, () => svc.cancelOrder(params.id, body.data.reason))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('orders/[id]/refund/route.ts', `${HEADER}
import { OrderRefundBodySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/orders-write.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = OrderRefundBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'order.refunded', params.id, body.data, () => svc.refundOrder(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('orders/[id]/status/route.ts', `${HEADER}
import { OrderStatusBodySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/orders-write.service'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = OrderStatusBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'order.status_updated', params.id, body.data, () => svc.patchOrderStatus(params.id, body.data.status, body.data.reason))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('orders/[id]/note/route.ts', `${HEADER}
import { OrderNoteBodySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/orders-write.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = OrderNoteBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'order.note_added', params.id, body.data, () => svc.addOrderNote(params.id, body.data.note))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

// --- CUSTOMERS ---
created.push(write('customers/route.ts', `${HEADER}
import { ListCustomersQuerySchema, CreateCustomerBodySchema } from '@/lib/agent-api/schemas/customers.schema'
import * as svc from '@/lib/agent-api/services/customers.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListCustomersQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listCustomers(parsed.data)
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateCustomerBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'customer.created', null, body.data, () => svc.createCustomer(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('customers/[id]/route.ts', `${HEADER}
import { PatchCustomerBodySchema } from '@/lib/agent-api/schemas/customers.schema'
import * as svc from '@/lib/agent-api/services/customers.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getCustomer(params.id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchCustomerBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'customer.updated', params.id, body.data, () => svc.patchCustomer(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('customers/[id]/orders/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/customers.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getCustomerOrders(params.id)
  return NextResponse.json({ data })
}
`))

created.push(write('customers/[id]/note/route.ts', `${HEADER}
import { CustomerNoteBodySchema } from '@/lib/agent-api/schemas/customers.schema'
import * as svc from '@/lib/agent-api/services/customers.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CustomerNoteBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'customer.note_added', params.id, body.data, () => svc.addCustomerNote(params.id, body.data.note))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('customers/[id]/tag/route.ts', `${HEADER}
import { CustomerTagBodySchema } from '@/lib/agent-api/schemas/customers.schema'
import * as svc from '@/lib/agent-api/services/customers.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CustomerTagBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'customer.tagged', params.id, body.data, () => svc.addCustomerTag(params.id, body.data.tag))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('customers/[id]/tag/[tag]/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/customers.service'

export async function DELETE(req: NextRequest, { params }: { params: { id: string; tag: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'customer.tag_removed', params.id, { tag: params.tag }, () => svc.removeCustomerTag(params.id, decodeURIComponent(params.tag)))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

// --- PROMOS ---
created.push(write('promos/route.ts', `${HEADER}
import { CreatePromoBodySchema } from '@/lib/agent-api/schemas/promos.schema'
import * as svc from '@/lib/agent-api/services/promos.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.listPromos()
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreatePromoBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'promo.created', null, body.data, () => svc.createPromo(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('promos/[id]/route.ts', `${HEADER}
import { PatchPromoBodySchema } from '@/lib/agent-api/schemas/promos.schema'
import * as svc from '@/lib/agent-api/services/promos.service'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchPromoBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'promo.updated', params.id, body.data, () => svc.patchPromo(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'promo.deleted', params.id, {}, () => svc.deletePromo(params.id))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

created.push(write('promos/[id]/deactivate/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/promos.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'promo.deactivated', params.id, {}, () => svc.deactivatePromo(params.id))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))

// --- REPORTS ---
const reportRoutes = [
  ['sales', `const { period, groupBy } = parsed.data\n  const data = await svc.reportSales(period, groupBy)`, 'ReportsSalesQuerySchema'],
  ['inventory', `const data = await svc.reportInventory(parsed.data.slowDays)`, 'ReportsInventoryQuerySchema'],
  ['customers', `const { period, top } = parsed.data\n  const data = await svc.reportCustomers(period, top)`, 'ReportsCustomersQuerySchema'],
  ['employees', `const data = await svc.reportEmployees(parsed.data.days)`, 'ReportsEmployeesQuerySchema'],
  ['finance', `const data = await svc.reportFinance(parsed.data.period)`, 'ReportsFinanceQuerySchema'],
]
for (const [name, body, schema] of reportRoutes) {
  created.push(write(`reports/${name}/route.ts`, `${HEADER}
import { ${schema} } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/reports.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ${schema}.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  ${body}
  return NextResponse.json({ data })
}
`))
}

// --- SETTINGS ---
created.push(write('settings/route.ts', `${HEADER}
import * as svc from '@/lib/agent-api/services/settings.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.getSettings()
  return NextResponse.json({ data })
}
`))

const settingsRoutes = [
  ['business-hours', 'SettingsPatchBusinessHoursSchema', 'patchBusinessHours', 'body.data'],
  ['holidays', 'SettingsPatchHolidaysSchema', 'patchHolidays', 'body.data.holidays'],
  ['late-threshold', 'SettingsPatchLateThresholdSchema', 'patchLateThreshold', 'body.data.lateThresholdMinutes'],
  ['fine-policy', 'SettingsPatchFinePolicySchema', 'patchFinePolicy', 'body.data'],
]
for (const [pathSeg, schema, fn, arg] of settingsRoutes) {
  created.push(write(`settings/${pathSeg}/route.ts`, `${HEADER}
import { ${schema} } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/settings.service'

export async function PATCH(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = ${schema}.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'settings.${pathSeg}_updated', 'global', body.data, () => svc.${fn}(${arg}))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
`))
}

// --- AUDIT ---
created.push(write('audit/recent/route.ts', `${HEADER}
import { AuditRecentQuerySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/audit.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = AuditRecentQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listRecentAudits(parsed.data.limit)
  return NextResponse.json({ data: { entries: data, meta: { count: data.length } } })
}
`))

created.push(write('audit/by-action/route.ts', `${HEADER}
import { AuditByActionQuerySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/audit.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = AuditByActionQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listRecentAudits(parsed.data.limit, parsed.data.action)
  return NextResponse.json({ data: { entries: data, meta: { count: data.length, action: parsed.data.action } } })
}
`))

console.log('Created', created.length, 'route groups')
console.log(created.join('\n'))
