import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

describe('iOS Office Robot simulator self-test', () => {
  it('waits for the real Intercom presentation before completing the drag demo', () => {
    const source = readFileSync(join(ROOT, 'ios/App/App/FloatingChatHead.swift'), 'utf8')
    const helper = source.slice(
      source.indexOf('private func debugOpenIntercomWhenReady'),
      source.indexOf('private func debugAnimateDirectionalDrag'),
    )

    expect(helper).toContain('root.presentedViewController == nil')
    expect(helper).toContain('root.transitionCoordinator == nil')
    expect(helper).toMatch(
      /openIntercom \{[\s\S]*RobotSelfTestTrace\.mark\("robotSelfTest\.openCall"\)[\s\S]*debugAnimateDirectionalDrag\(\)/,
    )
  })
})
