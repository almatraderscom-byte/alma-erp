'use client'

import { CreativeStudioShell } from './CreativeStudioShell'

export default function CreativeStudio({ canUseV4 }: { canUseV4: boolean }) {
  return <CreativeStudioShell canUseV4={canUseV4} />
}
