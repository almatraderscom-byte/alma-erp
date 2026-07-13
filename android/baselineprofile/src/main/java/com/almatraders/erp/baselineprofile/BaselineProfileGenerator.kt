package com.almatraders.erp.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Generates the app's Baseline Profile. The app is login-gated, so this captures the
 * cold-start critical path — process init, Capacitor bridge boot, the native Compose
 * shell + aurora + tab bar first frame, and the native login screen — which is the
 * single most impactful stretch for perceived launch speed. Run with:
 *   ./gradlew :app:generateReleaseBaselineProfile
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun startup() = rule.collect(
        packageName = "com.almatraders.erp",
        // Also emit a startup profile — dexlayout groups these classes together in the
        // APK so the cold-start read is sequential, on top of the AOT baseline profile.
        includeInStartupProfile = true,
    ) {
        pressHome()
        startActivityAndWait()
        // Let the Compose shell settle its first frames.
        device.waitForIdle()
    }
}
