import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AgentMarkdown from '@/agent/components/AgentMarkdown'
import { classifyAgentMarkdownHref } from '@/agent/lib/markdown-link-router'
import { buildExternalReference } from '@/agent/lib/references/external-url'
import { buildInternalEntityReference } from '@/agent/lib/references/internal-registry'

function orderReference() {
  return buildInternalEntityReference({
    namespace: 'order',
    id: 'AL-42',
    label: 'Order AL-42',
    sourceTool: 'get_orders',
    outputPath: 'data.orders[0].id',
    context: {
      businessId: 'ALMA_LIFESTYLE',
      roles: ['SUPER_ADMIN'],
      observedAt: '2026-08-23T00:00:00.000Z',
    },
  })!
}

function openAIReference() {
  return buildExternalReference({
    rawUrl: 'https://openai.com/research',
    label: 'OpenAI',
    source: 'browser_observed',
    context: {
      roles: ['SUPER_ADMIN'],
      observedAt: '2026-08-23T00:00:00.000Z',
    },
  })!
}

describe('classifyAgentMarkdownHref', () => {
  it('keeps root-relative ALMA destinations internal', () => {
    expect(classifyAgentMarkdownHref('/orders/AL-42?tab=items#top')).toEqual({
      kind: 'internal',
      href: '/orders/AL-42?tab=items#top',
    })
  })

  it('normalizes an exact same-origin absolute URL to an internal path', () => {
    expect(classifyAgentMarkdownHref(
      'https://erp.example.com/orders/AL-42?tab=items#top',
      'https://erp.example.com',
    )).toEqual({ kind: 'internal', href: '/orders/AL-42?tab=items#top' })
  })

  it('keeps external HTTP(S) destinations external, including hostname spoofs', () => {
    expect(classifyAgentMarkdownHref('https://openai.com/research')).toEqual({
      kind: 'external',
      href: 'https://openai.com/research',
    })
    expect(classifyAgentMarkdownHref(
      'https://evilerp.example.com/orders/AL-42',
      'https://erp.example.com',
    )).toEqual({
      kind: 'external',
      href: 'https://evilerp.example.com/orders/AL-42',
    })
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/report',
    '//evil.example/orders/AL-42',
    '\\\\evil.example\\orders',
    'https://user:secret@example.com/private',
    'https://example.com/a\nheader: injected',
    '/api/orders/orders?id=secret',
    'https://erp.example.com/api/private',
  ])('blocks unsafe href %s', (href) => {
    expect(classifyAgentMarkdownHref(
      href,
      href.startsWith('https://erp.example.com') ? 'https://erp.example.com' : undefined,
    )).toEqual({ kind: 'invalid' })
  })
})

describe('AgentMarkdown links', () => {
  it('renders only a message-scoped internal reference in the current tab', () => {
    const reference = orderReference()
    if (reference.destination.type !== 'internal_entity') throw new Error('fixture')
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: `[Order AL-42](<${reference.destination.webPath}>)`,
      references: [reference],
    }))

    expect(html).toContain(`href="${reference.destination.webPath.replaceAll('&', '&amp;')}"`)
    expect(html).not.toContain('target="_blank"')
  })

  it('renders only a verified external reference in a protected new tab with provider/domain', () => {
    const reference = openAIReference()
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '[OpenAI](https://openai.com/research)',
      references: [reference],
    }))

    expect(html).toContain('href="https://openai.com/research"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('web · openai.com')
  })

  it('keeps unknown and path-confused URLs readable but inert', () => {
    const reference = orderReference()
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '[Unknown](https://example.com) [Spoof](https://evil.example/orders/AL-42)',
      references: [reference],
    }))

    expect(html).toContain('Unknown')
    expect(html).toContain('Spoof')
    expect(html).not.toContain('<a')
  })

  it('does not create a clickable element for a blocked destination', () => {
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '[Unsafe](javascript:alert(1))',
    }))

    expect(html).toContain('Unsafe')
    expect(html).not.toContain('<a')
  })

  it('does not contact verified remote image hosts before explicit load consent', () => {
    const reference = buildExternalReference({
      rawUrl: 'https://media.example.com/generated.png',
      label: 'Generated image',
      kind: 'external_media',
      purpose: 'media',
      mediaType: 'image/png',
      source: 'tool_output',
      context: { roles: ['SUPER_ADMIN'], observedAt: '2026-08-23T00:00:00.000Z' },
    })!
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '![Generated image](https://media.example.com/generated.png)',
      references: [reference],
    }))

    expect(html).toContain('Generated image')
    expect(html).toContain('web · media.example.com')
    expect(html).toContain('ছবি লোড করুন')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('https://media.example.com/generated.png')
  })
})

describe('AgentMarkdown professional report surface', () => {
  it('renders semantic editorial hierarchy, tables, lists, and callouts', () => {
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: `# সাপ্তাহিক রিপোর্ট

## নির্বাহী সারাংশ

**Bottom line:** বিক্রি স্থিতিশীল।

### মূল সংকেত

- বিক্রি যাচাই করা হয়েছে
- stock ঝুঁকি আছে

| KPI | অবস্থা |
| --- | --- |
| বিক্রি | স্থিতিশীল |

> Live data ছাড়া কোনো সংখ্যা যোগ করা হয়নি।`,
    }))

    expect(html).toContain('<h1')
    expect(html).toContain('text-[22px]')
    expect(html).toContain('<h2')
    expect(html).toContain('border-l-2')
    expect(html).toContain('<h3')
    expect(html).toContain('<ul')
    expect(html).toContain('<table')
    expect(html).toContain('scope="col"')
    expect(html).toContain('role="note"')
  })
})
