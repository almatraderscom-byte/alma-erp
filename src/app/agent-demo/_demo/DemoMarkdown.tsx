'use client'

import React from 'react'

// Lightweight markdown renderer for the demo — handles headings, bold, lists,
// and simple tables. Keeps the demo self-contained (no extra deps).

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-[#1a1a2e]">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>
  })
}

export default function DemoMarkdown({ content }: { content: string }) {
  const lines = content.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Table
    if (line.trim().startsWith('|') && lines[i + 1]?.includes('---')) {
      const header = line.split('|').map((c) => c.trim()).filter(Boolean)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].split('|').map((c) => c.trim()).filter(Boolean))
        i++
      }
      blocks.push(
        <div key={key++} className="my-3 overflow-hidden rounded-xl border border-black/[0.07]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#E07A5F]/[0.06]">
                {header.map((h, hi) => (
                  <th key={hi} className="px-3 py-2 text-left font-semibold text-[#1a1a2e]">
                    {renderInline(h, `th-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-t border-black/[0.05]">
                  {r.map((c, ci) => (
                    <td key={ci} className="px-3 py-2 text-[#475569]">
                      {renderInline(c, `td-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (line.startsWith('### ')) {
      blocks.push(
        <h3 key={key++} className="mt-4 mb-1.5 text-[15px] font-semibold text-[#1a1a2e]">
          {renderInline(line.slice(4), `h3-${key}`)}
        </h3>,
      )
      i++
      continue
    }
    if (line.startsWith('## ')) {
      blocks.push(
        <h2 key={key++} className="mt-4 mb-2 text-[17px] font-bold text-[#1a1a2e]">
          {renderInline(line.slice(3), `h2-${key}`)}
        </h2>,
      )
      i++
      continue
    }

    // List group
    if (line.trim().startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().slice(2))
        i++
      }
      blocks.push(
        <ul key={key++} className="my-2 flex flex-col gap-1.5 pl-1">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2 text-[15px] leading-relaxed text-[#1a1a2e]">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#E07A5F]" />
              <span>{renderInline(it, `li-${ii}`)}</span>
            </li>
          ))}
        </ul>,
      )
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    blocks.push(
      <p key={key++} className="my-1.5 text-[15px] leading-[1.7] text-[#1a1a2e]">
        {renderInline(line, `p-${key}`)}
      </p>,
    )
    i++
  }

  return <div className="select-text">{blocks}</div>
}
