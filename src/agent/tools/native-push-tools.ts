/**
 * Phase C (phone companion) — owner-facing tools to control + verify the agent's
 * native app push (Android).
 *
 *   • set_native_push  — turn the native owner-push channel ON/OFF (KV flag,
 *                        no redeploy). Default OFF.
 *   • test_native_push — send a one-off test push to the owner's installed app so
 *                        he can confirm it actually lands on his Android phone.
 *
 * These never bypass the kill-switch: test_native_push only fires when the flag is
 * ON. Pushing real owner alerts is wired into notifyOwner (additive, fail-open).
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'
import {
  AGENT_NATIVE_PUSH_ENABLED_KEY,
  isAgentNativePushEnabled,
  pushNativeToOwner,
  resolveOwnerUserIds,
} from '@/agent/lib/native-owner-push'

const set_native_push: AgentTool = {
  name: 'set_native_push',
  description:
    'Turn the agent\'s NATIVE app push (Android) ON or OFF for the owner. When ON, the ' +
    'owner\'s installed ALMA app gets a real push notification (alongside ntfy/Telegram) ' +
    'for agent alerts. Default OFF. Pass `enabled` true/false. After enabling, you can ' +
    'call test_native_push to confirm it reaches his phone. Owner-facing, confirm in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      enabled: { type: 'boolean', description: 'true = turn native push ON, false = OFF' },
    },
    required: ['enabled'],
  },
  handler: async (input) => {
    try {
      const enabled = Boolean(input.enabled)
      const value = enabled ? 'true' : 'false'
      await prisma.agentKvSetting.upsert({
        where: { key: AGENT_NATIVE_PUSH_ENABLED_KEY },
        create: { key: AGENT_NATIVE_PUSH_ENABLED_KEY, value },
        update: { value },
      })
      return {
        success: true,
        data: {
          enabled,
          message: enabled
            ? 'নেটিভ অ্যাপ পুশ চালু করলাম, Boss — এখন এজেন্টের অ্যালার্ট আপনার ফোনের অ্যাপেও যাবে। ' +
              'চাইলে "টেস্ট পুশ পাঠাও" বললে একটা পরীক্ষা নোটিফিকেশন পাঠাব।'
            : 'নেটিভ অ্যাপ পুশ বন্ধ করলাম, Boss — এখন শুধু ntfy/টেলিগ্রামে অ্যালার্ট যাবে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const test_native_push: AgentTool = {
  name: 'test_native_push',
  description:
    'Send a TEST native push to the owner\'s installed app to verify Android delivery works. ' +
    'Only fires when native push is ON (set_native_push). Reports whether OneSignal accepted ' +
    'the push (accepted ≠ guaranteed device receipt — ask the owner to confirm it appeared). ' +
    'Owner-facing, answer in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      message: { type: 'string', description: 'Optional custom test message (Bangla)' },
    },
  },
  handler: async (input) => {
    try {
      if (!(await isAgentNativePushEnabled())) {
        return {
          success: false,
          error: 'native_push_disabled',
          data: {
            message:
              'নেটিভ অ্যাপ পুশ এখন বন্ধ আছে, Boss। আগে চালু করতে বলুন — "নেটিভ পুশ চালু করো"।',
          },
        }
      }

      const ownerIds = await resolveOwnerUserIds()
      if (!ownerIds.length) {
        return {
          success: false,
          error: 'no_owner_user_id',
          data: {
            message:
              'আপনার অ্যাপ-অ্যাকাউন্ট (ERP user) খুঁজে পেলাম না, Boss — তাই পুশ পাঠানোর ঠিকানা নেই। ' +
              'OWNER_EMAIL সেট করা আছে কিনা দেখুন অথবা KV `agent_owner_user_id` বসান।',
          },
        }
      }

      const msg = String(input.message ?? '').trim() ||
        'এটি একটি টেস্ট নোটিফিকেশন, Boss — আপনার ফোনের অ্যাপে এলে বুঝবেন নেটিভ পুশ ঠিকঠাক কাজ করছে।'
      const res = await pushNativeToOwner({
        tier: 1,
        title: 'ALMA এজেন্ট — টেস্ট পুশ',
        message: msg,
        category: 'task',
      })

      return {
        success: res.ok,
        data: {
          accepted: res.ok,
          reason: res.reason ?? null,
          targetedUsers: ownerIds.length,
          message: res.ok
            ? 'টেস্ট পুশ পাঠিয়ে দিয়েছি, Boss — আপনার ফোনের অ্যাপে নোটিফিকেশনটা এলো কিনা একটু দেখুন। ' +
              'এলে বুঝব Android-এ নেটিভ পুশ পুরোপুরি কাজ করছে।'
            : `টেস্ট পুশ পাঠাতে পারলাম না, Boss (${res.reason ?? 'অজানা সমস্যা'})।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const NATIVE_PUSH_TOOLS: AgentTool[] = [set_native_push, test_native_push]
