/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demo users in production without ALLOW_PRODUCTION_DEMO_SEED=true')
  }

  const passwordHash = await bcrypt.hash('AlmaDemo2026!', 12)

  const rows = [
    {
      email: 'super@alma-erp.demo',
      phone: '+8801700000001',
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
      businessAccess: 'ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT',
    },
    {
      email: 'admin@alma-erp.demo',
      phone: '+8801700000002',
      name: 'Ops Admin',
      role: 'ADMIN',
      businessAccess: 'ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT',
    },
    {
      email: 'hr@alma-erp.demo',
      phone: '+8801700000003',
      name: 'HR Lead',
      role: 'HR',
      businessAccess: 'ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT',
    },
    {
      email: 'staff@alma-erp.demo',
      phone: '+8801700000004',
      name: 'Sales Staff',
      role: 'STAFF',
      businessAccess: 'ALMA_LIFESTYLE',
    },
    {
      email: 'viewer@alma-erp.demo',
      phone: '+8801700000005',
      name: 'Finance Viewer',
      role: 'VIEWER',
      businessAccess: 'ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT',
    },
  ]

  for (const r of rows) {
    await prisma.user.upsert({
      where: { email: r.email },
      update: {
        name: r.name,
        passwordHash,
        role: r.role,
        phone: r.phone,
        businessAccess: r.businessAccess,
        active: true,
      },
      create: {
        email: r.email,
        name: r.name,
        passwordHash,
        role: r.role,
        phone: r.phone,
        businessAccess: r.businessAccess,
        active: true,
      },
    })
    console.log('Seeded user:', r.email)
  }
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
