import { prisma } from '@/lib/prisma'

const db = prisma as any

export interface StaffContext {
  staffName: string
  staffId: string
  yesterdayCompletion: number
  todayTaskCount: number
  recentMood: 'positive' | 'neutral' | 'struggling' | 'unknown'
  dayOfWeek: string
  isRamadan: boolean
  consecutiveGoodDays: number
}

export async function buildStaffContext(staffId: string, staffName: string): Promise<StaffContext> {
  const now = new Date()
  const dhakaDay = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Dhaka' }).toLowerCase()
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  let yesterdayCompletion = 0
  let todayTaskCount = 0
  let consecutiveGoodDays = 0

  try {
    const yesterdayTasks = await db.agentStaffTask.findMany({
      where: { staffId, dutyDate: yesterday },
      select: { status: true },
    })
    const done = yesterdayTasks.filter((t: any) => ['done', 'done_verified'].includes(t.status)).length
    yesterdayCompletion = yesterdayTasks.length > 0 ? Math.round((done / yesterdayTasks.length) * 100) : 0

    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    const todayTasks = await db.agentStaffTask.findMany({
      where: { staffId, dutyDate: today },
      select: { id: true },
    })
    todayTaskCount = todayTasks.length

    for (let i = 1; i <= 7; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
      const tasks = await db.agentStaffTask.findMany({
        where: { staffId, dutyDate: d },
        select: { status: true },
      })
      if (tasks.length === 0) break
      const doneCount = tasks.filter((t: any) => ['done', 'done_verified'].includes(t.status)).length
      if ((doneCount / tasks.length) >= 0.7) consecutiveGoodDays++
      else break
    }
  } catch { /* fallback to defaults */ }

  let recentMood: StaffContext['recentMood'] = 'unknown'
  try {
    const recentFeedback = await db.agentOutbox.findMany({
      where: { staffId, type: 'feedback_ack', createdAt: { gte: new Date(Date.now() - 3 * 86_400_000).toISOString() } },
      select: { content: true },
      take: 3,
      orderBy: { createdAt: 'desc' },
    })
    if (recentFeedback.length > 0) {
      const text = recentFeedback.map((f: any) => f.content).join(' ').toLowerCase()
      if (text.includes('সমস্যা') || text.includes('পারছি না') || text.includes('কঠিন')) recentMood = 'struggling'
      else if (text.includes('ভালো') || text.includes('ধন্যবাদ') || text.includes('হয়ে গেছে')) recentMood = 'positive'
      else recentMood = 'neutral'
    }
  } catch { /* non-fatal */ }

  return {
    staffName,
    staffId,
    yesterdayCompletion,
    todayTaskCount,
    recentMood,
    dayOfWeek: dhakaDay,
    isRamadan: false,
    consecutiveGoodDays,
  }
}

/**
 * Generate a human-like greeting for a staff member based on their context.
 * Replaces the static template greeting with contextual, warm messages.
 */
export function generateContextualGreeting(ctx: StaffContext): string {
  const name = ctx.staffName.split(' ')[0]
  const greetings: string[] = []

  if (ctx.dayOfWeek === 'friday') {
    greetings.push(`জুম্মা মুবারক ${name} ভাই! 🤲`)
  } else if (ctx.dayOfWeek === 'saturday') {
    greetings.push(`আস্সালামু আলাইকুম ${name} ভাই! উইকেন্ড শুরু — তবুও কাজের spirit ধরে রাখি 💪`)
  } else {
    greetings.push(`আস্সালামু আলাইকুম ${name} ভাই!`)
  }

  if (ctx.yesterdayCompletion >= 90) {
    greetings.push(`গতকাল ${ctx.yesterdayCompletion}% কাজ শেষ করেছো — দারুণ! 🌟`)
  } else if (ctx.yesterdayCompletion >= 70) {
    greetings.push(`গতকাল ভালো কাজ হয়েছে, আজকেও এভাবেই চালিয়ে যাও।`)
  } else if (ctx.yesterdayCompletion > 0 && ctx.yesterdayCompletion < 50) {
    greetings.push(`গতকাল কিছু কাজ বাকি ছিল — আজকে একটু extra effort দিলে সব ঠিক হয়ে যাবে ইনশাআল্লাহ।`)
  }

  if (ctx.consecutiveGoodDays >= 3) {
    greetings.push(`${ctx.consecutiveGoodDays} দিন ধরে দারুণ পারফর্ম করছো — keep it up! 🔥`)
  }

  if (ctx.recentMood === 'struggling') {
    greetings.push(`কোনো সমস্যা থাকলে জানাও — একসাথে সমাধান করবো।`)
  }

  return greetings.join('\n')
}

/**
 * Generate human-like task count introduction instead of static format.
 */
export function generateContextualTaskIntro(ctx: StaffContext, taskCount: number): string {
  if (taskCount <= 3) {
    return `আজকে তোমার জন্য ${taskCount}টা কাজ আছে — হালকা দিন! 😊`
  } else if (taskCount <= 6) {
    return `আজকে ${taskCount}টা কাজ আছে — ভালোভাবে organize করে একটা একটা করে গেলে সহজেই শেষ হবে।`
  } else {
    return `আজকে একটু busy দিন — ${taskCount}টা কাজ। গুরুত্বপূর্ণ গুলো আগে শেষ করো, বাকিগুলো naturally হয়ে যাবে।`
  }
}
