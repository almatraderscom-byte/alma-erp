import { prisma } from '@/lib/prisma'

const db = prisma as any

export interface SmartTaskBrief {
  type: string
  title: string
  detail: string
  difficulty: 'basic' | 'intermediate' | 'advanced'
  estimatedMinutes: number
  verificationCriteria: string[]
  stepByStep: string[]
}

interface TaskTemplate {
  title: string
  detail: string
  steps: string[]
  verify: string[]
  minutes: number
}

const TASK_TEMPLATES: Record<string, Record<string, TaskTemplate>> = {
  video_reel: {
    basic: {
      title: '{product} — ১৫ সেকেন্ড সাধারণ ভিডিও',
      detail: 'প্রোডাক্ট হাতে ধরে দেখান, ঘুরিয়ে দেখান, দাম বলুন। CapCut-এ সিম্পল text যোগ করুন।',
      steps: [
        '১. প্রোডাক্ট ভালো আলোতে রাখুন',
        '২. ফোন দিয়ে ১৫ সেকেন্ড ভিডিও করুন — হাতে ধরে ঘোরান',
        '৩. CapCut-এ open করুন, product name + price text যোগ করুন',
        '৪. Export করে owner-কে পাঠান',
      ],
      verify: ['ভিডিও ১৫-৩০ সেকেন্ড', 'প্রোডাক্ট clear দেখা যাচ্ছে', 'দাম/নাম text আছে'],
      minutes: 30,
    },
    intermediate: {
      title: '{product} — ৩০ সেকেন্ড রিল (transition + music)',
      detail: 'প্রোডাক্ট showcase রিল — trending audio সহ, CapCut transition দিয়ে।',
      steps: [
        '১. ৩-৪টা আলাদা angle-এ ক্লিপ নিন (close-up, full, wearing, flat lay)',
        '২. CapCut-এ import করে trending transition ব্যবহার করুন',
        '৩. Trending audio যোগ করুন + text overlay (product name, price, offer)',
        '৪. ১০৮০×১৯২০ export করুন',
      ],
      verify: ['৩০ সেকেন্ডের মধ্যে', 'Multiple angles আছে', 'Audio আছে', 'Text readable'],
      minutes: 45,
    },
    advanced: {
      title: '{product} — ক্রিয়েটিভ রিল (storytelling)',
      detail: 'Storytelling approach: problem → product solution → call to action। Professional editing।',
      steps: [
        '১. Script লিখুন: কোন সমস্যা → এই product কীভাবে solve করে',
        '২. B-roll + product shots মিক্স করুন',
        '৩. CapCut-এ color correction, smooth transitions, trending audio',
        '৪. CTA text: "Order now" / "DM করুন"',
      ],
      verify: ['Story structure আছে', 'Professional editing', 'CTA clear', '30-60 sec'],
      minutes: 60,
    },
  },
  product_photo: {
    basic: {
      title: '{product} — ৪টি প্রোডাক্ট ছবি (সাদা ব্যাকগ্রাউন্ড)',
      detail: 'সাদা/পরিষ্কার ব্যাকগ্রাউন্ডে ৪ angle: সামনে, পেছনে, close-up detail, full product।',
      steps: [
        '১. সাদা কাগজ/কাপড় পেছনে রাখুন',
        '২. ভালো আলোতে (জানালার পাশে) রাখুন',
        '৩. ৪টি angle-এ ছবি তুলুন: সামনে, পেছনে, close-up, full',
        '৪. ছবি crop করে owner-কে পাঠান',
      ],
      verify: ['ব্যাকগ্রাউন্ড পরিষ্কার', 'আলো ভালো', '৪টি angle আছে', 'Product clear'],
      minutes: 20,
    },
    intermediate: {
      title: '{product} — স্টাইল ফটোশুট (lifestyle)',
      detail: 'প্রোডাক্ট lifestyle setting-এ — styled, props সহ।',
      steps: [
        '১. Setting তৈরি করুন (হ্যাঙ্গার, ফুল, accessories)',
        '২. Natural light ব্যবহার করুন',
        '৩. ৫-৬টি ছবি different styling-এ',
        '৪. Best ৩টা select করে edit করুন (brightness, contrast)',
      ],
      verify: ['Styled composition', 'Good lighting', 'Multiple variations', 'Edited'],
      minutes: 40,
    },
  },
  ad_creative: {
    basic: {
      title: '{product} — Canva-তে সাধারণ অ্যাড পোস্ট',
      detail: 'Canva template ব্যবহার করে product photo + price + offer text সহ একটি square পোস্ট।',
      steps: [
        '১. Canva open করুন, "Instagram Post" size select করুন',
        '২. একটি সাধারণ template choose করুন',
        '৩. Product photo add করুন',
        '৪. Product name, price, আর "Order: DM করুন" text যোগ করুন',
        '৫. ALMA Lifestyle logo/watermark যোগ করুন',
        '৬. PNG download করে owner-কে পাঠান',
      ],
      verify: ['Product photo আছে', 'Price আছে', 'CTA আছে', 'Brand visible'],
      minutes: 25,
    },
    intermediate: {
      title: '{product} — অ্যাড ক্রিয়েটিভ (square + story)',
      detail: 'FB/Insta ad creative — 1080×1080 (feed) + 1080×1920 (story) দুটোই।',
      steps: [
        '১. Feed version: product hero shot, headline, price, CTA',
        '২. Story version: same content vertical layout',
        '৩. Color scheme: brand colors ব্যবহার করুন',
        '৪. দুটো version export করুন',
      ],
      verify: ['দুটো size আছে', 'Consistent branding', 'CTA clear', 'Text readable'],
      minutes: 40,
    },
  },
  product_content: {
    basic: {
      title: '{product} — FB পোস্ট caption (Bangla)',
      detail: 'Product-এর জন্য আকর্ষণীয় Bangla caption — features, price, order info সহ।',
      steps: [
        '১. Product-এর ৩টি main feature লিখুন',
        '২. Price এবং offer (যদি থাকে) mention করুন',
        '৩. "অর্ডার করতে DM করুন / কমেন্ট করুন" CTA দিন',
        '৪. ৫-৭টি relevant hashtag যোগ করুন',
      ],
      verify: ['Features mentioned', 'Price আছে', 'CTA আছে', 'Hashtags আছে'],
      minutes: 15,
    },
  },
  listing_update: {
    basic: {
      title: '{product} — FB shop/Daraz listing আপডেট',
      detail: 'Product listing-এ updated ছবি, সঠিক দাম, ও বিবরণ নিশ্চিত করুন।',
      steps: [
        '১. FB shop-এ product খুঁজুন',
        '২. ছবি আপডেট করুন (আজকের নতুন ছবি থাকলে)',
        '৩. দাম সঠিক কিনা চেক করুন',
        '৪. বিবরণ পড়ুন — ভুল থাকলে ঠিক করুন',
      ],
      verify: ['ছবি updated', 'দাম সঠিক', 'বিবরণ accurate'],
      minutes: 15,
    },
  },
  page_management: {
    basic: {
      title: 'FB Page চেক — comments reply + inbox check',
      detail: 'Alma Lifestyle FB page-এ unreplied comments ও inbox messages reply দিন।',
      steps: [
        '১. FB page-এ যান, recent posts-এ comments check করুন',
        '২. Product query comments-এ reply দিন (price, availability)',
        '৩. Inbox check করুন — unread messages reply দিন',
        '৪. Story section check করুন — আজকের story queue plan করুন',
      ],
      verify: ['সব comments replied', 'Inbox checked', 'Story planned'],
      minutes: 30,
    },
  },
  customer_reply: {
    basic: {
      title: 'Messenger inbox — সব unread reply দিন',
      detail: 'Alma Lifestyle ও Alma Online Shop — সব unread customer messages reply দিন।',
      steps: [
        '১. Messenger inbox open করুন',
        '২. Unread messages filter করুন',
        '৩. Product query → price + availability বলুন',
        '৪. Order query → status check করে জানান',
        '৫. ২৪ ঘণ্টার পুরনো messages-এ priority দিন (Meta window)',
      ],
      verify: ['সব unread replied', 'Correct info দেওয়া', 'Professional tone'],
      minutes: 30,
    },
  },
}

export function generateSmartTask(
  staffName: string,
  taskType: string,
  productName: string | null,
  completionRate: number,
): SmartTaskBrief {
  const templates = TASK_TEMPLATES[taskType]
  if (!templates) {
    return {
      type: taskType,
      title: `${productName ?? 'General'} — ${taskType}`,
      detail: 'কাজটি সম্পূর্ণ করুন এবং proof পাঠান।',
      difficulty: 'basic',
      estimatedMinutes: 30,
      verificationCriteria: ['কাজ সম্পূর্ণ হয়েছে'],
      stepByStep: [],
    }
  }

  let level: 'basic' | 'intermediate' | 'advanced' = 'basic'
  if (completionRate >= 85) level = 'advanced'
  else if (completionRate >= 65) level = 'intermediate'

  const template = templates[level] ?? templates.intermediate ?? templates.basic
  if (!template) {
    return {
      type: taskType,
      title: `${productName ?? ''} — ${taskType}`,
      detail: '',
      difficulty: 'basic',
      estimatedMinutes: 30,
      verificationCriteria: [],
      stepByStep: [],
    }
  }

  const product = productName ?? 'পণ্য'
  return {
    type: taskType,
    title: template.title.replace('{product}', product),
    detail: template.detail,
    difficulty: level,
    estimatedMinutes: template.minutes,
    verificationCriteria: template.verify,
    stepByStep: template.steps,
  }
}

export interface ProofFeedback {
  passed: boolean
  criteriaResults: { criterion: string; passed: boolean; feedback: string }[]
  overallFeedback: string
  improvementTips: string[]
}

export function generateProofFeedback(
  taskType: string,
  verificationCriteria: string[],
  passedCriteria: boolean[],
): ProofFeedback {
  const criteriaResults = verificationCriteria.map((criterion, i) => {
    const passed = passedCriteria[i] ?? false
    const feedback = passed ? '✅' : generateImprovementHint(taskType, criterion)
    return { criterion, passed, feedback }
  })

  const passCount = criteriaResults.filter(c => c.passed).length
  const totalCount = criteriaResults.length
  const passed = totalCount === 0 || passCount >= Math.ceil(totalCount * 0.7)

  const failedCriteria = criteriaResults.filter(c => !c.passed)
  const improvementTips = failedCriteria.map(c => c.feedback).filter(Boolean)

  let overallFeedback: string
  if (passed && failedCriteria.length === 0) {
    overallFeedback = '✅ চমৎকার! সব criteria পূরণ হয়েছে।'
  } else if (passed) {
    overallFeedback = `👍 ভালো কাজ! ${passCount}/${totalCount} criteria পূরণ। কিছু জায়গায় আরেকটু ভালো করা যায়।`
  } else {
    overallFeedback = `⚠️ ${passCount}/${totalCount} criteria পূরণ হয়েছে। নিচের বিষয়গুলো ঠিক করুন।`
  }

  return { passed, criteriaResults, overallFeedback, improvementTips }
}

function generateImprovementHint(taskType: string, failedCriterion: string): string {
  const criterion = failedCriterion.toLowerCase()

  if (criterion.includes('আলো') || criterion.includes('lighting')) {
    return 'ছবির brightness কম — next time জানালার পাশে তুলবেন'
  }
  if (criterion.includes('ব্যাকগ্রাউন্ড') || criterion.includes('background')) {
    return 'ব্যাকগ্রাউন্ড পরিষ্কার নয় — সাদা কাগজ/কাপড় ব্যবহার করুন'
  }
  if (criterion.includes('angle')) {
    return 'আরো angle দরকার — সামনে, পেছনে, ক্লোজ-আপ সব দিক থেকে তুলুন'
  }
  if (criterion.includes('text') || criterion.includes('readable')) {
    return 'Text ছোট/অস্পষ্ট — ফন্ট সাইজ বাড়ান, contrast ভালো রাখুন'
  }
  if (criterion.includes('audio') || criterion.includes('music')) {
    return 'Audio missing — CapCut-এ trending audio যোগ করুন'
  }
  if (criterion.includes('cta') || criterion.includes('order')) {
    return 'CTA নেই — "DM করুন" বা "অর্ডার করুন" স্পষ্টভাবে যোগ করুন'
  }
  if (criterion.includes('price') || criterion.includes('দাম')) {
    return 'দাম উল্লেখ নেই — product price clearly দেখান'
  }
  if (criterion.includes('brand')) {
    return 'Brand identity নেই — ALMA logo বা watermark যোগ করুন'
  }
  if (criterion.includes('সেকেন্ড') || criterion.includes('sec')) {
    return 'ভিডিও দৈর্ঘ্য ঠিক নেই — নির্দিষ্ট সময়সীমার মধ্যে রাখুন'
  }
  if (criterion.includes('product') || criterion.includes('clear')) {
    return 'প্রোডাক্ট স্পষ্ট দেখা যাচ্ছে না — ক্যামেরা কাছে এনে focus করুন'
  }
  if (criterion.includes('hashtag')) {
    return 'Hashtag দিতে ভুলবেন না — ৫-৭টি relevant hashtag যোগ করুন'
  }
  if (criterion.includes('feature')) {
    return 'Product features mention করুন — কমপক্ষে ৩টি key feature লিখুন'
  }

  return `"${failedCriterion}" পূরণ হয়নি — পরবর্তীবার মনোযোগ দিন`
}

export async function getStaffCompletionRate(staffId: string, taskType: string): Promise<number> {
  try {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const tasks = await db.agentStaffTask.findMany({
      where: {
        staffId,
        type: taskType,
        createdAt: { gte: since },
      },
      select: { status: true },
    })
    if (!tasks.length) return 50
    const done = tasks.filter((t: any) => t.status === 'done' || t.status === 'done_verified').length
    return Math.round((done / tasks.length) * 100)
  } catch (err) {
    console.warn('[task-intelligence] getHistoricalCompletionRate failed:', err instanceof Error ? err.message : err)
    return 50
  }
}
