import { describe, expect, it } from 'vitest'
import {
  DIRECT_BROWSER_ALLOWED_TOOL_NAMES,
  DIRECT_BROWSER_SHELL_DENYLIST,
  directBrowserFallbackViolation,
  filterDirectBrowserToolInventory,
  isDirectBrowserExecutionTool,
  isDirectYouTubeBrowserTask,
  isPotentialYouTubeComputerUseMutation,
  isPotentialYouTubePlaybackMutation,
  isYouTubePlaybackRequest,
  sanitizeDirectBrowserFallbackMatches,
} from '../intent'

describe('direct YouTube browser intent', () => {
  it.each([
    'ইউটিউবে একটা মিউজিক প্লে করো',
    'YouTube-এ Coke Studio Bangla গানটা চালাও',
    'youtube e lofi music search kore play koro',
    'Open YouTube and play Interstellar soundtrack',
    'Play Fix You on YouTube',
    'Play Fix You by Coldplay on YouTube',
    'Play The Script on YouTube',
    'Play The Script Hall of Fame on YouTube',
    'Put on Fix You on YouTube',
    'Could you please play The Script on YouTube?',
    'YouTube-এ Fix You বাজাও',
    'ইউটিউবে গানটা বাজাও',
    'ইউটিউবে Fix You গানটা চালিয়ে দাও',
    'ইউটিউবে Fix You গানটা চালিয়ে দিন',
    'ইউটিউবে Fix You গানটা বাজিয়ে দেন',
    'ইউটিউবে Fix You গানটা বাজিয়ে দাও',
    'Play "500 taka khoroch holo" on YouTube',
    'Play today expense summary on YouTube',
    'Use Office Mac Chrome to play Fix You on YouTube',
    'On Office Mac, play Fix You on YouTube',
    'Start playing Fix You on YouTube',
    'Get Fix You playing on YouTube',
    'Could you start playing Fix You on YouTube?',
    'Could you get Fix You playing on YouTube?',
    'Have Fix You playing on YouTube',
    'Do play Fix You on YouTube',
  ])('recognizes witnessed browser work: %s', (text) => {
    expect(isDirectYouTubeBrowserTask(text)).toBe(true)
  })

  it.each([
    'YouTube API bug fix করো',
    'YouTube thumbnail বানাও',
    'YouTube music trends research করো',
    'Do not play anything on YouTube',
    "Why won't YouTube play music?",
    'How do I play music on YouTube?',
    'Where can I find Fix You on YouTube?',
    'Can YouTube play Fix You?',
    'Have you played Fix You on YouTube?',
    'ইউটিউবে গান কীভাবে চালাই?',
    'ইউটিউব কেন গান প্লে করছে না?',
  ])('rejects software/content/research/negated work: %s', (text) => {
    expect(isDirectYouTubeBrowserTask(text)).toBe(false)
  })

  it('distinguishes search-only from a playback request', () => {
    expect(isDirectYouTubeBrowserTask('Search YouTube for ALMA')).toBe(false)
    expect(isYouTubePlaybackRequest('Search YouTube for ALMA')).toBe(false)
    expect(isYouTubePlaybackRequest('Search YouTube and play ALMA')).toBe(true)
    expect(isPotentialYouTubePlaybackMutation('Please try playing Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubePlaybackMutation('Search YouTube for ALMA')).toBe(false)
  })

  it('keeps a broader execution catch-all for classifier wording drift', () => {
    expect(isPotentialYouTubeComputerUseMutation('Start playing Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('YouTube started playing unexpectedly')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Pause YouTube playback')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Mute YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Next video on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Resume YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Open YouTube settings')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Navigate to YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Go-to YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Type Fix You into YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Please try clicking Search on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Please try clicking the button on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Typing Fix You into YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Please try searching YouTube for Fix You')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Please try opening YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Finding Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Looking up Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Launching YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Visiting YouTube')).toBe(true)
    expect(isDirectYouTubeBrowserTask('Look up Fix You on YouTube')).toBe(false)
    expect(isDirectYouTubeBrowserTask('Launch YouTube')).toBe(false)
    expect(isDirectYouTubeBrowserTask('Visit YouTube')).toBe(false)
    expect(isPotentialYouTubeComputerUseMutation('Replay Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubePlaybackMutation('Replay Fix You on YouTube')).toBe(true)
    expect(isDirectYouTubeBrowserTask('Replay Fix You on YouTube')).toBe(false)
    expect(isPotentialYouTubeComputerUseMutation('Skip the YouTube ad')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Repeat the YouTube video')).toBe(true)
    expect(isPotentialYouTubePlaybackMutation('Repeat Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Restart the YouTube video')).toBe(true)
    expect(isPotentialYouTubePlaybackMutation('Restart Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Refresh YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Reload YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Reopen YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Unpause YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Go back on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Switch the YouTube tab')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Close the YouTube tab')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('ইউটিউবে ওই বাটনে ক্লিক করো')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('ইউটিউবে সার্চ বক্সে টাইপ করো')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('ইউটিউব স্ক্রল করো')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('ইউটিউব বন্ধ করো')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('ইউটিউবে ফাইল আপলোড করো')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Play Fix You on YouTube and research the artist')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Don't search YouTube; play Fix You on YouTube")).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Don't search YouTube; just play Fix You there")).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Don't open YouTube; click the result instead")).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Don't search YouTube but play Fix You there")).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Don't search YouTube just play Fix You")).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Don't search YouTube — just play Fix You")).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('How do I play music on YouTube? Actually, play Fix You there.')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('How about you click Search on YouTube?')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('How about clicking Search on YouTube?')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Have Fix You playing on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('Do play Fix You on YouTube')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Why don't you click Search on YouTube?")).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('What I want is for you to click Search on YouTube.')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('What I need you to do is click Search on YouTube.')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('What you should do is click Search on YouTube.')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation('How do I play music on YouTube?')).toBe(true)
    expect(isPotentialYouTubeComputerUseMutation("Don't click anything on YouTube")).toBe(true)
  })

  it('defines and sanitizes every non-Companion execution fallback', () => {
    const denied = [
      'run_mac_command',
      'start_cli_session',
      'send_to_cli_session',
      'drive_mac_app',
      'run_browser_task',
      'open_live_browser',
      'run_browser_recipe',
      'delegate_to_specialist',
      'manage_browser_logins',
    ]
    expect(denied.every((name) => DIRECT_BROWSER_SHELL_DENYLIST.has(name))).toBe(true)
    expect(DIRECT_BROWSER_SHELL_DENYLIST.has('live_browser_act')).toBe(false)
    expect([...DIRECT_BROWSER_ALLOWED_TOOL_NAMES].sort()).toEqual([
      'ask_user',
      'live_browser_act',
      'live_browser_look',
      'live_browser_pair',
      'live_browser_status',
    ])

    const data = {
      matches: [...denied, 'live_browser_act'].map((name) => ({ name })),
      note: 'existing note',
    }
    expect(sanitizeDirectBrowserFallbackMatches(data)).toEqual(denied)
    expect(data.matches.map((match) => match.name)).toEqual(['live_browser_act'])
    expect(data.note).toContain('existing note')
    expect(data.note).toContain('delegate_to_specialist')
  })

  it('makes the execution-time boundary independent of selector/membership mode', () => {
    expect(directBrowserFallbackViolation(true, 'run_mac_command')).toContain('FALLBACK_BLOCKED')
    expect(directBrowserFallbackViolation(true, 'run_browser_task')).toContain('FALLBACK_BLOCKED')
    expect(directBrowserFallbackViolation(true, 'delegate_to_specialist')).toContain('FALLBACK_BLOCKED')
    expect(directBrowserFallbackViolation(true, 'set_live_browser')).toContain('FALLBACK_BLOCKED')
    expect(directBrowserFallbackViolation(true, 'mac_desk_control')).toContain('FALLBACK_BLOCKED')
    expect(directBrowserFallbackViolation(true, 'some_future_browser_executor')).toContain('FALLBACK_BLOCKED')
    expect(directBrowserFallbackViolation(true, 'live_browser_trust')).toContain('FALLBACK_BLOCKED')
    expect(directBrowserFallbackViolation(true, 'live_browser_act')).toBeNull()
    expect(directBrowserFallbackViolation(true, 'ask_user')).toBeNull()
    expect(directBrowserFallbackViolation(false, 'run_mac_command')).toBeNull()
  })

  it('routes exact browser executors through the owner registry even in personal chat', () => {
    expect(isDirectBrowserExecutionTool('live_browser_look')).toBe(true)
    expect(isDirectBrowserExecutionTool('live_browser_act')).toBe(true)
    expect(isDirectBrowserExecutionTool('ask_user')).toBe(true)
    expect(isDirectBrowserExecutionTool('run_mac_command')).toBe(false)
  })

  it('re-closes inventory after generic plan/memory requirement injection', () => {
    const tools = [
      { name: 'live_browser_look' },
      { name: 'live_browser_act' },
      { name: 'make_plan' },
      { name: 'save_memory' },
    ]
    expect(filterDirectBrowserToolInventory(tools, true).map((tool) => tool.name)).toEqual([
      'live_browser_look',
      'live_browser_act',
    ])
    expect(filterDirectBrowserToolInventory(tools, false)).toEqual(tools)
  })
})
