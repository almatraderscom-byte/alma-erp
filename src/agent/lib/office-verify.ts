/**
 * Office task verification strategy router.
 *
 * The owner's requirement: the supervisor must NOT fall back to weakly asking the
 * staff "how did you do it?". Instead, for every task type it either
 *   (A) verifies the work itself with a real tool (Graph API / ERP) — ground truth,
 *   (B) requests ONE specific, easy-to-supply, easy-to-verify proof, or
 *   (C) (handled by the supervisor) escalates when genuinely subjective.
 *
 * This module decides which strategy a task uses, supplies the exact Bangla proof
 * instruction to give the staff up front, and runs the tool-based checks. It is
 * pure agent code (no ERP writes) and degrades gracefully — any failure returns
 * 'unsure' so the supervisor's 90/10 gate decides, never a wrong close.
 */
import { parseFbPostRef, verifyLivePost, getCustomerReplyStatus, resolvePageId } from '@/agent/lib/meta'

export type VerifyStrategy =
  | 'fb_live' // posted to FB → verify the post/reel is genuinely live (Graph API)
  | 'customer_reply' // reply to unread → check the real inbox/comment state (Graph API)
  | 'order_followup' // order id + concrete outcome (structured proof)
  | 'listing_update' // live listing URL (+ screenshot where no API exists)
  | 'deliverable' // learning/skill → produce an output artifact to vision-check
  | 'image' // generic visual proof → existing vision assessor
  | 'text' // generic text/link proof → existing DeepSeek judge

export interface TaskLite {
  type: string
  title: string
  detail: string | null
  businessId: string
  productRef?: string | null
}

export interface StrategyDecision {
  strategy: VerifyStrategy
  /** Up-front Bangla instruction telling staff EXACTLY what proof to submit. */
  proofSpecBn: string
  /** True when the agent verifies on its own and needs no staff-supplied proof. */
  selfVerifies: boolean
}

export interface ToolVerdict {
  verdict: 'pass' | 'fail' | 'unsure'
  method: string
  /** Bangla note shown to staff / logged as evidence. */
  note: string
}

// ── Keyword detectors ────────────────────────────────────────────────────────

const FB_POST_KEYWORDS = /(রিল|reel|ভিডিও|video|পোস্ট|post|ফেসবুক|facebook|\bfb\b|insta|ইনস্টা)/i
const LEARNING_KEYWORDS = /(শিখ|শেখা|শেখো|শিখুন|learn|শিখে|প্র্যাকটিস|practice|রপ্ত|আয়ত্ত)/i
const FB_LINK_RE = /(https?:\/\/[^\s]*(?:facebook\.com|fb\.com|fb\.watch)[^\s]*)/i

/** Pull the first Facebook link out of arbitrary proof text, if any. */
export function extractFbLink(text: string): string | null {
  const m = String(text ?? '').match(FB_LINK_RE)
  return m ? m[1] : null
}

/** Map a task to the Facebook page it belongs to (defaults to Lifestyle). */
export function pageIdForTask(task: TaskLite): string {
  const hay = `${task.title} ${task.detail ?? ''}`.toLowerCase()
  if (/online ?shop|অনলাইন ?শপ|online_shop/.test(hay)) return resolvePageId('onlineshop')
  if (task.businessId === 'ALMA_TRADING') return resolvePageId('onlineshop')
  return resolvePageId('lifestyle')
}

// ── Strategy classification ────────────────────────────────────────────────────

/**
 * Decide how a task should be verified and what to ask the staff for up front.
 * Order matters — the most specific tool-based strategies win.
 */
export function classifyStrategy(task: TaskLite): StrategyDecision {
  const type = (task.type ?? '').toLowerCase()
  const hay = `${task.title} ${task.detail ?? ''}`

  // 1) Customer reply — agent checks the real inbox/comments itself.
  if (type === 'customer_reply') {
    return {
      strategy: 'customer_reply',
      selfVerifies: true,
      proofSpecBn:
        'এই কাজটি শেষ হলে শুধু "শেষ" লিখে জানালেই হবে — আমি নিজে Messenger ইনবক্স ও পোস্টের কমেন্ট চেক করে দেখে নেব কোনো আনরিড বাকি আছে কিনা।',
    }
  }

  // 2) FB post / reel — verified live via Graph API from a link.
  const isFbType = type === 'video_reel' || type === 'ad_creative'
  if (isFbType || FB_POST_KEYWORDS.test(hay)) {
    return {
      strategy: 'fb_live',
      selfVerifies: false,
      proofSpecBn:
        'পোস্ট/রিলটি লাইভ হলে তার সরাসরি Facebook লিংকটি (অথবা পোস্ট আইডি) এখানে দিন। আমি লিংক দিয়ে আমাদের পেজে গিয়ে যাচাই করব পোস্টটি সত্যিই লাইভ আছে কিনা। (স্ক্রিনশট নয়, লিংক দিলে নিশ্চিতভাবে যাচাই হবে।)',
    }
  }

  // 3) Listing update — needs a live listing URL.
  if (type === 'listing_update') {
    return {
      strategy: 'listing_update',
      selfVerifies: false,
      proofSpecBn:
        'আপডেট করা লিস্টিংয়ের লাইভ লিংকটি দিন (FB Shop / Daraz)। Daraz হলে লিংকের সাথে লিস্টিং পেজের একটি স্ক্রিনশটও দিন — আমি লিংক ও ছবি মিলিয়ে যাচাই করব।',
    }
  }

  // 4) Order follow-up — structured outcome the agent can check.
  if (type === 'order_followup') {
    return {
      strategy: 'order_followup',
      selfVerifies: false,
      proofSpecBn:
        'কোন অর্ডারটি ফলো-আপ করলেন তার অর্ডার আইডি/নম্বর এবং ফলাফল লিখুন — যেমন: "অর্ডার #1234 — কাস্টমার কনফার্ম করেছেন / পরে নেবেন / ক্যান্সেল"। শুধু "করেছি" যথেষ্ট নয়।',
    }
  }

  // 5) Learning / skill — turn it into a concrete deliverable.
  if (type === 'misc' && LEARNING_KEYWORDS.test(hay)) {
    return {
      strategy: 'deliverable',
      selfVerifies: false,
      proofSpecBn:
        'শেখা শেষে যা শিখলেন তা প্রয়োগ করে ছোট একটি নমুনা দিন — যেমন ফটোগ্রাফি হলে শেখা lighting/angle দিয়ে তোলা ১-২টি ছবি। আমি নমুনা দেখে বুঝব কাজটি সত্যিই রপ্ত হয়েছে কিনা।',
    }
  }

  // 6) Photo / visual content → image proof (existing vision assessor + product images).
  if (type === 'product_photo' || type === 'product_content' || type === 'content_support') {
    return {
      strategy: 'image',
      selfVerifies: false,
      proofSpecBn: 'কাজটি শেষ হলে তৈরি করা ছবি/কন্টেন্টটি এখানে আপলোড করুন — আমি ছবিটি কাজের সাথে মিলিয়ে যাচাই করব।',
    }
  }

  // 7) Everything else → generic text/link proof.
  return {
    strategy: 'text',
    selfVerifies: false,
    proofSpecBn: 'কাজটি শেষ হলে সংক্ষেপে কী করলেন (লিংক/তথ্যসহ) এখানে লিখুন — যাতে আমি যাচাই করতে পারি।',
  }
}

// ── Tool-based verification runners ────────────────────────────────────────────

/** Verify a Facebook post/reel is genuinely live on our page from a submitted link/id. */
export async function verifyFbLive(task: TaskLite, link: string): Promise<ToolVerdict> {
  const ref = link?.trim()
  if (!ref || parseFbPostRef(ref).kind === 'unknown') {
    return {
      verdict: 'unsure',
      method: 'fb_graph',
      note: 'পোস্টের লিংক/আইডি বুঝতে পারিনি। অনুগ্রহ করে পোস্টের সরাসরি Facebook লিংকটি দিন।',
    }
  }
  try {
    const pageId = pageIdForTask(task)
    const res = await verifyLivePost({ pageId, ref })
    if (!res.ok) {
      return { verdict: 'fail', method: 'fb_graph', note: bnFbFail(res.note) }
    }
    // Reel/video tasks: confirm it's actually a video, not a photo post.
    const wantsVideo = /(রিল|reel|ভিডিও|video)/i.test(`${task.title} ${task.detail ?? ''}`)
    if (wantsVideo && !res.isVideo) {
      return {
        verdict: 'fail',
        method: 'fb_graph',
        note: 'লিংকটি লাইভ পাওয়া গেছে, কিন্তু এটি ভিডিও/রিল মনে হচ্ছে না। রিল/ভিডিও পোস্টের সঠিক লিংকটি দিন।',
      }
    }
    const freshness = res.isRecent ? 'আজকের পোস্ট' : 'পুরোনো পোস্ট হতে পারে'
    const kind = res.isReel ? 'রিল' : res.isVideo ? 'ভিডিও' : 'পোস্ট'
    return {
      verdict: 'pass',
      method: res.matchedBy === 'graph_id' ? 'fb_graph' : 'fb_permalink',
      note: `যাচাই সম্পন্ন — ${kind}টি আমাদের পেজে লাইভ আছে (${freshness})।`,
    }
  } catch {
    return { verdict: 'unsure', method: 'fb_graph', note: 'Facebook যাচাই এই মুহূর্তে করা গেল না।' }
  }
}

function bnFbFail(note: string): string {
  if (/another page|private|deleted|could not be fetched|not found/i.test(note)) {
    return 'এই পোস্টটি আমাদের পেজে লাইভ পাওয়া গেল না (মুছে ফেলা / অন্য পেজ / প্রাইভেট হতে পারে)। সঠিক লিংকটি দিন।'
  }
  if (/share|pfbid|direct post link/i.test(note)) {
    return 'এই share লিংকটি আমাদের পেজের সাম্প্রতিক পোস্টের সাথে মিলল না। পোস্টের সরাসরি লিংকটি দিন।'
  }
  return 'পোস্টটি যাচাই করা গেল না — সঠিক লিংকটি দিন।'
}

/** Verify a "reply to all unread" task by reading the real inbox + comment state. */
export async function verifyCustomerReply(task: TaskLite): Promise<ToolVerdict> {
  try {
    const pageId = pageIdForTask(task)
    const status = await getCustomerReplyStatus(pageId)
    if (status.allCaughtUp) {
      return { verdict: 'pass', method: 'fb_graph', note: 'যাচাই সম্পন্ন — এখন কোনো আনরিড মেসেজ বা কমেন্ট বাকি নেই।' }
    }
    return {
      verdict: 'fail',
      method: 'fb_graph',
      note: `এখনো ${status.messengerUnanswered}টি ইনবক্স ও ${status.commentUnanswered}টি কমেন্টের উত্তর বাকি আছে — সেগুলো শেষ করে জানান।`,
    }
  } catch {
    return { verdict: 'unsure', method: 'fb_graph', note: 'ইনবক্স যাচাই এই মুহূর্তে করা গেল না।' }
  }
}
