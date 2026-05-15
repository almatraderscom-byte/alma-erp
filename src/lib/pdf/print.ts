const A4_PRINT_CSS = `
@page { size: 210mm 297mm; margin: 0; }
html, body {
  width: 210mm; height: 297mm; margin: 0 !important; padding: 0 !important;
  overflow: hidden;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
embed, iframe, object {
  width: 210mm !important; height: 297mm !important;
  display: block; border: none;
}
@media print { html, body { width: 210mm; height: 297mm; } }
`

/** Open PDF blob in A4-sized window — no browser auto-scaling */
export function printPdfBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>${A4_PRINT_CSS}</style></head><body><embed src="${url}" type="application/pdf" width="210mm" height="297mm"/><script>window.onload=function(){setTimeout(function(){window.print()},400)}</script></body></html>`
  const w = window.open('', '_blank')
  if (!w) {
    URL.revokeObjectURL(url)
    throw new Error('Allow popups to print')
  }
  w.document.write(html)
  w.document.close()
}
