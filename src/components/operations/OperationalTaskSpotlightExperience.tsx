'use client'

import { OperationalTaskHero } from '@/components/operations/OperationalTaskHero'
import { OperationalTaskDock } from '@/components/operations/OperationalTaskDock'
import { useOperationalSpotlightTrigger } from '@/components/operations/useOperationalSpotlightTrigger'

type Props = {
  businessId: string
  enabled?: boolean
  onCheckInSuccessRef?: (fn: () => Promise<void>) => void
}

export function OperationalTaskSpotlightExperience({
  businessId,
  enabled = true,
  onCheckInSuccessRef,
}: Props) {
  const ops = useOperationalSpotlightTrigger(businessId, enabled)

  if (onCheckInSuccessRef) {
    onCheckInSuccessRef(ops.triggerAfterCheckIn)
  }

  return (
    <>
      <OperationalTaskHero
        businessId={businessId}
        assignment={ops.spotlight}
        open={ops.heroOpen}
        onMinimize={ops.minimizeHero}
        onUpdated={ops.handleUpdated}
      />
      <OperationalTaskDock
        businessId={businessId}
        tasks={ops.openTasks}
        primary={ops.primaryTask}
        heroOpen={ops.heroOpen}
        onReopen={() => ops.openHero()}
        onUpdated={ops.handleUpdated}
      />
    </>
  )
}

export { useOperationalSpotlightTrigger }
