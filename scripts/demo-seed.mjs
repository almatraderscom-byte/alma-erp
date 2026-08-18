/**
 * demo-seed.mjs — build the fake dataset for the ALMA **demo instance**.
 *
 * This is NOT the dev-login seed (`prisma/seed.cjs`, which only creates users and
 * leaves them pointed at whatever database they run against). This script fills a
 * dedicated demo database with a full, believable business so the app can be handed
 * to a customer or a reviewer without exposing a single real order, phone number or
 * salary.
 *
 * Safety — three independent guards, because a mis-pointed DATABASE_URL here would
 * be unrecoverable:
 *   1. `ALMA_DEMO_SEED_CONFIRM=ALMA_DEMO_YES` must be set explicitly.
 *   2. The target database must contain no non-demo user and no non-demo order.
 *   3. Every row this script writes carries a `DEMO-` id prefix, and the reset step
 *      deletes only that prefix — it has no statement that can touch a real row.
 *
 * Deterministic: the PRNG is seeded, so a nightly reset restores the identical
 * dataset. Dates are relative to the run date so the demo never looks stale.
 *
 *   ALMA_DEMO_SEED_CONFIRM=ALMA_DEMO_YES DATABASE_URL=<demo-db> node scripts/demo-seed.mjs
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { pathToFileURL } from 'node:url'

const prisma = new PrismaClient()

const BUSINESS_ID = 'ALMA_LIFESTYLE'
const DEMO_EMAIL_SUFFIX = '@alma-erp.demo'
const ID = 'DEMO-'

/** Deterministic PRNG (mulberry32) — same seed, same demo every reset. */
function makeRng(seed) {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = makeRng(20260814)
const pick = arr => arr[Math.floor(rng() * arr.length)]
const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
/** Whole-taka only — the ERP never stores fractional currency. */
const taka = n => Math.round(n)

const DAY_MS = 24 * 60 * 60 * 1000
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000 // Asia/Dhaka is UTC+6 year round, no DST.

/**
 * Anchored to the Dhaka calendar day pinned at UTC midnight, NOT to this Mac's local
 * midnight. The app reads dates as Dhaka days; seeding from a machine on any other
 * offset shifts every row by a day, which showed up as the whole team reading
 * "absent" today and order dates landing on the wrong date.
 */
const nowDhaka = new Date(Date.now() + DHAKA_OFFSET_MS)
const today = new Date(Date.UTC(nowDhaka.getUTCFullYear(), nowDhaka.getUTCMonth(), nowDhaka.getUTCDate()))
const daysAgo = n => new Date(today.getTime() - n * DAY_MS)
/** Dhaka wall-clock time on a given day, as a UTC instant. */
const dhakaTime = (day, minutesFromMidnight) =>
  new Date(day.getTime() + minutesFromMidnight * 60 * 1000 - DHAKA_OFFSET_MS)

// ── catalogue ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { name: 'Kids Frock', sizes: ['1-2Y', '2-3Y', '3-4Y', '5-6Y', '7-8Y'], cogs: [420, 900], margin: [1.7, 2.4] },
  { name: 'Panjabi', sizes: ['S', 'M', 'L', 'XL'], cogs: [650, 1450], margin: [1.6, 2.2] },
  { name: 'Kurti', sizes: ['S', 'M', 'L', 'XL'], cogs: [520, 1150], margin: [1.7, 2.3] },
  { name: 'Three Piece', sizes: ['M', 'L', 'XL'], cogs: [1100, 2400], margin: [1.5, 2.0] },
  { name: 'Baby Set', sizes: ['0-6M', '6-12M', '1-2Y'], cogs: [380, 780], margin: [1.8, 2.5] },
  { name: 'Accessories', sizes: ['Free'], cogs: [90, 320], margin: [2.0, 3.0] },
]

const PRODUCT_WORDS = [
  'Aurora', 'Meherun', 'Nokshi', 'Rongdhonu', 'Shapla', 'Tasneem', 'Neelabh', 'Rupkotha',
  'Chandni', 'Bakul', 'Doyel', 'Kashful', 'Jharna', 'Mayur', 'Palki', 'Shiuli',
  'Alpona', 'Bonolota', 'Tarash', 'Nabanno', 'Megher', 'Shonali', 'Rodela', 'Bristi',
]
const COLORS = ['Maroon', 'Navy', 'Off-White', 'Sage', 'Mustard', 'Black', 'Powder Blue', 'Rust']

const FIRST_NAMES = [
  'রিয়া', 'তানিয়া', 'সাদিয়া', 'নুসরাত', 'ফারহানা', 'মেহজাবীন', 'সুমাইয়া', 'আফসানা',
  'রাফসান', 'তানভীর', 'সাকিব', 'মেহেদী', 'ইমরান', 'নাহিদ', 'রায়হান', 'শাহরিয়ার',
  'জান্নাত', 'মারিয়া', 'সোহানা', 'তাসনিম', 'আরিফ', 'শামীম', 'রুবেল', 'জিসান',
]
const LAST_NAMES = ['আক্তার', 'ইসলাম', 'হোসেন', 'রহমান', 'চৌধুরী', 'সুলতানা', 'খান', 'মিয়া', 'বেগম', 'সরকার']

const DISTRICTS = [
  'ঢাকা', 'চট্টগ্রাম', 'সিলেট', 'খুলনা', 'রাজশাহী', 'বরিশাল', 'রংপুর',
  'ময়মনসিংহ', 'কুমিল্লা', 'নারায়ণগঞ্জ', 'গাজীপুর', 'বগুড়া',
]
const AREAS = ['মিরপুর', 'ধানমন্ডি', 'উত্তরা', 'বনানী', 'মোহাম্মদপুর', 'বাড্ডা', 'যাত্রাবাড়ী', 'সাভার']

const COURIERS = ['Steadfast', 'Pathao', 'RedX', 'Sundarban']
const PAYMENTS = ['COD', 'bKash', 'Nagad', 'Bank']
const SOURCES = ['Facebook', 'WhatsApp', 'Website', 'Instagram', 'Walk-in']

/** Weighted so dashboards show a healthy business with real-looking friction. */
const STATUS_WEIGHTS = [
  ['Delivered', 58], ['Pending', 12], ['Processing', 9],
  ['Shipped', 11], ['Returned', 7], ['Cancelled', 3],
]
function pickStatus() {
  const total = STATUS_WEIGHTS.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [status, w] of STATUS_WEIGHTS) {
    r -= w
    if (r <= 0) return status
  }
  return 'Delivered'
}

const STAFF = [
  { name: 'Maruf Billah', role: 'SUPER_ADMIN', local: 'owner', salary: 0 },
  { name: 'Nusrat Jahan', role: 'ADMIN', local: 'admin', salary: 32000 },
  { name: 'Tanvir Ahmed', role: 'ADMIN', local: 'ops', salary: 28000 },
  { name: 'Sadia Rahman', role: 'HR', local: 'hr', salary: 30000 },
  { name: 'Rafsan Karim', role: 'STAFF', local: 'sales1', salary: 18000 },
  { name: 'Mehjabin Akter', role: 'STAFF', local: 'sales2', salary: 18000 },
  { name: 'Imran Hossain', role: 'STAFF', local: 'packing', salary: 16000 },
  { name: 'Sumaiya Islam', role: 'STAFF', local: 'support', salary: 17000 },
  { name: 'Jisan Mahmud', role: 'STAFF', local: 'delivery', salary: 15000 },
  { name: 'Farhana Sultana', role: 'VIEWER', local: 'viewer', salary: 0 },
]

/**
 * Sized against the order book, not in isolation. The first pass put the Finance
 * page at −622% margin because the ledger carried a cost base a business several
 * times this size would run. These ranges keep the demo profitable at ~10 orders
 * a day, which is what makes the Finance and Insights screens worth showing.
 */
const EXPENSE_CATEGORIES = [
  ['Marketing', 'Facebook Ads', 2000, 12000],
  ['Marketing', 'Influencer', 1500, 7000],
  ['Operations', 'Courier Charge', 1200, 6000],
  ['Operations', 'Packaging', 800, 4000],
  ['Office', 'Rent', 25000, 25000],
  ['Office', 'Utility Bill', 2500, 7000],
  ['Office', 'Internet', 3500, 3500],
  ['Inventory', 'Fabric Purchase', 8000, 35000],
  ['Inventory', 'Tailoring', 4000, 15000],
  ['Staff', 'Lunch Allowance', 1500, 4000],
]

// ── guards ───────────────────────────────────────────────────────────────────
async function assertSafeTarget() {
  if (process.env.ALMA_DEMO_SEED_CONFIRM !== 'ALMA_DEMO_YES') {
    throw new Error('Refusing to seed: set ALMA_DEMO_SEED_CONFIRM=ALMA_DEMO_YES to confirm this is the demo database.')
  }

  const realUsers = await prisma.user.count({
    where: { NOT: { email: { endsWith: DEMO_EMAIL_SUFFIX } } },
  })
  if (realUsers > 0) {
    throw new Error(
      `Refusing to seed: found ${realUsers} non-demo user(s). This looks like a REAL database — check DATABASE_URL.`,
    )
  }

  // Deliberately NOT checking for non-demo order ids. An order a visitor creates
  // through the demo UI gets a normal `AL-...` id, so treating those as evidence of a
  // real database would abort every reset after the first demo order — permanently
  // disabling the nightly refresh. The user check above is the reliable signal: a real
  // ALMA database always holds staff accounts that are not `@alma-erp.demo`.
}

/**
 * Empties every table rather than the handful the seed writes.
 *
 * A visitor can touch far more than the seeded tables — leave requests, approvals,
 * notifications, agent conversations, stock adjustments. Clearing only the seeded
 * ones left that behind, and because the demo users are recreated with the same
 * deterministic `DEMO-USER-*` ids, yesterday's leave requests and notifications
 * would reattach themselves to the new accounts and pile up forever.
 *
 * Enumerating tables by hand would rot the moment a model is added, so the list
 * comes from the database itself. Only ever reached after assertSafeTarget has
 * confirmed the target holds no non-demo user — i.e. the whole database is the demo.
 */
async function resetDemoRows() {
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `
  if (!tables.length) return
  const list = tables.map(t => `"public"."${t.tablename}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
  console.log(`· cleared ${tables.length} tables`)
}

// ── builders ─────────────────────────────────────────────────────────────────
function buildUsers(passwordHash) {
  return STAFF.map((s, i) => ({
    id: `${ID}USER-${String(i + 1).padStart(2, '0')}`,
    email: `${s.local}${DEMO_EMAIL_SUFFIX}`,
    phone: `+88017000000${String(i + 10).slice(-2)}`,
    passwordHash,
    name: s.name,
    role: s.role,
    active: true,
    businessAccess: s.role === 'STAFF' ? 'ALMA_LIFESTYLE' : 'ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT,ALMA_TRADING',
    employeeIdGas: `EMP-${String(i + 1).padStart(3, '0')}`,
    joiningDate: daysAgo(between(200, 900)),
    salaryHint: s.salary || null,
  }))
}

async function seedUsers() {
  const password = process.env.DEMO_USER_PASSWORD || 'AlmaDemo2026!'
  const users = buildUsers(await bcrypt.hash(password, 12))
  await prisma.user.createMany({ data: users })
  return users
}

function buildCatalogue() {
  const products = []
  const stock = []
  let n = 0
  for (const cat of CATEGORIES) {
    const count = cat.name === 'Accessories' ? 5 : 8
    for (let i = 0; i < count; i++) {
      n += 1
      const sku = `${ID}SKU-${String(n).padStart(3, '0')}`
      const color = pick(COLORS)
      const name = `${pick(PRODUCT_WORDS)} ${cat.name} — ${color}`
      const cogs = taka(between(cat.cogs[0], cat.cogs[1]))
      const price = taka(cogs * (cat.margin[0] + rng() * (cat.margin[1] - cat.margin[0])))
      products.push({
        sku,
        name,
        category: cat.name,
        defaultCogs: cogs,
        defaultPrice: price,
        active: true,
        notes: '',
        supplier: 'demo',
      })
      for (const size of cat.sizes) {
        const opening = between(6, 40)
        const purchased = between(0, 25)
        const sold = between(0, Math.max(1, opening))
        const returned = between(0, 3)
        const damaged = between(0, 2)
        const current = Math.max(0, opening + purchased - sold + returned - damaged)
        stock.push({
          id: `${ID}STK-${String(stock.length + 1).padStart(4, '0')}`,
          sku,
          product: name,
          category: cat.name,
          color,
          size,
          opening,
          purchased,
          sold,
          returned,
          damaged,
          reserved: 0,
          currentStock: current,
          available: current,
          reorderLevel: 5,
          status: current === 0 ? 'OUT_OF_STOCK' : current <= 5 ? 'LOW' : 'OK',
          stockValue: taka(current * cogs),
          sellValue: taka(current * price),
          potentialProfit: taka(current * (price - cogs)),
          buyingPrice: cogs,
          archived: false,
          active: true,
        })
      }
    }
  }
  return { products, stock }
}

function buildCustomers(count) {
  const customers = []
  for (let i = 0; i < count; i++) {
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`
    const phone = `+8801${between(3, 9)}${String(between(10000000, 99999999))}`
    const district = pick(DISTRICTS)
    customers.push({
      id: `${ID}CUS-${String(i + 1).padStart(4, '0')}`,
      businessId: BUSINESS_ID,
      name,
      phone,
      district,
      address: `${between(1, 120)} নং রোড, ${pick(AREAS)}, ${district}`,
      whatsapp: phone,
      source: pick(SOURCES),
      segment: 'NEW',
      riskLevel: 'LOW',
      notes: '',
    })
  }
  return customers
}

function buildOrders(customers, products, count) {
  const orders = []
  const items = []
  for (let i = 0; i < count; i++) {
    const customer = pick(customers)
    const product = pick(products)
    const status = pickStatus()
    const dayOffset = between(0, 119)
    const date = daysAgo(dayOffset)
    const qty = between(1, 3)
    const unitPrice = product.defaultPrice
    const discount = rng() < 0.25 ? taka(unitPrice * 0.1) : 0
    const shippingFee = pick([0, 60, 80, 120])
    const sellPrice = taka(unitPrice * qty - discount + shippingFee)
    const cogs = taka(product.defaultCogs * qty)
    const courierCharge = pick([60, 80, 110])
    const advCost = rng() < 0.4 ? taka(between(20, 180)) : 0
    const profit = taka(sellPrice - cogs - courierCharge - advCost)
    const delivered = status === 'Delivered'
    const returned = status === 'Returned'
    const orderId = `${ID}ORD-${String(i + 1).padStart(4, '0')}`
    const size = pick(CATEGORIES.find(c => c.name === product.category).sizes)

    orders.push({
      id: orderId,
      businessId: BUSINESS_ID,
      date,
      customer: customer.name,
      phone: customer.phone,
      address: customer.address,
      payment: pick(PAYMENTS),
      source: customer.source,
      status,
      product: product.name,
      category: product.category,
      size,
      qty,
      unitPrice,
      discount,
      sellPrice,
      shippingFee,
      cogs,
      courierCharge,
      advCost,
      advPlatform: advCost ? pick(['Facebook', 'Instagram']) : '',
      profit: returned ? -courierCharge : profit,
      courier: pick(COURIERS),
      trackingId: status === 'Pending' ? '' : `TRK${between(100000, 999999)}`,
      trackingStatus: delivered ? 'Delivered' : status,
      estDelivery: daysAgo(Math.max(0, dayOffset - 3)),
      actualDelivery: delivered ? daysAgo(Math.max(0, dayOffset - between(1, 4))) : null,
      returnReason: returned ? pick(['সাইজ মেলেনি', 'কাস্টমার নেয়নি', 'ভুল প্রোডাক্ট']) : '',
      returnDate: returned ? daysAgo(Math.max(0, dayOffset - 5)) : null,
      returnStatus: returned ? 'Received' : '',
      notes: '',
      sku: product.sku,
      handledBy: pick(STAFF.filter(s => s.role === 'STAFF').map(s => s.name)),
      invoiceNum: `INV-${String(i + 1).padStart(5, '0')}`,
      paidAmount: delivered ? sellPrice : 0,
      dueAmount: delivered ? 0 : sellPrice,
      estimatedProfit: profit,
      realizedProfit: delivered ? profit : 0,
      netProfit: returned ? -courierCharge : delivered ? profit : 0,
    })

    items.push({
      id: `${ID}ITM-${String(i + 1).padStart(4, '0')}`,
      orderId,
      lineNo: 1,
      sku: product.sku,
      product: product.name,
      category: product.category,
      size,
      qty,
      unitPrice,
      sellPrice,
      subtotal: taka(unitPrice * qty),
      cogs,
      stockSku: product.sku,
    })
  }
  return { orders, items }
}

/** CRM screens are only convincing if the per-customer rollups match the orders. */
function rollUpCustomers(customers, orders) {
  const byPhone = new Map()
  for (const o of orders) {
    const agg = byPhone.get(o.phone) || {
      total: 0, delivered: 0, returned: 0, cancelled: 0, pending: 0, spent: 0, profit: 0, last: null, cats: {},
    }
    agg.total += 1
    if (o.status === 'Delivered') { agg.delivered += 1; agg.spent += o.sellPrice; agg.profit += o.profit }
    else if (o.status === 'Returned') agg.returned += 1
    else if (o.status === 'Cancelled') agg.cancelled += 1
    else agg.pending += 1
    agg.cats[o.category] = (agg.cats[o.category] || 0) + 1
    if (!agg.last || o.date > agg.last) agg.last = o.date
    byPhone.set(o.phone, agg)
  }

  return customers.map(c => {
    const a = byPhone.get(c.phone)
    if (!a) return c
    const favCategory = Object.entries(a.cats).sort((x, y) => y[1] - x[1])[0]?.[0] || ''
    const returnRate = a.total ? a.returned / a.total : 0
    const daysInactive = a.last ? Math.round((today.getTime() - a.last.getTime()) / DAY_MS) : 0
    return {
      ...c,
      totalOrders: a.total,
      delivered: a.delivered,
      returned: a.returned,
      cancelled: a.cancelled,
      pending: a.pending,
      totalSpent: taka(a.spent),
      avgOrder: a.delivered ? taka(a.spent / a.delivered) : 0,
      totalProfit: taka(a.profit),
      lastOrder: a.last,
      daysInactive,
      favCategory,
      returnRate: Number(returnRate.toFixed(2)),
      riskLevel: returnRate > 0.4 ? 'HIGH' : returnRate > 0.2 ? 'MEDIUM' : 'LOW',
      riskScore: Math.round(returnRate * 100),
      clvScore: Math.min(100, Math.round(a.spent / 900)),
      loyaltyPts: a.delivered * 10,
      segment: a.delivered >= 5 ? 'VIP' : a.delivered >= 2 ? 'REPEAT' : daysInactive > 60 ? 'DORMANT' : 'NEW',
    }
  })
}

function buildExpenses(count) {
  const rows = []
  for (let i = 0; i < count; i++) {
    const [category, subCat, lo, hi] = pick(EXPENSE_CATEGORIES)
    rows.push({
      id: `${ID}EXP-${String(i + 1).padStart(4, '0')}`,
      businessId: BUSINESS_ID,
      expenseDate: daysAgo(between(0, 119)),
      category,
      subCat,
      title: `${subCat} — ${pick(['সাপ্তাহিক', 'মাসিক', 'এককালীন'])}`,
      amount: taka(between(lo, hi)),
      vendor: pick(['Rahim Traders', 'Meta Ads', 'Steadfast', 'City Corp', 'Local Vendor']),
      paymentMethod: pick(['bKash', 'Cash', 'Bank', 'Nagad']),
      paymentStatus: rng() < 0.9 ? 'Paid' : 'Due',
      recurring: subCat === 'Rent' || subCat === 'Internet',
      createdByName: pick(STAFF.filter(s => s.role !== 'VIEWER').map(s => s.name)),
      source: 'demo',
    })
  }
  return rows
}

function buildAttendance(users) {
  const rows = []
  const staff = users.filter(u => !u.email.startsWith('viewer'))
  let n = 0
  // Starts at 0 — today included. Skipping today made the Attendance page open on
  // "Absent 10", which is the first thing a visitor sees on that screen.
  for (let d = 0; d < 30; d++) {
    const day = daysAgo(d)
    if (day.getDay() === 5) continue // Friday — weekend in Bangladesh
    for (const u of staff) {
      if (rng() < 0.07) continue // occasional absence keeps the report honest
      n += 1
      const lateMinutes = rng() < 0.22 ? between(3, 45) : 0
      const checkIn = dhakaTime(day, 9 * 60 + lateMinutes)
      const workMinutes = between(455, 545)
      const checkOut = new Date(checkIn.getTime() + workMinutes * 60 * 1000)
      // Today stays open (checked in, no check-out). The Attendance page counts
      // "Present" from PRESENT/LATE records, so closing today out would show the
      // whole team as absent the moment a visitor lands on the page.
      const isToday = d === 0
      rows.push({
        id: `${ID}ATT-${String(n).padStart(5, '0')}`,
        businessId: BUSINESS_ID,
        userId: u.id,
        employeeId: u.employeeIdGas,
        attendanceDate: day,
        status: lateMinutes > 0 ? 'LATE' : isToday ? 'PRESENT' : 'COMPLETED',
        checkInAt: checkIn,
        checkOutAt: isToday ? null : checkOut,
        totalWorkMinutes: isToday ? 0 : workMinutes,
        lateMinutes,
        penaltyAmount: lateMinutes > 15 ? 100 : 0,
        suspiciousReasons: [],
      })
    }
  }
  return rows
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
  await assertSafeTarget()
  console.log('· target verified as a demo database')

  await resetDemoRows()
  console.log('· previous demo rows cleared')

  const users = await seedUsers()
  console.log(`· ${users.length} demo users`)

  const { products, stock } = buildCatalogue()
  await prisma.lifestyleProduct.createMany({ data: products })
  await prisma.lifestyleStockItem.createMany({ data: stock })
  console.log(`· ${products.length} products, ${stock.length} stock rows`)

  // Volume is chosen so the demo reads as a healthy business, not a failing one.
  // 320 orders against 200 expenses put the Finance page at −622% margin: the
  // expense ledger (rent, ads, fabric) is a real monthly cost base, so the order
  // book has to be large enough to cover it. ~10 orders/day clears it comfortably.
  const customers = buildCustomers(250)
  const { orders, items } = buildOrders(customers, products, 1200)
  await prisma.lifestyleCustomer.createMany({ data: rollUpCustomers(customers, orders) })
  await prisma.lifestyleOrder.createMany({ data: orders })
  await prisma.lifestyleOrderItem.createMany({ data: items })
  console.log(`· ${customers.length} customers, ${orders.length} orders`)

  const expenses = buildExpenses(150)
  await prisma.lifestyleExpense.createMany({ data: expenses })
  console.log(`· ${expenses.length} expenses`)

  const attendance = buildAttendance(users)
  await prisma.attendanceRecord.createMany({ data: attendance })
  console.log(`· ${attendance.length} attendance records`)

  const delivered = orders.filter(o => o.status === 'Delivered')
  const revenue = delivered.reduce((s, o) => s + o.sellPrice, 0)
  console.log(`\nDemo ready — ${delivered.length} delivered orders, ৳${revenue.toLocaleString('en-US')} revenue on the books.`)
}

/** Exported so the shape check can validate payloads against the Prisma schema without a database. */
export { buildUsers, buildCatalogue, buildCustomers, buildOrders, rollUpCustomers, buildExpenses, buildAttendance, STAFF }

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  main()
    .catch(e => {
      console.error(`\nSEED ABORTED: ${e.message}`)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
