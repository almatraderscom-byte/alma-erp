export interface ParsedSseEvent {
  data: string
  event: string
  id?: string
}

/**
 * Incremental WHATWG-style SSE parser. It operates on bytes so TextDecoder can
 * retain partial UTF-8 code points, and retains incomplete CRLF/line/event state
 * across arbitrary network chunks.
 */
export class IncrementalSseParser {
  private readonly decoder = new TextDecoder()
  private text = ''
  private dataLines: string[] = []
  private eventType = ''
  private lastEventId = ''
  private firstText = true
  private ended = false

  push(chunk: Uint8Array): ParsedSseEvent[] {
    if (this.ended) return []
    return this.consumeText(this.decoder.decode(chunk, { stream: true }), false)
  }

  finish(): ParsedSseEvent[] {
    if (this.ended) return []
    this.ended = true
    return this.consumeText(this.decoder.decode(), true)
  }

  private consumeText(fragment: string, final: boolean): ParsedSseEvent[] {
    this.text += fragment
    if (this.firstText && this.text.length > 0) {
      this.firstText = false
      if (this.text.charCodeAt(0) === 0xfeff) this.text = this.text.slice(1)
    }

    const events: ParsedSseEvent[] = []
    while (true) {
      const boundary = this.findLineBoundary(final)
      if (!boundary) break
      const line = this.text.slice(0, boundary.index)
      this.text = this.text.slice(boundary.index + boundary.length)
      this.consumeLine(line, events)
    }

    if (final) {
      if (this.text.length > 0) {
        this.consumeLine(this.text, events)
        this.text = ''
      }
      this.dispatch(events)
    }
    return events
  }

  private findLineBoundary(final: boolean): { index: number; length: number } | null {
    for (let index = 0; index < this.text.length; index += 1) {
      const code = this.text.charCodeAt(index)
      if (code === 0x0a) return { index, length: 1 }
      if (code !== 0x0d) continue
      // A CR at a chunk boundary might be the first half of CRLF. Retain it
      // until one more byte arrives (or EOF proves it is a lone CR delimiter).
      if (index + 1 >= this.text.length && !final) return null
      return {
        index,
        length: this.text.charCodeAt(index + 1) === 0x0a ? 2 : 1,
      }
    }
    return null
  }

  private consumeLine(line: string, events: ParsedSseEvent[]) {
    if (line === '') {
      this.dispatch(events)
      return
    }
    if (line.startsWith(':')) return

    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') {
      this.dataLines.push(value)
    } else if (field === 'event') {
      this.eventType = value
    } else if (field === 'id' && !value.includes('\0')) {
      this.lastEventId = value
    }
    // `retry` and unknown fields are valid but do not affect this fetch client.
  }

  private dispatch(events: ParsedSseEvent[]) {
    if (this.dataLines.length === 0) {
      this.eventType = ''
      return
    }
    events.push({
      data: this.dataLines.join('\n'),
      event: this.eventType || 'message',
      ...(this.lastEventId ? { id: this.lastEventId } : {}),
    })
    this.dataLines = []
    this.eventType = ''
  }
}
