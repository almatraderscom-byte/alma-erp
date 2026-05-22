/** iOS Safari / installed PWA modal viewport sync (freeze-safe, no UI framework). */

let lockDepth = 0
let savedScrollY = 0

function isIosLike(): boolean {
  if (typeof window === 'undefined') return false
  const ua = navigator.userAgent
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return iOS || (standalone && 'ontouchstart' in window)
}

export function syncIosVisualViewport(): void {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  const vv = window.visualViewport
  if (!vv) {
    root.style.removeProperty('--ios-vv-top')
    root.style.removeProperty('--ios-vv-left')
    root.style.removeProperty('--ios-vv-width')
    root.style.removeProperty('--ios-vv-height')
    root.style.removeProperty('--ios-keyboard-inset')
    return
  }
  root.style.setProperty('--ios-vv-top', `${vv.offsetTop}px`)
  root.style.setProperty('--ios-vv-left', `${vv.offsetLeft}px`)
  root.style.setProperty('--ios-vv-width', `${vv.width}px`)
  root.style.setProperty('--ios-vv-height', `${vv.height}px`)
  const keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
  root.style.setProperty('--ios-keyboard-inset', `${keyboardInset}px`)
}

export function lockIosModalScroll(): () => void {
  if (typeof window === 'undefined') return () => {}
  lockDepth += 1
  if (lockDepth > 1) return () => {
    lockDepth = Math.max(0, lockDepth - 1)
  }

  savedScrollY = window.scrollY
  const { body, documentElement: html } = document
  const main = document.querySelector('main.scrollbar-hide, main.flex-1.overflow-y-auto') as HTMLElement | null

  body.dataset.iosModalScrollLock = '1'
  html.classList.add('ios-modal-open')
  body.style.position = 'fixed'
  body.style.top = `-${savedScrollY}px`
  body.style.left = '0'
  body.style.right = '0'
  body.style.width = '100%'
  body.style.overflow = 'hidden'
  body.style.touchAction = 'none'

  if (main) {
    main.dataset.iosModalPrevOverflow = main.style.overflow || ''
    main.style.overflow = 'hidden'
  }

  if (isIosLike()) syncIosVisualViewport()

  return () => {
    lockDepth = Math.max(0, lockDepth - 1)
    if (lockDepth > 0) return

    body.style.position = ''
    body.style.top = ''
    body.style.left = ''
    body.style.right = ''
    body.style.width = ''
    body.style.overflow = ''
    body.style.touchAction = ''
    delete body.dataset.iosModalScrollLock
    html.classList.remove('ios-modal-open')

    if (main) {
      main.style.overflow = main.dataset.iosModalPrevOverflow || ''
      delete main.dataset.iosModalPrevOverflow
    }

    window.scrollTo(0, savedScrollY)
    syncIosVisualViewport()
  }
}

export function subscribeIosVisualViewport(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const vv = window.visualViewport
  if (!vv) return () => {}

  const handler = () => {
    syncIosVisualViewport()
    onChange()
  }
  vv.addEventListener('resize', handler)
  vv.addEventListener('scroll', handler)
  window.addEventListener('orientationchange', handler)
  handler()

  return () => {
    vv.removeEventListener('resize', handler)
    vv.removeEventListener('scroll', handler)
    window.removeEventListener('orientationchange', handler)
  }
}
