'use client'

import React, { useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

interface AgentMarkdownProps {
  content: string
  className?: string
  onArtifactDetected?: (content: string, type: 'code' | 'markdown') => void
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])
  return (
    <button
      onClick={copy}
      className="absolute right-2 top-2 rounded-md bg-white/[0.06] px-2 py-1 text-[10px] font-semibold text-zinc-400 transition-colors hover:bg-white/[0.12] hover:text-cream"
    >
      {copied ? '✓' : 'কপি'}
    </button>
  )
}

export default function AgentMarkdown({ content, className }: AgentMarkdownProps) {
  return (
    <div className={cn('prose-agent select-text text-white', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p({ children }) {
            return <p className="mb-3 last:mb-0 leading-relaxed text-white">{children}</p>
          },
          h1({ children }) { return <h1 className="mb-3 mt-5 text-base font-bold text-gold-lt first:mt-0">{children}</h1> },
          h2({ children }) { return <h2 className="mb-2 mt-4 text-sm font-bold text-gold-lt first:mt-0">{children}</h2> },
          h3({ children }) { return <h3 className="mb-2 mt-3 text-sm font-semibold text-amber-200 first:mt-0">{children}</h3> },
          ul({ children }) { return <ul className="mb-3 ml-4 list-disc space-y-1 text-white">{children}</ul> },
          ol({ children }) { return <ol className="mb-3 ml-4 list-decimal space-y-1 text-white">{children}</ol> },
          li({ children }) { return <li className="leading-relaxed text-white">{children}</li> },
          // Code blocks
          code({ className: cls, children, ...props }) {
            const isBlock = cls?.startsWith('language-')
            const codeText = String(children).replace(/\n$/, '')
            if (isBlock) {
              const lang = cls?.replace('language-', '') ?? ''
              return (
                <div className="relative my-3 overflow-hidden rounded-xl border border-border bg-black">
                  {lang && (
                    <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-1.5">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted">{lang}</span>
                    </div>
                  )}
                  <CopyButton text={codeText} />
                  <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                    <code className="font-mono text-zinc-300">{codeText}</code>
                  </pre>
                </div>
              )
            }
            return (
              <code
                className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[12px] text-gold-lt"
                {...props}
              >
                {children}
              </code>
            )
          },
          // Tables (GFM)
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[280px] text-sm">{children}</table>
              </div>
            )
          },
          thead({ children }) { return <thead className="border-b border-border bg-surface">{children}</thead> },
          tbody({ children }) { return <tbody className="divide-y divide-border/50">{children}</tbody> },
          tr({ children }) { return <tr className="hover:bg-white/[0.02]">{children}</tr> },
          th({ children }) {
            return <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-gold">{children}</th>
          },
          td({ children }) { return <td className="px-4 py-2.5 text-[13px] text-white">{children}</td> },
          blockquote({ children }) {
            return (
              <blockquote className="my-3 border-l-2 border-gold-dim pl-4 italic text-zinc-300">
                {children}
              </blockquote>
            )
          },
          // Horizontal rule
          hr() { return <hr className="my-4 border-border" /> },
          // Links
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-gold underline underline-offset-2 hover:text-gold-lt">
                {children}
              </a>
            )
          },
          strong({ children }) { return <strong className="font-bold text-amber-300">{children}</strong> },
          em({ children }) { return <em className="italic text-zinc-300">{children}</em> },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
