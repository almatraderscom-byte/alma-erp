'use client'

import { CreativeStudioShell } from './CreativeStudioShell'
import type { StudioWebV4Target } from './studio-version'

export default function CreativeStudio({
  v4Targets,
}: {
  v4Targets: StudioWebV4Target[]
}) {
  return <CreativeStudioShell v4Targets={v4Targets} />
}
