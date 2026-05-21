'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logRuntimeMobileCrash } from '@/lib/mobile-runtime-log'
import { Button, Card } from '@/components/ui'

type Props = {
  children: ReactNode
  section: string
  title?: string
}

type State = { hasError: boolean; message: string }

export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message || 'Section failed to load' }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const pathname = typeof window !== 'undefined' ? window.location.pathname : undefined
    logRuntimeMobileCrash({
      pathname,
      component: this.props.section,
      message: error.message,
      error,
      hydrationState: 'render',
      provider: info.componentStack?.split('\n').slice(0, 3).join(' | '),
    })
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <Card className="mx-4 my-6 max-w-lg border-amber-500/25 bg-amber-500/5 p-5 space-y-3">
        <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">
          {this.props.title || `${this.props.section} unavailable`}
        </p>
        <p className="text-sm text-zinc-400">
          This part of the page could not load. Other sections still work — try again or go to My Desk.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => this.setState({ hasError: false, message: '' })}
          >
            Retry section
          </Button>
          <Button size="sm" onClick={() => { window.location.href = '/portal' }}>
            My Desk
          </Button>
        </div>
      </Card>
    )
  }
}
