import { config } from 'dotenv'
config({ path: '.env.local' })

import { resetAttendanceRecordByAdmin } from '../src/lib/attendance-reset.ts'
import { prisma } from '../src/lib/prisma.ts'

async function main() {
  const recordId = process.argv[2]
  if (!recordId) {
    console.error('Usage: npx tsx scripts/reset-attendance-once.mts <recordId>')
    process.exit(1)
  }
  const admin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', active: true },
    select: { id: true, name: true },
  })
  if (!admin) throw new Error('No active SUPER_ADMIN user')
  const result = await resetAttendanceRecordByAdmin(recordId, admin.id)
  console.log(JSON.stringify(result, null, 2))
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
