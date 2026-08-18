/**
 * What the assistant says on the demo instance.
 *
 * The demo deliberately carries no model API key: a visitor could otherwise spend the
 * owner's model budget on questions about invented data. But an assistant tab that
 * errors ("OPENAI_API_KEY is not set") reads as a broken product, which is worse than
 * one that is plainly switched off. So the demo answers every message with a fixed,
 * deliberate notice instead of calling a model at all — no turn, no spend.
 *
 * Set `DEMO_ASSISTANT_LIVE=true` on the demo to run the real assistant instead (that
 * path is metered by `demo-assistant-cap.ts`).
 */
import { isDemoDeployment } from '@/lib/demo-mode'

export function demoAssistantNoticeActive(): boolean {
  return isDemoDeployment() && process.env.DEMO_ASSISTANT_LIVE !== 'true'
}

export const DEMO_ASSISTANT_NOTICE = [
  'এটি **ALMA ERP**-এর ডেমো সংস্করণ। এখানে যা দেখছেন তার সবটুকুই নমুনা তথ্য — কোনো প্রকৃত ব্যবসার অর্ডার, গ্রাহক বা হিসাব নয়।',
  '',
  'ডেমোতে **AI অ্যাসিস্ট্যান্ট নিষ্ক্রিয়** রাখা হয়েছে। আপনার নিজের অ্যাকাউন্ট চালু হওয়ার পর — অথবা সাবস্ক্রিপশন নেওয়ার পর — এই অ্যাসিস্ট্যান্ট আপনার নিজের ব্যবসার তথ্য নিয়ে কাজ শুরু করবে: অর্ডার, স্টক, খরচ, বকেয়া কিংবা মুনাফা নিয়ে প্রশ্ন করলে সরাসরি উত্তর দেবে, রিপোর্ট তৈরি করে দেবে এবং কাজ মনে করিয়ে দেবে।',
  '',
  'ইতিমধ্যে বাকি সব ফিচার — অর্ডার, ইনভেন্টরি, CRM, হিসাব, হাজিরা ও পে-রোল — ডেমোতে সম্পূর্ণ চালু আছে, ঘুরে দেখুন।',
  '',
  '_This is a demo of ALMA ERP with sample data. The AI assistant is disabled here — it activates with your own account or subscription. Every other module is fully usable._',
].join('\n')
