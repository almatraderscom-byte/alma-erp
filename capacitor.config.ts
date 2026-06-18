import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

/**
 * Alma ERP native shell. No Next.js bundle is embedded; deploys to Vercel are
 * unchanged.
 *
 * Boot model: by DEFAULT (production build) the shell loads the local animated
 * bootstrap at mobile/www/index.html — it paints the ALMA animation instantly
 * (zero network), warms the TLS connection to production, then hands off to the
 * live site. This removes the white page that appeared when the old fixed-timer
 * splash hid before Vercel had responded (cold start).
 *
 * To load a remote URL directly (dev / preview only), set an explicit
 * CAPACITOR_SERVER_URL before `npx cap sync`. We intentionally do NOT fall back
 * to NEXT_PUBLIC_APP_URL so a stray env var can't silently bypass the bootstrap
 * in a production build.
 */
const remoteServerUrl = process.env.CAPACITOR_SERVER_URL || ''

const config: CapacitorConfig = {
  appId: 'com.almatraders.erp',
  appName: 'Alma ERP',
  webDir: 'mobile/www',
  server: {
    ...(remoteServerUrl ? { url: remoteServerUrl } : {}),
    cleartext: false,
    androidScheme: 'https',
  },
  ios: {
    handleApplicationNotifications: false,
    backgroundColor: '#0c0b12',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0c0b12',
  },
  plugins: {
    Keyboard: {
      /** Global default: ERP screens own their layout and pin footers via
       *  --kb-inset, so 'none' stops iOS from also resizing/scrolling. The agent
       *  screen overrides this at runtime (Keyboard.setResizeMode 'native') while
       *  mounted so its composer rides above the keyboard like a native app, then
       *  restores 'none' on unmount. See src/agent/hooks/useKeyboardInset.ts. */
      resize: KeyboardResize.None,
      resizeOnFullScreen: true,
    },
    SplashScreen: {
      // Short: the local bootstrap (mobile/www/index.html) paints instantly, so
      // hand off to its ALMA animation fast instead of holding a static frame.
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#0c0b12',
      androidSplashResourceName: 'splash',
      // The bootstrap page provides its own motion; the native spinner would
      // clash with it during the brief overlap.
      showSpinner: false,
      spinnerColor: '#8b7cf6',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#08080A',
    },
  },
}

export default config
