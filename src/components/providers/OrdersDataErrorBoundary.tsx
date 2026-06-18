'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logEvent } from '@/lib/logger'
import { Button, Card } from '@/components/ui'

type Props = { children: ReactNode }

type State = { hasError: boolean; message: string }

function isOrdersContextError(error: Error): boolean {
  const m = error.message || ''
  return m.includes('useOrdersData') || m.includes('OrdersDataProvider')
}

export class OrdersDataErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: Error): State {
    if (!isOrdersContextError(error)) throw error
    return { hasError: true, message: error.message || 'Orders context unavailable' }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logEvent('warn', 'orders.provider.missing', {
      message: error.message,
      componentStack: info.componentStack?.split('\n').slice(0, 4).join(' | '),
    })
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="p-6 md:p-10">
        <Card className="max-w-lg p-6 space-y-3 border-amber-500/30 bg-amber-500/5">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">Orders data unavailable</p>
          <p className="text-sm text-muted">
            This screen needs lifestyle orders data, but the provider is not active for your current business or route.
            Switch to Alma Lifestyle or open Trading from the business menu.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => this.setState({ hasError: false, message: '' })}>
              Retry
            </Button>
            <Button size="sm" onClick={() => { window.location.href = '/' }}>
              Go home
            </Button>
          </div>
        </Card>
      </div>
    )
  }
}
