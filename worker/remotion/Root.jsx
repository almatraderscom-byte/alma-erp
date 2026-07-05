// Phase V3 — composition registry. Dimensions/duration come from the plan
// (built by the unit-tested app-side planner) via calculateMetadata, so the
// same composition serves every aspect and length.
import React from 'react'
import { Composition } from 'remotion'
import { FinishOverlay } from './FinishOverlay.jsx'

const DEFAULT_PLAN = {
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: 450,
  items: [],
}

export const Root = () => (
  <Composition
    id="FinishOverlay"
    component={FinishOverlay}
    durationInFrames={DEFAULT_PLAN.durationInFrames}
    fps={DEFAULT_PLAN.fps}
    width={DEFAULT_PLAN.width}
    height={DEFAULT_PLAN.height}
    defaultProps={{ plan: DEFAULT_PLAN, logoDataUrl: null }}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.plan.durationInFrames,
      fps: props.plan.fps,
      width: props.plan.width,
      height: props.plan.height,
    })}
  />
)
