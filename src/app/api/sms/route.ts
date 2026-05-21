import { NextRequest } from 'next/server'
import { GET as getLogs } from '@/app/api/sms/logs/route'

export async function GET(req: NextRequest) {
  return getLogs(req)
}
