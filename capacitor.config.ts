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
    backgroundColor: '#FAF9F6',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#FAF9F6',
  },
  plugins: {
    Keyboard: {
      /** We own the layout: keep the WebView full-height and pin the composer
       *  ourselves via --kb-inset. 'none' stops iOS from also resizing/scrolling. */
      resize: KeyboardResize.None,
      resizeOnFullScreen: true,
    },
    SplashScreen: {
      // Short: the local bootstrap (mobile/www/index.html) paints instantly, so
      // hand off to its ALMA animation fast instead of holding a static frame.
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#FAF9F6',
      androidSplashResourceName: 'splash',
      // The bootstrap page provides its own motion; the native spinner would
      // clash with it during the brief overlap.
      showSpinner: false,
      spinnerColor: '#C9A84C',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#08080A',
    },
  },
}

export default config
