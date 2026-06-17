/**
 * Phase G self-verify — toggle staff_morale OFF/ON against live DB.
 * Usage: npx tsx --env-file=.env.local scripts/verify-duty-enabled.ts
 */
import {
  setDutyEnabled,
  isDutyEnabled,
  getDutyEnabledMap,
  enabledDutiesForToday,
  cancelTodayDutyTodo,
} from '../src/agent/lib/duty-enabled'

const TEST = 'staff_morale'

async function main() {
  const before = await enabledDutiesForToday()
  console.log('before count', before.length, 'morale enabled', await isDutyEnabled(TEST))

  await setDutyEnabled(TEST, false)
  const map = await getDutyEnabledMap()
  console.log('KV after OFF', JSON.stringify(map))
  if (map[TEST] !== false) throw new Error('KV not updated')
  if (await isDutyEnabled(TEST)) throw new Error('still enabled after OFF')

  const afterOff = await enabledDutiesForToday()
  console.log('after OFF count', afterOff.length, 'delta', before.length - afterOff.length)
  if (afterOff.length !== before.length - 1) throw new Error('roster count wrong after OFF')

  const cancelled = await cancelTodayDutyTodo(TEST)
  console.log('todos cancelled', cancelled)

  await setDutyEnabled(TEST, true)
  if (!(await isDutyEnabled(TEST))) throw new Error('still disabled after ON')
  const afterOn = await enabledDutiesForToday()
  console.log('after ON count', afterOn.length)
  if (afterOn.length !== before.length) throw new Error('roster count wrong after ON')

  console.log('PASS — duty_enabled KV toggle verified')
}

main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
