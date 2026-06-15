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
      className="absolute right-2 top-2 rounded-full bg-white/[0.06] backdrop-blur-md border border-white/[0.08] px-2.5 py-1 text-[10px] font-semibold text-zinc-400 transition-all hover:bg-gold/10 hover:text-gold-lt hover:border-gold-dim/30 hover:shadow-[0_0_8px_rgba(201,168,76,0.15)]"
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
                <div className="relative my-3 overflow-hidden rounded-xl border border-white/[0.06] bg-[rgba(8,8,12,0.8)] backdrop-blur-md">
                  {lang && (
                    <div className="flex items-center justify-between border-b border-white/[0.06] bg-[rgba(15,15,20,0.6)] backdrop-blur-md px-4 py-1.5">
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
                className="rounded-md border border-[rgba(201,168,76,0.15)] bg-[rgba(201,168,76,0.08)] px-1.5 py-0.5 font-mono text-[12px] text-gold-lt"
                {...props}
              >
                {children}
              </code>
            )
          },
          // Tables (GFM)
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto rounded-xl border border-white/[0.06] bg-[rgba(8,8,12,0.5)] backdrop-blur-md">
                <table className="w-full min-w-[280px] text-sm">{children}</table>
              </div>
            )
          },
          thead({ children }) { return <thead className="border-b border-white/[0.06] bg-[rgba(201,168,76,0.04)]">{children}</thead> },
          tbody({ children }) { return <tbody className="divide-y divide-white/[0.04]">{children}</tbody> },
          tr({ children }) { return <tr className="hover:bg-white/[0.02]">{children}</tr> },
          th({ children }) {
            return <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-gold">{children}</th>
          },
          td({ children }) { return <td className="px-4 py-2.5 text-[13px] text-white">{children}</td> },
          blockquote({ children }) {
            return (
              <blockquote
                className="my-3 border-l-2 border-gold pl-4 italic text-zinc-300"
                style={{ borderImageSource: 'linear-gradient(180deg, rgba(201,168,76,0.8), rgba(201,168,76,0.2))', borderImageSlice: 1 }}
              >
                {children}
              </blockquote>
            )
          },
          // Horizontal rule
          hr() { return <hr className="my-4 border-white/[0.06]" /> },
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
