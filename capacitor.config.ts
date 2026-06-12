import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Alma ERP Android shell — loads production from Vercel (remote URL).
 * No Next.js bundle is embedded; deploys to Vercel are unchanged.
 */
const productionUrl =
  process.env.CAPACITOR_SERVER_URL
  || process.env.NEXT_PUBLIC_APP_URL
  || 'https://alma-erp-six.vercel.app'

const config: CapacitorConfig = {
  appId: 'com.almatraders.erp',
  appName: 'Alma ERP',
  webDir: 'mobile/www',
  server: {
    url: productionUrl,
    cleartext: false,
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#08080A',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1400,
      launchAutoHide: true,
      backgroundColor: '#08080A',
      androidSplashResourceName: 'splash',
      showSpinner: true,
      spinnerColor: '#C9A84C',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#08080A',
    },
  },
}

export default config
