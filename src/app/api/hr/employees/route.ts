import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendPayrollAlert } from '@/lib/resend'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet('hr_employees', p, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const result = await serverPost('hr_employee_save', await mergeActorPayload(req, body as Record<string, unknown>))
    await sendPayrollAlert({
      businessId: String(body.business_id || 'ALMA_LIFESTYLE'),
      subject: `Employee added/updated · ${String(body.name || (result as { emp_id?: string }).emp_id || '')}`,
      title: 'Employee added',
      preview: `${String(body.name || 'Employee')} was saved in HR.`,
      text: `${String(body.name || 'Employee')} was saved in HR. Employee ID: ${String((result as { emp_id?: string }).emp_id || body.emp_id || '')}.`,
      priority: 'NORMAL',
      actionUrl: '/employees',
      actionLabel: 'Open employees',
      dedupeKey: `employee-save:${String((result as { emp_id?: string }).emp_id || body.emp_id || Date.now())}:${String(body.updated_at || '')}`,
      metadata: { result, body },
    })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
