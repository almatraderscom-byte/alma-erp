import { describe, it, expect } from 'vitest'


/**
 * Review-bot P2 (#667 round 17): the family map named tools that do not exist
 * (`send_staff_message`, `notify_staff`, `publish_page`, …) while omitting real
 * ones. An invented name reads like coverage and grants nothing, so the map is
 * now checked against the registry itself.
 */
describe('every mapped family names only registered tools', () => {
  it('has no phantom tool in the tool to family map', async () => {
    const [{ TOOL_TASK_CLASS }, { TOOLS, PERSONAL_SAFE_TOOLS, TRADING_TOOLS }, { INVENTORY_ROWS }] =
      await Promise.all([
        import('@/agent/lib/autonomy-task-catalog'),
        import('@/agent/tools/registry'),
        import('@/agent/tools/registry/inventory.data'),
      ])
    // The surface is spread over several arrays plus the generated inventory —
    // a name counts as real if ANY of them defines it.
    const registered = new Set([
      ...TOOLS.map((t) => t.name),
      ...PERSONAL_SAFE_TOOLS.map((t) => t.name),
      ...TRADING_TOOLS.map((t) => t.name),
      ...INVENTORY_ROWS.map((r) => r.name),
    ])
    const phantom = Object.entries(TOOL_TASK_CLASS)
      .filter(([name]) => !registered.has(name))
      .map(([name, family]) => `${family}:${name}`)
    expect(phantom).toEqual([])
  })

  it('maps the staff task writes Boss would expect a staff grant to cover', async () => {
    const { taskClassForTool } = await import('@/agent/lib/autonomy-task-catalog')
    for (const name of ['set_staff_task_due', 'update_staff_task_status', 'add_staff_task_now']) {
      const tc = taskClassForTool(name, { mode: 'write', risk: 'high', domain: 'staff' })
      expect(tc.taskClass).toBe('staff-messaging')
      expect(tc.explicit).toBe(true)
    }
  })
})

/** Review-bot P2 (#667 round 21): a grant that changes nothing must be refused. */
describe('a family is grantable only if a grant would change something', () => {
  it('refuses ads-budget, whose tools all stage their own card', async () => {
    const { familyGrantHasEffect } = await import('@/agent/lib/autonomy-task-catalog')
    expect(familyGrantHasEffect('ads-budget')).toBe(false)
  })

  it('accepts the families that do have card-free writes', async () => {
    const { familyGrantHasEffect } = await import('@/agent/lib/autonomy-task-catalog')
    for (const family of ['staff-messaging', 'customer-messaging', 'memory-notes', 'personal-records']) {
      expect(familyGrantHasEffect(family)).toBe(true)
    }
  })
})
