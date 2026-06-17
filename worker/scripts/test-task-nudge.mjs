#!/usr/bin/env node
import {
  getTaskNudgeCount,
  staffTaskNudgeMessage,
  formatOwnerEscalation,
  MAX_STAFF_NUDGES,
} from '../src/staff/task-nudge.mjs'

if (getTaskNudgeCount({ nudgeCount: 1 }) !== 1) throw new Error('nudgeCount parse fail')
if (getTaskNudgeCount({ reminderSentAt: 'x' }) !== 1) throw new Error('legacy reminderSentAt fail')
if (!staffTaskNudgeMessage('Test task').includes('Done')) throw new Error('nudge msg fail')
const line = formatOwnerEscalation({
  staffName: 'Eyafi',
  title: 'Photo shoot',
  reason: '২টা reminder',
  recommendation: 'Follow up.',
})
if (!line.includes('Eyafi') || !line.includes('Follow up')) throw new Error('owner line fail')
if (MAX_STAFF_NUDGES !== 2) throw new Error('max nudges')
console.log('✅ task-nudge helpers OK')
