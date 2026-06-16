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
      className="absolute right-2 top-2 rounded-full bg-white/90 backdrop-blur-md border border-black/[0.08] px-2.5 py-1 text-[10px] font-semibold text-gray-500 transition-all hover:bg-[#E07A5F]/10 hover:text-[#E07A5F] hover:border-[#E07A5F]/25"
    >
      {copied ? '✓' : 'কপি'}
    </button>
  )
}

function AgentMarkdownInner({ content, className }: AgentMarkdownProps) {
  return (
    <div className={cn('prose-agent select-text text-[#1a1a2e]', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p({ children }) {
            return <p className="mb-3 last:mb-0 leading-relaxed text-[#1a1a2e]">{children}</p>
          },
          h1({ children }) { return <h1 className="mb-3 mt-5 text-base font-bold text-[#E07A5F] first:mt-0">{children}</h1> },
          h2({ children }) { return <h2 className="mb-2 mt-4 text-sm font-bold text-[#E07A5F] first:mt-0">{children}</h2> },
          h3({ children }) { return <h3 className="mb-2 mt-3 text-sm font-semibold text-[#1a1a2e] first:mt-0">{children}</h3> },
          ul({ children }) { return <ul className="mb-3 ml-4 list-disc space-y-1 text-[#1a1a2e]">{children}</ul> },
          ol({ children }) { return <ol className="mb-3 ml-4 list-decimal space-y-1 text-[#1a1a2e]">{children}</ol> },
          li({ children }) { return <li className="leading-relaxed text-[#1a1a2e]">{children}</li> },
          code({ className: cls, children, ...props }) {
            const isBlock = cls?.startsWith('language-')
            const codeText = String(children).replace(/\n$/, '')
            if (isBlock) {
              const lang = cls?.replace('language-', '') ?? ''
              return (
                <div className="relative my-3 overflow-hidden rounded-xl border border-black/[0.06] bg-[#F4F4F5]">
                  {lang && (
                    <div className="flex items-center justify-between border-b border-black/[0.06] bg-[#EEEEF0] px-4 py-1.5">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-gray-500">{lang}</span>
                    </div>
                  )}
                  <CopyButton text={codeText} />
                  <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                    <code className="font-mono text-gray-800">{codeText}</code>
                  </pre>
                </div>
              )
            }
            return (
              <code
                className="rounded-md border border-[#E07A5F]/15 bg-[#E07A5F]/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-[#c0553f]"
                {...props}
              >
                {children}
              </code>
            )
          },
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto rounded-xl border border-black/[0.06] bg-white shadow-sm">
                <table className="w-full min-w-[280px] text-sm">{children}</table>
              </div>
            )
          },
          thead({ children }) { return <thead className="border-b border-black/[0.06] bg-gray-50">{children}</thead> },
          tbody({ children }) { return <tbody className="divide-y divide-black/[0.04]">{children}</tbody> },
          tr({ children }) { return <tr className="hover:bg-black/[0.02]">{children}</tr> },
          th({ children }) {
            return <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-[#E07A5F]">{children}</th>
          },
          td({ children }) { return <td className="px-4 py-2.5 text-[13px] text-[#1a1a2e]">{children}</td> },
          blockquote({ children }) {
            return (
              <blockquote className="my-3 border-l-2 border-[#E07A5F] pl-4 italic text-gray-600">
                {children}
              </blockquote>
            )
          },
          hr() { return <hr className="my-4 border-black/[0.06]" /> },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#E07A5F] underline underline-offset-2 hover:text-[#81B29A]">
                {children}
              </a>
            )
          },
          strong({ children }) { return <strong className="font-bold text-[#1a1a2e]">{children}</strong> },
          em({ children }) { return <em className="italic text-gray-600">{children}</em> },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Memoize on `content` so finalized messages above a streaming one don't re-parse
 * markdown on every text_delta. ~10x render reduction during streaming.
 */
const AgentMarkdown = React.memo(AgentMarkdownInner, (prev, next) =>
  prev.content === next.content && prev.className === next.className,
)

export default AgentMarkdown
