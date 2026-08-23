/**
 * Access contract — the web's role × business rules, frozen into
 * ios/access-contract.json so the native Swift port (ios/App/App/AlmaAccess.swift,
 * asserted by AppParityV2Tests/AccessContractTests.swift) can be proven equal.
 *
 * The fixture is GENERATED from the real src/lib/roles.ts + businesses.ts here —
 * never hand-edited. Changing a web rule makes this test fail until you run:
 *
 *   npm run access-contract:update
 *
 * …and the Swift test then names the exact role/business/path that drifted.
 * (The Android port rotted silently without this: its /settings/notifications
 * rule no longer matched the web.)
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ALMA_ROLE_OPTIONS,
  filterNavByRole,
  isPathAllowedForRole,
  roleHomePath,
  can,
  type AlmaRole,
} from '@/lib/roles'
import { BUSINESSES, getNavForBusiness, isRouteAllowed, type BusinessId } from '@/lib/businesses'
import { ALL_BUSINESS_IDS, parseBusinessAccess } from '@/lib/business-access'

const ROOT = resolve(__dirname, '../../..')
const FIXTURE = join(ROOT, 'ios/access-contract.json')

const ROLES = ALMA_ROLE_OPTIONS.map(r => r.id) as AlmaRole[]
const BUSINESSES_IDS = ALL_BUSINESS_IDS as BusinessId[]

// `can(role, cap)` is typed against the private CAPABILITIES table; enumerate
// the keys here so a new capability must be added to BOTH lists (the Swift
// test asserts the fixture's key set equals AlmaCapability.allCases).
const CAPABILITIES = [
  'ordersAdvanceStatus', 'ordersEditTracking', 'ordersEditField', 'ordersGenerateInvoice',
  'ordersDeleteOrCancel', 'crmWrite', 'inventoryWrite', 'expenseWrite', 'payrollWrite',
  'employeeWrite', 'brandingWrite', 'analyticsView', 'cditAdminWrite', 'userManage',
  'advanceApprove',
] as const

/** Every Next.js page route (mirrors scripts/iosp0-route-contract-check.mjs). */
function webRoutes(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (!statSync(p).isDirectory()) {
      if (/^page\.(tsx|ts|jsx)$/.test(name)) out.push(prefix === '' ? '/' : prefix)
      continue
    }
    if (name === 'api') continue
    const seg = name.startsWith('(') ? '' : `/${name}`
    out.push(...webRoutes(p, prefix + seg))
  }
  return out
}

/** Dynamic-segment samples so the port's prefix rules are exercised too. */
const DYNAMIC_SAMPLES = [
  '/employees/EMP-51', '/digital/clients/abc', '/trading/accounts/acc-1',
  '/invoice/share/tok-1', '/orders/new', '/finance/office-fund', '/finance/personal-ledger',
  '/portal/wallet', '/portal/expense', '/portal/payment-accounts', '/agent/hub',
  '/agent/creative-studio', '/agent/growth', '/agent/staff-monitor', '/agent/live-watch',
  '/api/business-archive', '/login', '/forgot-password', '/reset-password',
  '/inventory/supplier-import', '/operations/system-diagnostics', '/dashboard',
]

export function buildAccessContract() {
  const navHrefs = new Set<string>()
  for (const b of BUSINESSES_IDS) for (const n of getNavForBusiness(b)) navHrefs.add(n.href)
  const pages = webRoutes(join(ROOT, 'src/app'))
    .map(p => p.replace(/\/\[[^\]]+\]/g, '/sample'))   // /employees/[id] → /employees/sample
  const paths = [...new Set([...navHrefs, ...pages, ...DYNAMIC_SAMPLES])].sort()

  const matrix: Record<string, Record<string, boolean>> = {}
  const filteredNav: Record<string, string[]> = {}
  const roleHome: Record<string, string> = {}
  for (const role of ROLES) {
    for (const business of BUSINESSES_IDS) {
      const key = `${role}|${business}`
      matrix[key] = Object.fromEntries(paths.map(p => [p, isPathAllowedForRole(p, role, business)]))
      filteredNav[key] = filterNavByRole(getNavForBusiness(business), role, business).map(n => n.href)
      roleHome[key] = roleHomePath(role, business)
    }
  }
  const routeAllowed: Record<string, Record<string, boolean>> = {}
  for (const business of BUSINESSES_IDS) {
    routeAllowed[business] = Object.fromEntries(paths.map(p => [p, isRouteAllowed(p, business)]))
  }
  const nav: Record<string, { href: string; icon: string; label: string }[]> = {}
  for (const business of BUSINESSES_IDS) {
    nav[business] = getNavForBusiness(business).map(n => ({ href: n.href, icon: n.icon, label: n.label }))
  }
  const capabilities: Record<string, string[]> = {}
  for (const cap of CAPABILITIES) {
    capabilities[cap] = ROLES.filter(r => can(r, cap))
  }
  const businesses = BUSINESSES_IDS.map(id => ({
    id,
    name: BUSINESSES[id].name,
    shortName: BUSINESSES[id].shortName,
    tagline: BUSINESSES[id].tagline,
    brandInitial: BUSINESSES[id].brandInitial,
    homePath: BUSINESSES[id].homePath,
  }))
  const businessAccessSamples: Record<string, string[]> = {
    '': parseBusinessAccess(''),
    'ALMA_TRADING': parseBusinessAccess('ALMA_TRADING'),
    'ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT': parseBusinessAccess('ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT'),
    'BOGUS': parseBusinessAccess('BOGUS'),
    ' ALMA_TRADING , BOGUS ': parseBusinessAccess(' ALMA_TRADING , BOGUS '),
  }

  return {
    version: 1,
    source: ['src/lib/roles.ts', 'src/lib/businesses.ts', 'src/lib/business-access.ts'],
    generatedBy: 'npm run access-contract:update (src/lib/__tests__/access-contract.test.ts)',
    roles: ROLES,
    businesses,
    paths,
    routeAllowed,
    matrix,
    nav,
    filteredNav,
    roleHome,
    capabilities,
    businessAccessSamples,
  }
}

describe('access contract (web ⇄ iOS)', () => {
  it('ios/access-contract.json matches the live web rules', () => {
    const fresh = buildAccessContract()
    const serialized = JSON.stringify(fresh, null, 2) + '\n'
    if (process.env.UPDATE_ACCESS_CONTRACT === '1') {
      writeFileSync(FIXTURE, serialized)
    }
    expect(existsSync(FIXTURE), 'fixture missing — run: npm run access-contract:update').toBe(true)
    const onDisk = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    expect(onDisk, 'ios/access-contract.json is stale — run: npm run access-contract:update').toEqual(fresh)
  })

  it('sanity: the rules the owner relies on hold', () => {
    expect(isPathAllowedForRole('/agent', 'ADMIN', 'ALMA_LIFESTYLE')).toBe(false)
    expect(isPathAllowedForRole('/orders', 'STAFF', 'ALMA_TRADING')).toBe(false)
    expect(isPathAllowedForRole('/trading/telegram', 'STAFF', 'ALMA_TRADING')).toBe(true)
    expect(isPathAllowedForRole('/', 'HR', 'ALMA_LIFESTYLE')).toBe(false)
    expect(roleHomePath('HR', 'ALMA_LIFESTYLE')).toBe('/employees')
  })
})
