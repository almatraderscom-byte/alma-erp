//
//  AlmaNativeRouter.kt
//  ALMA ERP — route-path → native Compose screen map (twin of AlmaNativeRouter.swift).
//
//  The More menu (and any other push) consults this router first: a migrated page
//  opens its native screen; everything else falls back to a WebView — one additive
//  entry per migrated page, no per-row wiring. Screens receive the PushCtx whose
//  openWebForced NEVER routes back through here (recursion guard, same as iOS).
//

package com.almatraders.erp.shell

import androidx.compose.runtime.Composable

class NativeDestination(
    val title: String,
    val content: @Composable (PushCtx) -> Unit,
)

object AlmaNativeRouter {

    /** Native screen for a bare route path, or null → open the web view as before.
     *  Cases are appended page-by-page as the Android migration progresses
     *  (mirrors the iOS S6 marathon; see ANDROID_NATIVE_MIGRATION_HANDOFF.md). */
    fun screen(path: String): NativeDestination? = when (path) {
        "/", "/dashboard" -> NativeDestination("Dashboard") { ctx ->
            com.almatraders.erp.pages.DashboardScreen(ctx)
        }
        "/orders/new" -> NativeDestination("নতুন অর্ডার") { ctx ->
            com.almatraders.erp.pages.OrderCreateScreen(ctx)
        }
        else -> null
    }
}
