import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AgentMarkdown from '@/agent/components/AgentMarkdown'
import { classifyAgentMarkdownHref } from '@/agent/lib/markdown-link-router'

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
  it('renders internal links in the current tab', () => {
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '[Order AL-42](/orders/AL-42)',
    }))

    expect(html).toContain('href="/orders/AL-42"')
    expect(html).not.toContain('target="_blank"')
  })

  it('renders external links in a protected new tab', () => {
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '[OpenAI](https://openai.com/research)',
    }))

    expect(html).toContain('href="https://openai.com/research"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not create a clickable element for a blocked destination', () => {
    const html = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '[Unsafe](javascript:alert(1))',
    }))

    expect(html).toContain('Unsafe')
    expect(html).not.toContain('<a')
  })
})
