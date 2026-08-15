/**
 * SEEN LIVE 2026-07-27 on the Qwen head. The reply Boss read contained:
 *
 *   প্রথমে catalog দেখে নিই কতগুলো product আছে, তারপর audit চালাবো।
 *   <get_website_catalog> <arg_key>scope</arg_key> <arg_value>all</arg_value> </tool_call>
 *
 * The first case below is that text, unchanged. The rest of the suite is the
 * other half of the job: ordinary prose with angle brackets in it must come
 * back untouched, or the repair would be worse than the defect.
 */
import { describe, expect, it } from 'vitest'
import { createMarkupStreamFilter, dropRepeatedBlocks, stripToolCallMarkup } from '@/agent/lib/model-output-sanitize'

describe('tool-call markup never reaches the owner', () => {
  it('removes the exact leak from his screen', () => {
    const seen =
      'প্রথমে catalog দেখে নিই কতগুলো product আছে, তারপর audit চালাবো।\n\n'
      + '<get_website_catalog> <arg_key>scope</arg_key> <arg_value>all</arg_value> </tool_call>'
    expect(stripToolCallMarkup(seen)).toBe('প্রথমে catalog দেখে নিই কতগুলো product আছে, তারপর audit চালাবো।')
  })

  it('removes a well-formed <tool_call> block', () => {
    const t = 'বস, দেখছি।\n<tool_call>{"name":"get_orders","arguments":{}}</tool_call>\nএক মিনিট।'
    expect(stripToolCallMarkup(t)).toBe('বস, দেখছি।\n\nএক মিনিট।')
  })

  it('removes a block a cut-off stream never closed', () => {
    const t = 'বস, অর্ডার দেখছি।\n<tool_call>{"name":"get_orders"'
    expect(stripToolCallMarkup(t)).toBe('বস, অর্ডার দেখছি।')
  })

  it('removes the DeepSeek/Qwen sentinels', () => {
    expect(stripToolCallMarkup('ঠিক আছে <|tool_calls_begin|> বাকিটা')).toBe('ঠিক আছে  বাকিটা')
  })

  it('leaves clean prose exactly as it is', () => {
    const t = 'বস, ৫০টা product-এর মধ্যে ৪২টায় সমস্যা — প্রথম ১০টা পাঠালাম।'
    expect(stripToolCallMarkup(t)).toBe(t)
  })

  it('leaves ordinary angle brackets alone', () => {
    const t = 'সাইজ চার্ট: বুক <36 ইঞ্চি → S, 36–40 → M। আর 5 < 10 সবসময়ই সত্য।'
    expect(stripToolCallMarkup(t)).toBe(t)
  })

  it('leaves a code block Boss asked for alone', () => {
    const t = 'এই HTML টা বসান:\n```html\n<img src="/p.jpg" alt="নীল পাঞ্জাবি"/>\n```'
    expect(stripToolCallMarkup(t)).toBe(t)
  })

  it('a message that was ONLY markup becomes empty, not garbage', () => {
    const t = '<tool_call>{"name":"get_orders","arguments":{}}</tool_call>'
    expect(stripToolCallMarkup(t)).toBe('')
  })

  it('is a no-op on empty input', () => {
    expect(stripToolCallMarkup('')).toBe('')
  })
})

describe('the JSON shape (owner’s own chat, 2026-07-27)', () => {
  it('strips the exact block he was shown while asking about ad spend', () => {
    const input = [
      'বস, আপনার অ্যাডস অ্যাকাউন্টের লাইভ খরচ আর লিমিট চেক করছি।',
      '',
      '{"type": "tool_use", "id": "tooluse_fPsTqJdFhXJz8Qm9Kw2LxN", "name": "recommend_ad_actions", "input": {}}',
    ].join('\n')
    const out = stripToolCallMarkup(input)
    expect(out).not.toContain('tool_use')
    expect(out).not.toContain('tooluse_fPsTqJdFhXJz8Qm9Kw2LxN')
    expect(out).toContain('লাইভ খরচ আর লিমিট চেক করছি')
  })

  it('strips one with a populated input object', () => {
    const out = stripToolCallMarkup(
      'দেখছি।\n{"type":"tool_use","id":"x1","name":"get_orders","input":{"limit":10,"status":"pending"}}\nশেষ।',
    )
    expect(out).not.toContain('get_orders')
    expect(out).toContain('দেখছি')
    expect(out).toContain('শেষ')
  })

  it('leaves ordinary JSON he asked for completely alone', () => {
    for (const text of [
      '{"name":"ALMA","type":"shop","orders":42}',
      'API উত্তর: {"type":"product","id":"7-b","price":1200}',
      '{"type":"tool_belt","id":"x"}',
    ]) {
      expect(stripToolCallMarkup(text)).toBe(text)
    }
  })
})

describe('the FOURTH shape — his own chat, 2026-07-27', () => {
  it('strips <function_calls> …, which all three earlier patterns missed', () => {
    // Verbatim from his screenshot, in a reply about the whole business.
    const raw = [
      'বস, পুরো ব্যবসার বর্তমান অবস্থা দেখতে ERP, ওয়েবসাইট আর মার্কেটিং — সব দিক থেকে লাইভ ডেটা টেনে আনছি।',
      '',
      '<function_calls> [get_sales_summary, get_orders, get_inventory_status, get_website_health, recommend_ad_actions] </function_calls>',
      '',
      'বস, লাইভ ডেটা এসেছে — পুরো ব্যবসার অবস্থা:',
    ].join('\n')
    const out = stripToolCallMarkup(raw)
    expect(out).not.toContain('function_calls')
    expect(out).not.toContain('get_sales_summary')
    expect(out).toContain('পুরো ব্যবসার বর্তমান অবস্থা')
    expect(out).toContain('লাইভ ডেটা এসেছে')
  })

  it('strips the rest of the same family before he has to see them too', () => {
    expect(stripToolCallMarkup('আগে <invoke name="get_orders"><parameter name="day">today</parameter></invoke> পরে'))
      .not.toContain('invoke')
    expect(stripToolCallMarkup('ফল: <function_results>{"ok":true}</function_results> শেষ'))
      .not.toContain('function_results')
  })

  it('still leaves ordinary angle-bracket text alone', () => {
    const html = 'সাইজ চার্ট: <table><tr><td>M</td></tr></table> — এটা রেখে দাও'
    expect(stripToolCallMarkup(html)).toBe(html)
  })
})

describe('the same answer twice — third sighting', () => {
  it('drops a near-verbatim repeat of the same paragraph', () => {
    // The handoff shape: the reply says the same thing again a few lines later.
    const once = 'বস, নির্দিষ্ট সিস্টেম ছাড়া response time বা CPU % বলা সম্ভব না — hardware, stack, database, caching সবকিছুর উপর নির্ভর করে, fixed কোনো সংখ্যা নেই।'
    const twice = 'বস, নির্দিষ্ট সিস্টেম ছাড়া response time বা CPU % বলা সম্ভব না — hardware, stack, database, caching সবকিছুর উপর নির্ভর করে, fixed সংখ্যা নেই।'
    const out = dropRepeatedBlocks(`${once}\n\n${twice}`)
    expect(out).toBe(once)
  })

  // HONEST LIMIT, recorded rather than tuned away: on the benchmark reply the
  // second pass carried NEW information (what find_tool returned) wrapped around
  // a repeated verdict. Block-level similarity does not fire there, and lowering
  // the threshold until it did would start eating paragraphs that differ for
  // good reasons. That case needs the model to stop re-answering, not a wider
  // net here.
  it('does NOT drop a repeat that carries new information', () => {
    const first = 'বস, নির্দিষ্ট সিস্টেম ছাড়া exact response time বা CPU % বলা সম্ভব না — hardware, stack, optimization সবকিছুর উপর নির্ভর করে।'
    const second = 'বস, টুল খুঁজে দেখলাম — find_tool-এর ফলাফলে শুধু ads/salah টুল এসেছে, কোনো মিল নেই। তাই আগের কথাটাই থাকছে: নির্দিষ্ট সিস্টেম ছাড়া সংখ্যা বলা যাবে না।'
    expect(dropRepeatedBlocks(`${first}\n\n${second}`)).toContain('find_tool')
  })

  it('keeps the FIRST occurrence, never the later one', () => {
    const first = 'বস, আজকের সেল ৳১৫,১৫৮ — সাতটা অর্ডার, গত সপ্তাহের চেয়ে ভালো, আর কোনো pending নেই এখন।'
    const again = 'বস, আজ সেল হয়েছে ৳১৫,১৫৮ সাতটা অর্ডারে — গত সপ্তাহের চেয়ে ভালো, pending কিছু নেই।'
    const out = dropRepeatedBlocks(`${first}\n\n${again}`)
    expect(out).toBe(first)
  })

  it('leaves a genuine list alone — a list repeats its shape on purpose', () => {
    const list = [
      '- পাঞ্জাবি: ৳১২০০, স্টক ৮টা, এই সপ্তাহে ৩টা বিক্রি হয়েছে মোট',
      '- থ্রি-পিস: ৳১৮০০, স্টক ৬টা, এই সপ্তাহে ৪টা বিক্রি হয়েছে মোট',
    ].join('\n\n')
    expect(dropRepeatedBlocks(list)).toBe(list)
  })

  it('leaves two genuinely different paragraphs alone', () => {
    const a = 'বস, আজকের সেল ৳১৫,১৫৮ — সাতটা অর্ডার, তার মধ্যে তিনটা delivered হয়ে গেছে।'
    const b = 'স্টকে পাঞ্জাবি মাত্র ছয়টা বাকি — boost চললে দুই দিনেই শেষ হয়ে যাবে বস।'
    expect(dropRepeatedBlocks(`${a}\n\n${b}`)).toBe(`${a}\n\n${b}`)
  })
})

describe('the FIFTH shape — live skill test, 2026-07-28', () => {
  it('strips {"name": …, "arguments": …}, which no pattern covered at all', () => {
    // Verbatim from the campaign turn: four of these in a row, each in its own
    // fenced block the UI labelled "TOOL".
    const raw = [
      'বস, একটা meta campaign চালু করতে বলছেন — alma-meta-campaign-launch skill ধরে এগোচ্ছি।',
      '',
      '```tool',
      '{"name": "marketing_report", "arguments": {"period": "last_7_days"}}',
      '```',
      '```tool',
      '{"name": "list_audiences", "arguments": {}}',
      '```',
      '',
      'এবার প্ল্যান তৈরি করছি।',
    ].join('\n')
    const out = stripToolCallMarkup(raw)

    expect(out).not.toContain('marketing_report')
    expect(out).not.toContain('arguments')
    // …and the fence goes with it, so no empty card is left behind.
    expect(out).not.toContain('```')
    expect(out).toContain('meta campaign চালু করতে বলছেন')
    expect(out).toContain('এবার প্ল্যান তৈরি করছি')
  })

  it('strips a bare <parameter …> — the pattern existed, the GUARD blocked it', () => {
    // The customer-support turn. `<parameter>` was already in STRAY_MARKERS, but
    // the cheap guard did not list it, so the function returned untouched.
    const raw = 'বস, ইনবক্স স্ক্যান করছি।\n\n<parameter name="limit">20</parameter>'
    const out = stripToolCallMarkup(raw)

    expect(out).not.toContain('parameter')
    expect(out).not.toContain('limit')
    expect(out).toContain('ইনবক্স স্ক্যান করছি')
  })

  it('leaves JSON he actually asked for alone', () => {
    // The guard for this shape is the tool-name/arguments PAIR, so ordinary
    // JSON — even JSON with a `name` field — survives.
    const json = 'এই যে বস: {"name": "Panjabi Blue", "price": 1200, "stock": 8}'
    expect(stripToolCallMarkup(json)).toBe(json)
  })

  it('leaves a normal code block alone — only tool-labelled fences go', () => {
    const md = 'এই কোডটা:\n\n```json\n{"ok": true}\n```\n\nচালাও'
    expect(stripToolCallMarkup(md)).toBe(md)
  })
})

describe('the STREAMING case — his screen, live, 2026-07-28', () => {
  const run = (deltas: string[]) => {
    const f = createMarkupStreamFilter()
    return deltas.map((d) => f.push(d)).join('') + f.flush()
  }

  it('never shows markup that arrives split across deltas', () => {
    // How it actually came off the wire: the tag spans four deltas.
    const out = run(['ইনবক্স দেখছি। ', '<param', 'eter name="fullScan"', '>true</parameter>', ' এখন খসড়া।'])

    expect(out).not.toContain('parameter')
    expect(out).not.toContain('fullScan')
    expect(out).toContain('ইনবক্স দেখছি')
    expect(out).toContain('এখন খসড়া')
  })

  it('holds the repeated spill and shows none of it', () => {
    // The live failure was hundreds of these in a row.
    const spam = Array.from({ length: 50 }, (_, i) => `<parameter name="fullScanAll${i}">true</parameter>`)
    const out = run(['যাচাই করছি।', ...spam])

    expect(out).not.toContain('parameter')
    expect(out.trim()).toBe('যাচাই করছি।')
  })

  it('does not stall ordinary reasoning that contains a "<"', () => {
    // A held tail that never becomes markup must be released, not swallowed.
    const filler = 'x'.repeat(400)
    const out = run(['স্টক ', '< ', '১০ হলে reorder করতে হবে। ', filler])

    expect(out).toContain('স্টক')
    expect(out).toContain('reorder করতে হবে')
    expect(out).toContain(filler)
  })

  it('flush releases whatever was still held', () => {
    const f = createMarkupStreamFilter()
    f.push('বস, এখন ')
    f.push('<')
    expect(f.flush()).toBe('<')
  })
})

describe('live streaming holds split named-tool markup', () => {
  it('never releases a bare <tool_name> opener before the next chunk resolves it', () => {
    const f = createMarkupStreamFilter()
    const first = f.push('দেখছি <get_website_catalog>')
    expect(first).toBe('দেখছি ')
    // The argument arrives in the NEXT delta — the opener must never have been
    // shown (Codex P1 #765).
    const second = f.push('<arg_key>limit</arg_key><arg_value>5</arg_value>')
    expect(second).not.toContain('get_website_catalog')
    expect(f.flush()).not.toContain('get_website_catalog')
  })

  it('still streams ordinary prose that ends in a closed HTML-ish token', () => {
    const f = createMarkupStreamFilter()
    f.push('আজকের হিসাব <b>')
    const out = f.push(' ভালো।') + f.flush()
    expect(out).toContain('ভালো')
  })
})
