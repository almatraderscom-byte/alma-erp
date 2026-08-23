import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { INVENTORY_ROWS } from '@/agent/tools/registry/inventory.data'
import {
  activeToolInventoryFingerprint,
  DOMAIN_REFERENCE_POLICY,
  REVIEWED_ACTIVE_TOOL_FINGERPRINT,
  TOOL_EXTRACT_OVERRIDES,
  TOOL_REFERENCE_COVERAGE,
  TOOL_REFERENCE_COVERAGE_COUNTS,
} from '../coverage-manifest'
import {
  ROUTE_REFERENCE_COVERAGE,
  ROUTE_REFERENCE_COVERAGE_COUNTS,
} from '../route-coverage'
import {
  INTERNAL_ENTITY_REGISTRY,
  INTERNAL_SECTION_REGISTRY,
} from '../internal-registry'

const requiredNamespaces = [
  'order', 'lifestyle_employee', 'cdit_employee', 'trading_employee',
  'agent_staff', 'staff_task', 'operational_task', 'open_task', 'owner_todo',
  'approval_request', 'agent_pending_action', 'product', 'sku', 'variant',
  'stock_item', 'customer', 'cs_customer', 'cdit_client', 'cdit_project', 'invoice',
  'cdit_invoice', 'expense', 'finance_entry', 'attendance_record',
  'leave_request', 'payroll_run', 'trading_account', 'trade', 'settlement',
  'growth_recommendation', 'growth_event', 'ads_event', 'creative_project',
  'creative_asset', 'media_project', 'agent_project', 'workflow_run',
  'action_run', 'artifact', 'notification', 'agent_notification', 'call',
  'scheduled_call', 'reminder', 'bill', 'appointment', 'document', 'plan',
  'finding',
] as const

describe('AgentReferenceV1 machine-readable coverage gates', () => {
  it('classifies every active tool exactly once with a reviewed reason', () => {
    const inventoryNames = INVENTORY_ROWS.map((row) => row.name)
    const coveredNames = TOOL_REFERENCE_COVERAGE.map((entry) => entry.tool)

    expect(INVENTORY_ROWS).toHaveLength(360)
    expect(TOOL_REFERENCE_COVERAGE).toHaveLength(INVENTORY_ROWS.length)
    expect(new Set(coveredNames).size).toBe(coveredNames.length)
    expect([...coveredNames].sort()).toEqual([...inventoryNames].sort())
    expect(TOOL_REFERENCE_COVERAGE.every((entry) => entry.reason.trim().length >= 12)).toBe(true)
    expect(Object.values(TOOL_REFERENCE_COVERAGE_COUNTS).reduce((sum, value) => sum + value, 0)).toBe(360)
    expect(activeToolInventoryFingerprint(INVENTORY_ROWS)).toBe(REVIEWED_ACTIVE_TOOL_FINGERPRINT)
  })

  it('has no silent domain default and no dead extractor override', () => {
    const inventoryDomains = new Set(INVENTORY_ROWS.map((row) => row.domain))
    expect(new Set(Object.keys(DOMAIN_REFERENCE_POLICY))).toEqual(inventoryDomains)

    const inventoryNames = new Set(INVENTORY_ROWS.map((row) => row.name))
    for (const [tool, override] of Object.entries(TOOL_EXTRACT_OVERRIDES)) {
      expect(inventoryNames.has(tool), `${tool} override must name an active tool`).toBe(true)
      expect(override.reason.trim()).not.toBe('')
      if (override.fallbackSection) {
        expect(Object.prototype.hasOwnProperty.call(INTERNAL_SECTION_REGISTRY, override.fallbackSection)).toBe(true)
      }
    }
  })

  it('keeps all required exact namespaces distinct and route-safe', () => {
    expect(Object.keys(INTERNAL_ENTITY_REGISTRY)).toEqual(expect.arrayContaining(requiredNamespaces as unknown as string[]))
    expect(new Set(Object.values(INTERNAL_ENTITY_REGISTRY).map((entry) => entry.namespace)).size)
      .toBe(Object.keys(INTERNAL_ENTITY_REGISTRY).length)

    for (const [namespace, entry] of Object.entries(INTERNAL_ENTITY_REGISTRY)) {
      expect(entry.namespace).toBe(namespace)
      expect(Object.prototype.hasOwnProperty.call(INTERNAL_SECTION_REGISTRY, entry.fallbackSection)).toBe(true)
    }
    for (const section of Object.values(INTERNAL_SECTION_REGISTRY)) {
      expect(section.webPath).toMatch(/^\/(?!\/)/)
      expect(section.nativePath).toMatch(/^\/(?!\/)/)
      expect(['internal_native', 'protected_web']).toContain(section.openMode)
    }
  })

  it('classifies every operational web route exactly once and keeps it in the iOS contract', () => {
    const root = path.resolve(process.cwd())
    const discovered = execFileSync('find', ['src/app', '-name', 'page.tsx', '-print'], {
      cwd: root,
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean).map((file) => {
      const route = file.replace(/^src\/app/, '').replace(/\/page\.tsx$/, '')
      return route || '/'
    }).sort()
    const covered = ROUTE_REFERENCE_COVERAGE.map((entry) => entry.route)
    expect(discovered).toHaveLength(90)
    expect(ROUTE_REFERENCE_COVERAGE).toHaveLength(discovered.length)
    expect(new Set(covered).size).toBe(covered.length)
    expect(covered).toEqual(discovered)
    expect(ROUTE_REFERENCE_COVERAGE.every((entry) => entry.reason.trim().length >= 12)).toBe(true)
    expect(Object.values(ROUTE_REFERENCE_COVERAGE_COUNTS).reduce((sum, value) => sum + value, 0)).toBe(90)
    for (const entry of ROUTE_REFERENCE_COVERAGE) {
      if (entry.classification === 'section') {
        expect(Object.prototype.hasOwnProperty.call(INTERNAL_SECTION_REGISTRY, entry.fallbackSection!)).toBe(true)
      } else {
        expect(entry.fallbackSection).toBeUndefined()
      }
    }

    const output = execFileSync(process.execPath, ['scripts/iosp0-route-contract-check.mjs'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(output).toContain('ROUTE CONTRACT OK:')
    expect(output).toContain('94 fixture routes cover 90 web routes')
  })
})
