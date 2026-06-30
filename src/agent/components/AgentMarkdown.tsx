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
      className="absolute right-2 top-2 rounded-full bg-card/82 backdrop-blur-md border border-border px-2.5 py-1 text-[10px] font-semibold text-muted transition-all hover:bg-[#E07A5F]/10 hover:text-[#E07A5F] hover:border-[#E07A5F]/25"
    >
      {copied ? '✓' : 'কপি'}
    </button>
  )
}

/**
 * Generated images (e.g. `![Generated image](signedUrl)`) render as a framed image
 * with a download control. Generation previously left the owner with a bare <img>
 * and no way to save it ("image generate hole download option thake na, setaw add
 * koro"). We try a blob fetch → object URL → anchor[download] so the file saves with
 * a sensible name; if the fetch is blocked (cross-origin signed URL without CORS) we
 * fall back to opening the image in a new tab so the owner can long-press / right-click
 * save. Best-effort, never throws into render.
 */
function ImageWithDownload({ src, alt }: { src?: string; alt?: string }) {
  const [busy, setBusy] = React.useState(false)
  const download = useCallback(async () => {
    if (!src || busy) return
    setBusy(true)
    try {
      const res = await fetch(src)
      if (!res.ok) throw new Error(`fetch ${res.status}`)
      const blob = await res.blob()
      const objUrl = URL.createObjectURL(blob)
      const ext = (blob.type.split('/')[1] || 'png').split('+')[0].split(';')[0]
      const a = document.createElement('a')
      a.href = objUrl
      a.download = `alma-${Date.now()}.${ext}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(objUrl), 4000)
    } catch {
      // Cross-origin / CORS-blocked signed URL → open in a new tab as a fallback.
      try { window.open(src, '_blank', 'noopener,noreferrer') } catch { /* noop */ }
    } finally {
      setBusy(false)
    }
  }, [src, busy])
  if (!src) return null
  return (
    <span className="group relative my-3 block overflow-hidden rounded-xl border border-border-subtle bg-bg-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt ?? ''} className="block h-auto w-full max-w-full" />
      <button
        onClick={download}
        disabled={busy}
        className="absolute right-2 top-2 rounded-full bg-card/82 backdrop-blur-md border border-border px-2.5 py-1 text-[10px] font-semibold text-muted transition-all hover:bg-[#E07A5F]/10 hover:text-[#E07A5F] hover:border-[#E07A5F]/25 disabled:opacity-60"
      >
        {busy ? '…' : '⬇ ডাউনলোড'}
      </button>
    </span>
  )
}

function AgentMarkdownInner({ content, className }: AgentMarkdownProps) {
  return (
    <div className={cn('prose-agent select-text text-cream break-words [overflow-wrap:anywhere]', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p({ children }) {
            return <p className="mb-3 last:mb-0 leading-relaxed text-cream">{children}</p>
          },
          h1({ children }) { return <h1 className="mb-3 mt-5 text-base font-bold text-[#E07A5F] first:mt-0">{children}</h1> },
          h2({ children }) { return <h2 className="mb-2 mt-4 text-sm font-bold text-[#E07A5F] first:mt-0">{children}</h2> },
          h3({ children }) { return <h3 className="mb-2 mt-3 text-sm font-semibold text-cream first:mt-0">{children}</h3> },
          ul({ children }) { return <ul className="mb-3 ml-4 list-disc space-y-1 text-cream">{children}</ul> },
          ol({ children }) { return <ol className="mb-3 ml-4 list-decimal space-y-1 text-cream">{children}</ol> },
          li({ children }) { return <li className="leading-relaxed text-cream">{children}</li> },
          code({ className: cls, children, ...props }) {
            const isBlock = cls?.startsWith('language-')
            const codeText = String(children).replace(/\n$/, '')
            if (isBlock) {
              const lang = cls?.replace('language-', '') ?? ''
              // Copyable DELIVERABLE block (caption / post / ready-to-send text).
              // The agent wraps "copy this and use it" text in ```copy (or
              // ```caption / ```post) so the owner gets a one-tap copy WITHOUT the
              // ugly monospace code look — normal font, soft brand card, big copy
              // button. This is what fixes "caption gulo copy format e dao".
              if (['copy', 'caption', 'post', 'text', 'message'].includes(lang.toLowerCase())) {
                return (
                  <div className="relative my-3 overflow-hidden rounded-xl border border-[#E07A5F]/25 bg-[#E07A5F]/[0.06]">
                    <div className="flex items-center justify-between border-b border-[#E07A5F]/15 px-4 py-1.5">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-[#E07A5F]/80">কপি করুন</span>
                    </div>
                    <CopyButton text={codeText} />
                    <div className="whitespace-pre-wrap px-4 py-3 text-[14px] leading-relaxed text-cream select-text">
                      {codeText}
                    </div>
                  </div>
                )
              }
              return (
                <div className="relative my-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-1">
                  {lang && (
                    <div className="flex items-center justify-between border-b border-border-subtle bg-bg-2 px-4 py-1.5">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted">{lang}</span>
                    </div>
                  )}
                  <CopyButton text={codeText} />
                  <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                    <code className="font-mono text-cream">{codeText}</code>
                  </pre>
                </div>
              )
            }
            return (
              <code
                className="rounded-md border border-[#E07A5F]/15 bg-[#E07A5F]/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-[#E07A5F] [overflow-wrap:anywhere]"
                {...props}
              >
                {children}
              </code>
            )
          },
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto rounded-xl border border-border-subtle bg-card/80 shadow-sm">
                <table className="w-full min-w-[280px] text-sm">{children}</table>
              </div>
            )
          },
          thead({ children }) { return <thead className="border-b border-border-subtle bg-white/[0.04]">{children}</thead> },
          tbody({ children }) { return <tbody className="divide-y divide-white/[0.06]">{children}</tbody> },
          tr({ children }) { return <tr className="hover:bg-white/[0.03]">{children}</tr> },
          th({ children }) {
            return <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-[#E07A5F]">{children}</th>
          },
          td({ children }) { return <td className="px-4 py-2.5 text-[13px] text-cream">{children}</td> },
          blockquote({ children }) {
            return (
              <blockquote className="my-3 border-l-2 border-[#E07A5F] pl-4 italic text-muted-hi">
                {children}
              </blockquote>
            )
          },
          hr() { return <hr className="my-4 border-border-subtle" /> },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#E07A5F] underline underline-offset-2 hover:text-[#81B29A] [overflow-wrap:anywhere]">
                {children}
              </a>
            )
          },
          strong({ children }) { return <strong className="font-bold text-cream">{children}</strong> },
          em({ children }) { return <em className="italic text-muted-hi">{children}</em> },
          img({ src, alt }) { return <ImageWithDownload src={typeof src === 'string' ? src : undefined} alt={typeof alt === 'string' ? alt : undefined} /> },
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
