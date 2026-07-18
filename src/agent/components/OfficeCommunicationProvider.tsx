'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useSession } from 'next-auth/react'
import { isSystemOwner } from '@/lib/roles'
import {
  IntercomCall,
  IntercomStyle,
  IntercomTakeover,
  useIntercom,
  type Intercom,
} from '@/app/portal/office/intercom'

const OfficeCommunicationContext = createContext<Intercom | null>(null)

function hasLifestyleAccess(access: string | null | undefined): boolean {
  return String(access ?? '')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .some((part) => part === 'ALL' || part === 'ALMA_LIFESTYLE')
}

function OfficeCommunicationRuntime({ self, children }: { self: 'owner' | 'staff'; children: ReactNode }) {
  const intercom = useIntercom(self)

  return (
    <OfficeCommunicationContext.Provider value={intercom}>
      {children}
      <IntercomStyle />
      {self === 'staff' && <IntercomTakeover itc={intercom} />}
      <IntercomCall itc={intercom} />
    </OfficeCommunicationContext.Provider>
  )
}

/**
 * Owns Office calling above the route tree. Closing the chat drawer or navigating
 * away from /portal/office therefore cannot unmount the Agora client/hot mic.
 * Native shells still own their CallKit/Core-Telecom media session; the web call
 * surface is suppressed there by IntercomCall.
 */
export function OfficeCommunicationProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession()
  if (status !== 'authenticated' || !session?.user || !hasLifestyleAccess(session.user.businessAccess)) {
    return <>{children}</>
  }

  return (
    <OfficeCommunicationRuntime self={isSystemOwner(session) ? 'owner' : 'staff'}>
      {children}
    </OfficeCommunicationRuntime>
  )
}

export function useOfficeCommunication(): Intercom {
  const context = useContext(OfficeCommunicationContext)
  if (!context) throw new Error('Office communication is unavailable for this account')
  return context
}
