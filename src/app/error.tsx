'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { captureException } from '@/lib/sentry/capture'
import { logRuntimeMobileCrash } from '@/lib/mobile-runtime-log'
import { Button, Card } from '@/components/ui'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const pathname = usePathname()
  const { data: session, status: sessionStatus } = useSession()
  const businessId = session?.user?.businessAccess?.split(',')[0]?.trim()

  useEffect(() => {
    logRuntimeMobileCrash({
      userId: session?.user?.id,
      businessId,
      pathname,
      sessionStatus,
      message: error.message,
      digest: error.digest,
      hydrationState: 'route_error',
      error,
    })
    void captureException(error, {
      category: 'client',
      event: 'react.route_error',
      critical: true,
      extra: { digest: error.digest, pathname, businessId },
    })
  }, [error, pathname, session?.user?.id, businessId, sessionStatus])

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <Card className="max-w-md p-6 space-y-4 text-center border-[#E07A5F]/20 bg-white">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#E07A5F]">Page error</p>
        <p className="text-sm text-slate-600">This section failed to load. The error was reported automatically.</p>
        <div className="flex justify-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => reset()}>
            Retry
          </Button>
          <Button size="sm" onClick={() => { window.location.href = '/portal' }}>
            My Desk
          </Button>
        </div>
      </Card>
    </div>
  )
}
