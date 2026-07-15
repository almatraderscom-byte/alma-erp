//
//  NativePush.kt
//  ALMA ERP — native OneSignal bootstrap.
//
//  WHY THIS EXISTS (root cause, read from the owner's own phone's logcat):
//
//      W OneSignal: suspendInitInternal: no appId provided or found in local storage.
//                   Please pass a valid appId to initWithContext().
//
//  OneSignal was only ever initialised from the WEB layer — <OneSignalPushManager>, a
//  React component that calls OneSignal.initialize(appId) when it mounts. This app is
//  native-first: the shell renders Compose screens and keeps the WebView at 1dp, so that
//  component never mounts, so initialize() was never called. OneSignal therefore had no
//  app id, never registered, never minted an FCM token, and EVERY Android push — calls
//  included — was silently dropped. (OneSignal's dashboard showed it plainly: 0 of 10
//  Android devices ever had a token, while iOS/web had them.)
//
//  So the native shell now owns the bootstrap: initialise with the app id at startup,
//  then attach our ERP user id (the external_id every push is addressed to) as soon as
//  the session resolves. The web path is left untouched — initialize()/login() are
//  idempotent, so a WebView that does mount simply re-affirms the same values.
//
package com.almatraders.erp.shell

import android.content.Context
import android.util.Log
import com.onesignal.OneSignal
import com.onesignal.debug.LogLevel

object NativePush {

    /** Public OneSignal app id (same value the web bundle already ships as
     *  NEXT_PUBLIC_ONESIGNAL_APP_ID — it is not a secret). */
    private const val APP_ID = "db2c4411-612e-4705-beb3-dfe71a3fd5d8"

    private const val TAG = "AlmaNativePush"

    @Volatile private var initialized = false
    @Volatile private var loggedInUserId: String? = null

    /** Call once at app start, before anything needs push. Safe to call repeatedly. */
    fun init(context: Context) {
        if (initialized) return
        runCatching {
            // WARN keeps registration failures visible in logcat without the verbose noise.
            OneSignal.Debug.logLevel = LogLevel.WARN
            OneSignal.initWithContext(context.applicationContext, APP_ID)
            initialized = true
            Log.i(TAG, "OneSignal initialised natively with appId=$APP_ID")
        }.onFailure { Log.w(TAG, "OneSignal init failed: ${it.message}") }
    }

    /**
     * Attach this device to our ERP user so pushes addressed to that external_id land
     * here. Call whenever the session resolves (and after a re-login). No-ops when the
     * id hasn't changed.
     */
    fun login(context: Context, userId: String?) {
        if (userId.isNullOrBlank()) return
        init(context)
        if (loggedInUserId == userId) return
        runCatching {
            OneSignal.login(userId)
            loggedInUserId = userId
            Log.i(TAG, "OneSignal.login($userId)")
            // Report the SDK's own view a few seconds later so logcat shows whether a
            // token actually landed — "no error" is not the same as "registered".
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ logState() }, 20_000)
        }.onFailure { Log.w(TAG, "OneSignal.login failed: ${it.message}") }
    }

    /**
     * Android 14+ (API 34) gates full-screen intents behind a SEPARATE special access —
     * holding USE_FULL_SCREEN_INTENT in the manifest is NOT enough. Proven on the owner's
     * S25 Ultra: the call notification posted fine but Android tagged it
     * "FSI_REQUESTED_BUT_DENIED", so the ring showed as a banner and the full-screen call
     * never appeared. Send the user to the toggle once; without it a staff phone can
     * never show a WhatsApp-style incoming call.
     *
     * @return true when access is already granted (nothing shown).
     */
    fun ensureFullScreenCallAccess(activity: android.app.Activity): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 34) return true
        val nm = activity.getSystemService(android.app.NotificationManager::class.java)
        if (nm?.canUseFullScreenIntent() == true) return true
        val prefs = activity.getSharedPreferences("alma_push", Context.MODE_PRIVATE)
        if (prefs.getBoolean("fsi_prompted", false)) return false   // asked once; don't nag
        prefs.edit().putBoolean("fsi_prompted", true).apply()
        runCatching {
            android.widget.Toast.makeText(
                activity,
                "কল যেন পুরো স্ক্রিনে আসে — ALMA-কে \"ফুল স্ক্রিন নোটিফিকেশন\" অনুমতি দিন",
                android.widget.Toast.LENGTH_LONG,
            ).show()
            activity.startActivity(
                android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    android.net.Uri.parse("package:${activity.packageName}"),
                ),
            )
        }.onFailure { Log.w(TAG, "FSI settings unavailable: ${it.message}") }
        return false
    }

    /** Non-secret diagnostics for logcat — is this device actually push-capable? */
    fun logState() {
        runCatching {
            val sub = OneSignal.User.pushSubscription
            Log.i(TAG, "push optedIn=${sub.optedIn} id=${sub.id} token=${if (sub.token.isNullOrEmpty()) "EMPTY" else "present(${sub.token!!.length})"}")
        }.onFailure { Log.w(TAG, "push state unavailable: ${it.message}") }
    }
}
