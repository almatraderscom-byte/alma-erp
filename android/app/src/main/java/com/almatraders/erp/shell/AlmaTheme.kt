//
//  AlmaTheme.kt
//  ALMA ERP — Android native shell theme. Kotlin/Compose twin of the iOS pair
//  AlmaTheme (SpikeNativeShell.swift) + AlmaSwiftTheme (SwiftUIShell.swift).
//
//  Owner rule (same as iOS): native screens wear the app's OWN colours — cream/aurora
//  light, deep-violet dark, coral+violet accents — never stock Material greys.
//  Values MUST stay equal to the iOS tokens and the web CSS variables.
//
//  Dark/light state: SharedPreferences "alma-theme-mode" (same key name as the iOS
//  UserDefaults) is the synchronous launch source; the web `alma-theme` cookie is
//  one-way native→web (iOS lesson: cookie read-back reverted launches).
//

package com.almatraders.erp.shell

import android.content.Context
import android.webkit.CookieManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color

object AlmaTheme {

    const val BASE_URL = "https://alma-erp-six.vercel.app"
    private const val PREFS = "alma-native-shell"
    private const val THEME_KEY = "alma-theme-mode"      // same name as iOS UserDefaults key
    private const val FLAG_KEY = "alma-native-screens"   // iOS: "alma-swiftui-screens"

    /** Compose-observable dark flag — single source of truth for the native chrome. */
    var isDark by mutableStateOf(false)
        private set

    /** Native-screens escape hatch (default ON, same as iOS AlmaSwiftUIFlag). */
    var nativeScreensOn by mutableStateOf(true)
        private set

    fun loadInitial(context: Context) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        isDark = p.getString(THEME_KEY, "light") == "dark"
        nativeScreensOn = p.getBoolean(FLAG_KEY, true)
    }

    fun setDark(context: Context, dark: Boolean) {
        isDark = dark
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(THEME_KEY, if (dark) "dark" else "light").apply()
        // One-way native → web: cookie + data-theme (the WebViews also get applyJs()).
        val cm = CookieManager.getInstance()
        cm.setCookie(BASE_URL, "alma-theme=${if (dark) "dark" else "light"}; path=/; max-age=31536000; SameSite=Lax")
        cm.flush()
    }

    fun setNativeScreens(context: Context, on: Boolean) {
        nativeScreensOn = on
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(FLAG_KEY, on).apply()
    }

    /** Same JS the iOS shell evaluates on every WebView after a theme flip. */
    fun applyJs(): String {
        val mode = if (isDark) "dark" else "light"
        return "(function(){try{document.documentElement.dataset.theme='$mode';" +
            "document.cookie='alma-theme=$mode; path=/; max-age=31536000; SameSite=Lax';}catch(e){}})();"
    }

    // ── Brand accents (identical hex to iOS AlmaSwiftTheme) ──────────────────────
    val coral = Color(0xFFE07A5F)
    val violet = Color(0xFFA78BFA)
    val sage = Color(0xFF81B29A)

    fun rootBg(dark: Boolean) = if (dark) Color(0xFF0B0A12) else Color(0xFFF2F0F8)
    fun cardBg(dark: Boolean) = if (dark) Color(0xFF171521) else Color.White

    // ── iOS 27 kit tokens (metrics + semantic states — same numbers as iOS) ──────
    /** Concentric corner radii: card 26, control 14, sheet 34 (dp ≙ pt). */
    const val R_CARD = 26
    const val R_CONTROL = 14
    const val R_SHEET = 34
    /** Screen edge margin. */
    const val MARGIN = 16

    fun green(dark: Boolean) = if (dark) Color(0xFF30D158) else Color(0xFF34C759)
    fun red(dark: Boolean) = if (dark) Color(0xFFFF4245) else Color(0xFFFF383C)
    fun blue(dark: Boolean) = if (dark) Color(0xFF0091FF) else Color(0xFF0088FF)
    fun orange(dark: Boolean) = if (dark) Color(0xFFFF9230) else Color(0xFFFF8D28)
    fun separator(dark: Boolean) = if (dark) Color.White.copy(alpha = 0.17f) else Color.Black.copy(alpha = 0.12f)
    fun fill(dark: Boolean) = Color(0xFF787880).copy(alpha = if (dark) 0.32f else 0.16f)

    /** Primary / secondary text over the aurora (SwiftUI .primary/.secondary twins). */
    fun ink(dark: Boolean) = if (dark) Color(0xFFF2F0F8) else Color(0xFF171521)
    fun inkSecondary(dark: Boolean) = if (dark) Color.White.copy(alpha = 0.62f) else Color.Black.copy(alpha = 0.55f)
    fun inkTertiary(dark: Boolean) = if (dark) Color.White.copy(alpha = 0.36f) else Color.Black.copy(alpha = 0.30f)

    /** Whole-taka display with the web's short scale: ৳1.44L / ৳35.1K / ৳960. */
    fun takaShort(amount: Long): String {
        val a = kotlin.math.abs(amount)
        val sign = if (amount < 0) "-" else ""
        return when {
            a >= 100_000 -> "$sign৳${String.format("%.2f", a / 100_000.0)}L"
            a >= 10_000 -> "$sign৳${String.format("%.1f", a / 1_000.0)}K"
            else -> "$sign৳${grouped(a)}"
        }
    }

    fun takaShort(amount: Int): String = takaShort(amount.toLong())

    /** ৳12,345 with thousands separators (Int.formatted() twin). */
    fun taka(amount: Int): String =
        (if (amount < 0) "-" else "") + "৳" + grouped(kotlin.math.abs(amount.toLong()))

    private fun grouped(a: Long): String = String.format("%,d", a)
}
