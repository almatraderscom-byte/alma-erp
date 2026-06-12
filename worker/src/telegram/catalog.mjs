/**
 * CS-0 — Product images, design groups, size charts via Telegram.
 * Owner + linked staff may upload catalog photos and manage groups.
 */

import { replyMarkdownSafe } from './markdown-safe.mjs'

async function replyInvalidCode(ctx, code, suggestions) {
  const sug = (suggestions ?? []).join(', ')
  await replyMarkdownSafe(
    ctx,
    `❌ *${code}* ERP-তে পাইনি।\n\n` +
      `কালেকশন কোড: শুধু \`133\` বা \`345\` (inventory থেকে পুরো ফ্যামিলি auto)\n` +
      `একটি আইটেম মাত্র: \`345-ADULT\`\n` +
      `/catalog — অগ্রগতি দেখুন` +
      (sug ? `\n\nকাছাকাছি: ${sug}` : ''),
  )
}

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

function bnNum(n) {
  const map = { 0: '০', 1: '১', 2: '২', 3: '৩', 4: '৪', 5: '৫', 6: '৬', 7: '৭', 8: '৮', 9: '৯' }
  return String(n).replace(/\d/g, (d) => map[d] ?? d)
}

async function callCatalog(path, method = 'GET', body) {
  const res = await fetch(`${APP_URL()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${INT_TOKEN()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error ?? data.reason ?? `HTTP ${res.status}`)
    err.data = data
    err.status = res.status
    throw err
  }
  return data
}

/** Parse caption: "FM-204", "FM-204 delete", "FM-204 FM-205 group Eid Family" */
export function parsePhotoCaption(caption) {
  const raw = String(caption ?? '').trim()
  if (!raw) return { type: 'empty' }

  const lower = raw.toLowerCase()
  if (/\bdelete\b$/i.test(raw)) {
    const code = raw.replace(/\s+delete\s*$/i, '').trim().split(/\s+/)[0]
    return { type: 'delete', code }
  }

  const tokens = raw.split(/\s+/)
  const groupIdx = tokens.findIndex((t) => t.toLowerCase() === 'group')
  if (groupIdx >= 2) {
    const codes = tokens.slice(0, groupIdx).filter((t) => /^[A-Za-z0-9][\w-]*$/.test(t))
    const rest = tokens.slice(groupIdx + 1)
    const title = rest.join(' ') || codes.join(' + ')
    return { type: 'group_photo', codes, title, notes: rest.join(' ') }
  }

  const code = tokens[0]
  if (/^[A-Za-z0-9][\w-]*$/.test(code)) {
    return { type: 'single', code }
  }
  return { type: 'invalid', raw }
}

async function downloadTelegramPhoto(telegram, fileId) {
  const link = await telegram.getFileLink(fileId)
  const res = await fetch(link.href)
  if (!res.ok) throw new Error(`Photo download failed: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.toString('base64')
}

export async function uploadPhotoForCode(ctx, productCode, extra = {}) {
  const photos = ctx.message.photo ?? []
  const best = photos[photos.length - 1]
  if (!best) throw new Error('No photo in message')

  const imageBase64 = await downloadTelegramPhoto(ctx.telegram, best.file_id)
  const result = await callCatalog('/api/assistant/internal/catalog/image', 'POST', {
    productCode,
    imageBase64,
    uploadedByChatId: String(ctx.chat?.id ?? ''),
    ...extra,
  })
  return result
}

export async function handleCatalogPhoto(ctx, { isOwner }) {
  const caption = ctx.message.caption ?? ''
  const parsed = parsePhotoCaption(caption)

  if (parsed.type === 'empty') {
    await ctx.reply('❌ ক্যাপশনে প্রোডাক্ট কোড লিখুন — যেমন: FM-204')
    return
  }

  if (parsed.type === 'delete') {
    if (!isOwner) {
      await ctx.reply('❌ ছবি মুছতে শুধু Owner পারবেন।')
      return
    }
    await ctx.reply(`⚠️ ${parsed.code} এর সব ছবি মুছবেন?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ হ্যাঁ, মুছুন', callback_data: `cat_del_yes:${parsed.code}` },
          { text: '❌ না', callback_data: 'cat_del_no' },
        ]],
      },
    })
    return
  }

  if (parsed.type === 'group_photo') {
    let lastTotal = 0
    let lastCode = ''
    for (const code of parsed.codes) {
      try {
        const r = await uploadPhotoForCode(ctx, code)
        lastTotal = r.total
        lastCode = r.code
      } catch (err) {
        if (err.data?.reason === 'invalid_code') {
          await replyInvalidCode(ctx, code, err.data.suggestions)
          return
        }
        throw err
      }
    }
    try {
      const group = await callCatalog('/api/assistant/internal/catalog/group', 'POST', {
        action: 'create',
        codes: parsed.codes,
        title: parsed.title,
        notes: parsed.notes,
      })
      const members = (group.group?.members ?? [])
        .map((m) => `${m.productCode} (${m.memberRole})`)
        .join(', ')
      await ctx.reply(
        `✅ ${parsed.codes.join(' ')} — গ্রুপ "${group.group?.title ?? parsed.title}"\n` +
          `সদস্য: ${members}\n` +
          `ছবি যুক্ত (${bnNum(lastTotal)}টি — ${lastCode})`,
      )
    } catch (err) {
      await ctx.reply(`✅ ছবি যুক্ত। গ্রুপ তৈরিতে সমস্যা: ${err.message}`)
    }
    return
  }

  if (parsed.type === 'single') {
    try {
      const r = await uploadPhotoForCode(ctx, parsed.code)
      if (r.collection && r.codes?.length) {
        await replyMarkdownSafe(
          ctx,
          `✅ *কালেকশন ${r.collection}* — ${bnNum(r.codes.length)}টি SKU-তে ছবি যুক্ত:\n` +
            r.codes.map((c) => `• ${c}`).join('\n'),
        )
      } else {
        await ctx.reply(`✅ ${r.code} এ ছবি যুক্ত হলো (মোট ${bnNum(r.total)}টা)`)
      }
    } catch (err) {
      if (err.data?.reason === 'invalid_code') {
        await replyInvalidCode(ctx, parsed.code, err.data.suggestions)
        return
      }
      throw err
    }
    return
  }

  await ctx.reply('❌ ক্যাপশন বুঝতে পারিনি। উদাহরণ: FM-204 বা FM-204 FM-205 group Eid Family')
}

// Media album buffer: media_group_id → { photos: [], caption, ctx, timer }
const albumBuffers = new Map()

export function handleCatalogPhotoMessage(ctx, opts) {
  const mgId = ctx.message.media_group_id
  if (!mgId) {
    return handleCatalogPhoto(ctx, opts)
  }

  let buf = albumBuffers.get(mgId)
  if (!buf) {
    buf = { photos: [], caption: ctx.message.caption ?? '', ctx, opts, timer: null }
    albumBuffers.set(mgId, buf)
  }
  if (ctx.message.caption) buf.caption = ctx.message.caption
  const photos = ctx.message.photo ?? []
  const best = photos[photos.length - 1]
  if (best) buf.photos.push(best.file_id)

  clearTimeout(buf.timer)
  buf.timer = setTimeout(async () => {
    albumBuffers.delete(mgId)
    const parsed = parsePhotoCaption(buf.caption)
    if (parsed.type !== 'single' && parsed.type !== 'group_photo') {
      await buf.ctx.reply('❌ অ্যালবামের ক্যাপশনে প্রোডাক্ট কোড লিখুন।')
      return
    }
    const codes = parsed.type === 'group_photo' ? parsed.codes : [parsed.code]
    const targetCode = codes[0]
    let total = 0
    for (const fileId of buf.photos) {
      const fakeCtx = {
        ...buf.ctx,
        message: { ...buf.ctx.message, photo: [{ file_id: fileId }] },
      }
      try {
        const r = await uploadPhotoForCode(fakeCtx, targetCode)
        total = r.total
      } catch (err) {
        if (err.data?.reason === 'invalid_code') {
          await replyInvalidCode(buf.ctx, targetCode, err.data.suggestions)
          return
        }
        throw err
      }
    }
    if (parsed.type === 'group_photo') {
      await callCatalog('/api/assistant/internal/catalog/group', 'POST', {
        action: 'create',
        codes: parsed.codes,
        title: parsed.title,
      }).catch(() => {})
    }
    await buf.ctx.reply(`✅ ${targetCode} এ ছবি যুক্ত হলো (মোট ${bnNum(total)}টা)`)
  }, 800)
}

export async function handleCatalogStatus(ctx, { replyMarkup } = {}) {
  const status = await callCatalog('/api/assistant/internal/catalog/status')
  const missing = (status.topMissing ?? []).slice(0, 10).join(', ') || '(নেই)'
  const pct = status.totalProducts
    ? Math.round((status.withImages / status.totalProducts) * 100)
    : 0
  await replyMarkdownSafe(
    ctx,
    `📦 *ক্যাটালগ স্ট্যাটাস*\n\n` +
      `মোট প্রোডাক্ট: ${bnNum(status.totalProducts)}\n` +
      `ছবি আছে: ${bnNum(status.withImages)} (${bnNum(pct)}%)\n` +
      `ছবি নেই: ${bnNum(status.missingCount)}\n\n` +
      `*অগ্রাধিকার (বিক্রয় অনুযায়ী):*\n${missing}`,
    replyMarkup ? { reply_markup: replyMarkup } : {},
  )
}

export function catalogPanelKeyboard(isOwner) {
  const rows = [[
    { text: '🔄 আপডেট', callback_data: 'catalog:refresh' },
    { text: '📷 ছবি যোগ গাইড', callback_data: 'catalog:guide' },
  ]]
  if (isOwner) {
    rows.push([{ text: '💡 গ্রুপ সাজেস্ট', callback_data: 'catalog:suggest' }])
  }
  return { inline_keyboard: rows }
}

export async function showCatalogGuide(ctx) {
  await replyMarkdownSafe(
    ctx,
    '📷 *ছবি যোগ করুন*\n\n' +
      '১. ফটো পাঠান\n' +
      '২. ক্যাপশনে কোড লিখুন — কালেকশন: `133` বা `345` (variant লাগবে না)\n' +
      '৩. একাধিক কোডে গ্রুপ: FM-204 FM-205 group Eid Family\n\n' +
      '/catalog — অগ্রগতি দেখুন',
  )
}

export async function handleGroupCommand(ctx, args) {
  const parts = args.trim().split(/\s+/)
  if (parts[0] === 'set' && parts.length >= 3) {
    const roles = new Set(['baba', 'chele', 'ma', 'meye', 'couple', 'other'])
    let groupCode
    let productCode
    let role
    if (parts.length >= 4 && roles.has(parts[3])) {
      groupCode = parts[1]
      productCode = parts[2]
      role = parts[3]
    } else if (roles.has(parts[2])) {
      productCode = parts[1]
      role = parts[2]
    } else {
      await ctx.reply('ব্যবহার: /group set FM-205 chele  অথবা  /group set FMG-001 FM-205 chele')
      return
    }
    const result = await callCatalog('/api/assistant/internal/catalog/group', 'POST', {
      action: 'set_role',
      groupCode,
      productCode,
      role,
    })
    await ctx.reply(`✅ ${result.group?.groupCode}: ${productCode} → ${role}`)
    return
  }

  if (parts.length < 2) {
    await ctx.reply(
      'ব্যবহার:\n' +
        '/group FM-204 FM-205 Family Panjabi Eid\n' +
        '/group set FMG-001 FM-205 chele',
    )
    return
  }

  const groupKeyword = parts.findIndex((p) => p.toLowerCase() === 'group')
  let codes
  let title
  if (groupKeyword > 0) {
    codes = parts.slice(0, groupKeyword)
    title = parts.slice(groupKeyword + 1).join(' ')
  } else {
    const titleStart = parts.findIndex((p) => !/^[A-Z0-9][\w-]*$/i.test(p))
    if (titleStart > 1) {
      codes = parts.slice(0, titleStart)
      title = parts.slice(titleStart).join(' ')
    } else {
      codes = parts.slice(0, 2)
      title = parts.slice(2).join(' ') || codes.join(' + ')
    }
  }

  const result = await callCatalog('/api/assistant/internal/catalog/group', 'POST', {
    action: 'create',
    codes,
    title,
  })
  const g = result.group
  const lines = (g?.members ?? []).map((m) => `• ${m.productCode} (${m.memberRole}) — ৳${m.sellPrice}, স্টক ${m.currentStock}`)
  await replyMarkdownSafe(
    ctx,
    `✅ গ্রুপ *${g?.groupCode}*: ${g?.title}\n\n${lines.join('\n')}`,
  )
}

export async function handleSizeChartCommand(ctx, args, { isOwner }) {
  if (!isOwner) {
    await ctx.reply('❌ সাইজ চার্ট শুধু Owner পরিচালনা করতে পারবেন।')
    return
  }

  const parts = args.trim().split(/\s+/)
  const sub = parts[0] ?? 'list'

  if (sub === 'list' || sub === '') {
    const data = await callCatalog('/api/assistant/internal/catalog/sizechart')
    const rows = data.rows ?? []
    if (!rows.length) {
      await ctx.reply('কোনো সাইজ চার্ট নেই। seed ইমপোর্ট: trigger.mjs import-size-charts')
      return
    }
    const text = rows
      .slice(0, 25)
      .map((r) => `${r.category} ${r.ageMinYears}-${r.ageMaxYears} → ${r.sizeLabel}`)
      .join('\n')
    await ctx.reply(`📏 সাইজ চার্ট:\n${text}`)
    return
  }

  if (sub === 'add' && parts.length >= 4) {
    const [, category, ageRange, sizeLabel, ...noteParts] = parts
    await callCatalog('/api/assistant/internal/catalog/sizechart', 'POST', {
      action: 'add',
      category,
      ageRange,
      sizeLabel,
      heightNote: noteParts.join(' ') || undefined,
    })
    await ctx.reply(`✅ যোগ হয়েছে: ${category} ${ageRange} → ${sizeLabel}`)
    return
  }

  if (sub === 'delete' && parts[1]) {
    await callCatalog('/api/assistant/internal/catalog/sizechart', 'POST', {
      action: 'delete',
      id: parts[1],
    })
    await ctx.reply('✅ মুছে ফেলা হয়েছে।')
    return
  }

  await ctx.reply('ব্যবহার:\n/sizechart list\n/sizechart add boys_panjabi 4-5 26\n/sizechart delete <id>')
}

export async function handleCatalogSuggest(ctx) {
  const data = await callCatalog('/api/assistant/internal/catalog/group-suggestions?limit=10')
  const suggestions = data.suggestions ?? []
  if (!suggestions.length) {
    await ctx.reply('কোনো স্বয়ংক্রিয় গ্রুপ পরামর্শ পাওয়া যায়নি।')
    return
  }
  for (const s of suggestions.slice(0, 5)) {
    const codes = s.codes.join(', ')
    const roles = Object.entries(s.guessedRoles ?? {})
      .map(([c, r]) => `${c}:${r}`)
      .join(' ')
    await ctx.reply(
      `💡 *${s.title}*\n${codes}\n${s.reason}\n${roles}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅', callback_data: `csg_yes:${s.id}` },
            { text: '❌', callback_data: `csg_no:${s.id}` },
          ]],
        },
      },
    )
  }
}

export async function handleCatalogCallback(ctx, data, { isOwner }) {
  if (data.startsWith('cat_del_yes:')) {
    if (!isOwner) {
      await ctx.answerCbQuery('Owner only')
      return
    }
    const code = data.slice('cat_del_yes:'.length)
    await callCatalog('/api/assistant/internal/catalog/delete-images', 'POST', { productCode: code })
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.answerCbQuery('মুছে ফেলা হয়েছে')
    await ctx.reply(`✅ ${code} এর সব ছবি মুছে ফেলা হয়েছে।`)
    return true
  }
  if (data === 'cat_del_no') {
    await ctx.answerCbQuery('বাতিল')
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    return true
  }
  if (data.startsWith('csg_yes:')) {
    if (!isOwner) {
      await ctx.answerCbQuery('Owner only')
      return true
    }
    const id = data.slice('csg_yes:'.length)
    await callCatalog('/api/assistant/internal/catalog/group-suggestions', 'POST', {
      suggestionId: id,
      approve: true,
    })
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.answerCbQuery('গ্রুপ তৈরি ✅')
    return true
  }
  if (data.startsWith('csg_no:')) {
    await ctx.answerCbQuery('বাতিল')
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    return true
  }
  return false
}
