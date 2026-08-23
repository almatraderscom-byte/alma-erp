'use client'

import React, { useCallback } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { stripToolCallMarkup } from '@/agent/lib/model-output-sanitize'
import { classifyAgentMarkdownHref } from '@/agent/lib/markdown-link-router'
import { impactLight } from '@/lib/haptics'
import type { AgentReferenceV1 } from '@/agent/lib/references/types'

interface AgentMarkdownProps {
  content: string
  className?: string
  onArtifactDetected?: (content: string, type: 'code' | 'markdown') => void
  references?: AgentReferenceV1[]
  /** Is the server's verified-reference contract authoritative for THIS message?
   *  Only then does a link need a reference to be clickable. While the rollout is
   *  off/shadow — and for every history row written before the contract existed —
   *  the legacy sanitized-link and inline-image behaviour is the correct one, and
   *  turning those inert would be a visible regression in the default mode. */
  referencesActive?: boolean
  onArtifactOpen?: (id: string) => void
}

const MARKDOWN_LINK_CLASS = 'rounded-sm text-[#E07A5F] underline decoration-[#E07A5F]/45 underline-offset-2 transition-colors hover:text-[#81B29A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E07A5F]/45 [overflow-wrap:anywhere]'
const subscribeToStableOrigin = () => () => {}

function useCurrentOrigin(): string | undefined {
  return React.useSyncExternalStore(
    subscribeToStableOrigin,
    () => window.location.origin,
    () => undefined,
  )
}

function referenceHref(reference: AgentReferenceV1): string {
  if (reference.destination.type === 'internal_section') return reference.destination.webPath
  if (reference.destination.type === 'internal_entity') return reference.destination.webPath
  if (reference.destination.type === 'artifact_report') return reference.destination.apiPath
  return reference.destination.url
}

function ExternalReferenceBadge({ reference }: { reference: AgentReferenceV1 }) {
  if (reference.destination.type !== 'external_object'
    && reference.destination.type !== 'external_source'
    && reference.destination.type !== 'external_media') return null
  const provider = reference.display?.provider ?? reference.destination.provider
  const domain = reference.display?.domain ?? reference.destination.hostname
  return (
    <span className="ml-1 whitespace-nowrap text-[10px] font-medium no-underline opacity-70">
      [{provider} · {domain}]
    </span>
  )
}

function AgentMarkdownLink({
  href,
  children,
  reference,
  referencesActive,
  onArtifactOpen,
}: {
  href?: string
  children: React.ReactNode
  reference?: AgentReferenceV1
  referencesActive?: boolean
  onArtifactOpen?: (id: string) => void
}) {
  // Root-relative links classify identically during SSR and hydration. The exact
  // browser origin is learned after mount only so an absolute same-origin link can
  // also become an in-app navigation without introducing a hydration mismatch.
  const currentOrigin = useCurrentOrigin()

  const destination = React.useMemo(
    () => !referencesActive || (reference && href === referenceHref(reference))
      ? classifyAgentMarkdownHref(href, currentOrigin)
      : { kind: 'invalid' as const },
    [href, currentOrigin, reference, referencesActive],
  )

  // Legacy contract (rollout off/shadow, or a pre-contract history row): the
  // sanitized classifier alone decides, exactly as before this pipeline landed.
  if (!referencesActive) {
    if (destination.kind === 'internal') {
      return <Link href={destination.href} prefetch={false} className={MARKDOWN_LINK_CLASS}>{children}</Link>
    }
    if (destination.kind === 'external') {
      return (
        <a href={destination.href} target="_blank" rel="noopener noreferrer" className={MARKDOWN_LINK_CLASS}>
          {children}
        </a>
      )
    }
    return <span className={MARKDOWN_LINK_CLASS}>{children}</span>
  }

  // A readable label is harmless; clickability requires a structured reference
  // attached to this exact message. A plausible model-authored URL/path is inert.
  if (!reference) return <span>{children}</span>
  if (reference.destination.type === 'artifact_report') {
    const artifactId = reference.destination.artifactId
    return (
      <button
        type="button"
        className={MARKDOWN_LINK_CLASS}
        onClick={() => onArtifactOpen?.(artifactId)}
      >
        {children}
      </button>
    )
  }

  if (destination.kind === 'internal') {
    return <Link href={destination.href} prefetch={false} className={MARKDOWN_LINK_CLASS}>{children}</Link>
  }
  if (destination.kind === 'external') {
    return (
      <a href={destination.href} target="_blank" rel="noopener noreferrer" className={MARKDOWN_LINK_CLASS}>
        {children}<ExternalReferenceBadge reference={reference} />
      </a>
    )
  }
  // Keep the label readable, but never create a clickable element for an unsafe
  // or malformed destination — an inert label must not look like a link.
  return <span>{children}</span>
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = useCallback(() => {
    impactLight()
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'কপি হয়েছে' : 'কপি করুন'}
      aria-live="polite"
      className="absolute right-2 top-2 rounded-full bg-card/82 backdrop-blur-md border border-border px-2.5 py-1 text-[10px] font-semibold text-muted transition-all hover:bg-[#E07A5F]/10 hover:text-[#E07A5F] hover:border-[#E07A5F]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E07A5F]/45 active:scale-90"
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
function ImageWithDownload({
  src,
  alt,
  provider,
  domain,
  /** Legacy contract: trusted tool output loads inline with no consent step,
   *  exactly as it did before the reference pipeline existed. */
  immediate = false,
}: {
  src?: string
  alt?: string
  provider?: string
  domain?: string
  immediate?: boolean
}) {
  const [loaded, setLoaded] = React.useState(immediate)
  const [busy, setBusy] = React.useState(false)
  // Click = full-screen preview (owner ask 2026-07-15: "image e click korle boro
  // hoy na, direct download lekha thake") — download stays as the corner button.
  const [zoom, setZoom] = React.useState(false)
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
  // Verification controls what may be offered. Consent controls whether the
  // browser contacts that remote host at all (tracking pixels included).
  if (!loaded) {
    return (
      <span className="my-3 block rounded-xl border border-border-subtle bg-bg-1 p-4">
        <span className="block text-sm text-cream">{alt || 'ছবি'}</span>
        <span className="mt-1 block text-[10px] font-medium text-muted-hi">{provider} · {domain}</span>
        <button
          type="button"
          onClick={() => setLoaded(true)}
          className="mt-3 rounded-full border border-[#E07A5F]/30 bg-[#E07A5F]/10 px-3 py-1.5 text-xs font-semibold text-[#E07A5F]"
        >
          ছবি লোড করুন
        </button>
      </span>
    )
  }
  return (
    <span className="group relative my-3 block overflow-hidden rounded-xl border border-border-subtle bg-bg-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? ''}
        onClick={() => setZoom(true)}
        className="block h-auto w-full max-w-full cursor-zoom-in"
      />
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="absolute right-2 top-2 rounded-full bg-card/82 backdrop-blur-md border border-border px-2.5 py-1 text-[10px] font-semibold text-muted transition-all hover:bg-[#E07A5F]/10 hover:text-[#E07A5F] hover:border-[#E07A5F]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E07A5F]/45 active:scale-90 disabled:opacity-60"
      >
        {busy ? '…' : '⬇ ডাউনলোড'}
      </button>
      {zoom && (
        <span
          onClick={() => setZoom(false)}
          className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
          role="dialog"
          aria-label={alt || 'ছবির প্রিভিউ'}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt ?? ''} className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void download() }}
            disabled={busy}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-card/85 backdrop-blur-md border border-border px-4 py-2 text-[12px] font-semibold text-cream transition-all hover:bg-[#E07A5F]/15 hover:text-[#E07A5F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E07A5F]/45 active:scale-95 disabled:opacity-60"
          >
            {busy ? '…' : '⬇ ডাউনলোড'}
          </button>
        </span>
      )}
    </span>
  )
}

function AgentMarkdownInner({ content, className, references, referencesActive, onArtifactOpen }: AgentMarkdownProps) {
  // The server strips typed tool calls when the ROUND ends — which is too late
  // for the person watching it stream. Live on 2026-07-28 the owner read
  // `{"type": "tool_call", …}` as it arrived, and it vanished only afterwards.
  // Same repair, applied where the text is drawn, so a delta never shows machine
  // syntax even for the seconds before the round closes.
  const safe = React.useMemo(() => stripToolCallMarkup(content), [content])
  const referencesByHref = React.useMemo(() => {
    const map = new Map<string, AgentReferenceV1>()
    for (const reference of references ?? []) map.set(referenceHref(reference), reference)
    return map
  }, [references])
  return (
    <div className={cn('prose-agent select-text text-[15px] text-cream break-words [overflow-wrap:anywhere]', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p({ children }) {
            return <p className="mb-3.5 last:mb-0 leading-[1.75] text-cream">{children}</p>
          },
          h1({ children }) {
            return <h1 className="mb-4 mt-7 text-[22px] font-bold leading-tight tracking-[-0.015em] text-[#E07A5F] first:mt-0">{children}</h1>
          },
          h2({ children }) {
            return <h2 className="mb-3 mt-7 border-l-2 border-[#E07A5F]/80 pl-3 text-[18px] font-bold leading-snug tracking-[-0.01em] text-cream first:mt-0">{children}</h2>
          },
          h3({ children }) {
            return <h3 className="mb-2 mt-5 text-[15.5px] font-semibold leading-snug text-[#81B29A] first:mt-0">{children}</h3>
          },
          ul({ children }) {
            return <ul className="mb-4 ml-5 list-disc space-y-1.5 text-cream marker:text-[#E07A5F]">{children}</ul>
          },
          ol({ children }) {
            return <ol className="mb-4 ml-5 list-decimal space-y-1.5 text-cream marker:font-semibold marker:text-[#81B29A]">{children}</ol>
          },
          li({ children }) { return <li className="pl-1 leading-[1.65] text-cream [&>p]:mb-1">{children}</li> },
          code({ className: cls, children, ...props }) {
            const isBlock = cls?.startsWith('language-')
            // `children` is undefined for an EMPTY fence, and `String(undefined)`
            // is the literal word "undefined" — which is exactly what Boss saw on
            // his screen 2026-07-28: three cards in a row reading `undefined`.
            // An empty block has nothing to show, so it renders as nothing.
            const codeText = (children == null ? '' : String(children)).replace(/\n$/, '')
            if (isBlock && !codeText.trim()) return null
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
              <div className="my-5 overflow-x-auto rounded-xl border border-border-subtle bg-card/80 shadow-sm">
                <table className="w-full min-w-[280px] text-sm">{children}</table>
              </div>
            )
          },
          thead({ children }) { return <thead className="border-b border-border-subtle bg-[#E07A5F]/[0.055]">{children}</thead> },
          tbody({ children }) { return <tbody className="divide-y divide-white/[0.06]">{children}</tbody> },
          tr({ children }) { return <tr className="hover:bg-white/[0.03]">{children}</tr> },
          th({ children }) {
            return <th scope="col" className="px-4 py-3 text-left text-[12px] font-bold leading-snug text-[#E07A5F]">{children}</th>
          },
          td({ children }) { return <td className="px-4 py-3 text-[13px] leading-relaxed text-cream">{children}</td> },
          blockquote({ children }) {
            return (
              <blockquote role="note" className="my-5 rounded-r-xl border-l-2 border-[#E07A5F] bg-[#E07A5F]/[0.055] px-4 py-3 text-muted-hi [&>p]:mb-0">
                {children}
              </blockquote>
            )
          },
          hr() { return <hr className="my-6 border-border-subtle" /> },
          a({ href, children }) {
            return (
              <AgentMarkdownLink
                href={href}
                reference={href ? referencesByHref.get(href) : undefined}
                referencesActive={referencesActive}
                onArtifactOpen={onArtifactOpen}
              >
                {children}
              </AgentMarkdownLink>
            )
          },
          strong({ children }) { return <strong className="font-bold text-cream decoration-[#E07A5F]/30">{children}</strong> },
          em({ children }) { return <em className="italic text-muted-hi">{children}</em> },
          img({ src, alt }) {
            const value = typeof src === 'string' ? src : undefined
            const reference = value ? referencesByHref.get(value) : undefined
            // Legacy contract: trusted tool output (camera / Mac screenshots) is
            // rendered inline exactly as before. Those tools return a plain
            // `imageUrl` and mint no media reference, so requiring one here would
            // replace the screenshot the owner asked for with its alt text.
            if (!referencesActive) {
              return (
                <ImageWithDownload
                  src={value}
                  alt={typeof alt === 'string' ? alt : undefined}
                  immediate
                />
              )
            }
            if (!reference || reference.kind !== 'external_media'
              || reference.purpose !== 'media'
              || reference.destination.type !== 'external_media'
              || !reference.destination.mediaType?.toLowerCase().startsWith('image/')) {
              return <span className="text-muted-hi">{typeof alt === 'string' ? alt : 'ছবি'}</span>
            }
            return (
              <ImageWithDownload
                src={value}
                alt={typeof alt === 'string' ? alt : undefined}
                provider={reference.destination.provider}
                domain={reference.destination.hostname}
              />
            )
          },
        }}
      >
        {safe}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Memoize on `content` so finalized messages above a streaming one don't re-parse
 * markdown on every text_delta. ~10x render reduction during streaming.
 */
const AgentMarkdown = React.memo(AgentMarkdownInner, (prev, next) =>
  prev.content === next.content
    && prev.className === next.className
    && prev.references === next.references
    && prev.onArtifactOpen === next.onArtifactOpen,
)

export default AgentMarkdown
