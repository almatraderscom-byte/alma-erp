'use client'

import { Toaster } from 'react-hot-toast'
import { AppToast } from './AppToast'

/**
 * AppToaster — client wrapper around react-hot-toast's <Toaster>.
 *
 * The render-prop child below is a FUNCTION. Next.js App Router forbids passing
 * functions from a Server Component (e.g. the root layout) to a Client Component
 * (<Toaster>) — doing so throws "Functions are not valid as a child of Client
 * Components" during SSR and 500s every route. Keeping the function inside this
 * 'use client' boundary means it never crosses the server→client edge.
 */
export function AppToaster() {
  return (
    <Toaster
      position="top-center"
      gutter={10}
      containerStyle={{ top: 'calc(env(safe-area-inset-top, 0px) + 14px)' }}
      toastOptions={{
        // Success/info auto-dismiss quickly; errors linger; loading stays until updated.
        duration: 3500,
        success: { duration: 3200 },
        error: { duration: 5000 },
        loading: { duration: Infinity },
      }}
    >
      {(t) => <AppToast t={t} />}
    </Toaster>
  )
}
