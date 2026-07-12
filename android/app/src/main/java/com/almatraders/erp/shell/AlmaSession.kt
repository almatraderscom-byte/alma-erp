//
//  AlmaSession.kt
//  ALMA ERP — one shared identity/role source for the native screens (security audit
//  2026-07-12). Fetched once from GET /api/users/me (→ user.role, an AlmaRole string:
//  SUPER_ADMIN | ADMIN | HR | STAFF | VIEWER) + GET /api/assistant/more-pulse (isOwner,
//  businessAccess). Screens read the derived flags to HIDE privileged write UI for
//  non-admins — defense-in-depth so a missing server route-gate can't be reached
//  natively. The server stays the real authority; this only stops the app from
//  OFFERING an action the user can't perform.
//

package com.almatraders.erp.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

object AlmaSession {

    /** AlmaRole string, or null until loaded / on failure (treat null as least-privilege). */
    var role by mutableStateOf<String?>(null)
        private set

    /** System owner (isSystemOwner on the server). */
    var isOwner by mutableStateOf(false)
        private set

    /** Business ids the user may access (ERP businessAccess). */
    var businessAccess by mutableStateOf(listOf<String>())
        private set

    @Volatile private var loaded = false

    /** SUPER_ADMIN or ADMIN — the web `isAdminRole` gate for business-module writes. */
    val isAdmin: Boolean get() = isOwner || role == "SUPER_ADMIN" || role == "ADMIN"

    /** Trading/Digital admin-only writes (accounts, targets, HR, invoices, payments). */
    val canManageBusiness: Boolean get() = isAdmin

    /**
     * Normalised role used for nav gating. The system owner is always SUPER_ADMIN.
     * A not-yet-loaded / blank role falls back to STAFF (least-privilege) so the app
     * NEVER flashes privileged nav before the real role arrives — it only ever GAINS
     * sections once loaded, never wrongly shows them first.
     */
    val effectiveRole: String
        get() = when {
            isOwner -> AlmaRoles.SUPER_ADMIN
            role != null -> AlmaRoles.normalize(role)
            else -> AlmaRoles.STAFF
        }

    /** Should this role see/reach a route? Defense-in-depth mirror of the web nav gate. */
    fun canSee(path: String, businessId: String = AlmaBusinesses.LIFESTYLE): Boolean =
        AlmaAccess.isPathAllowedForRole(path, effectiveRole, businessId)

    suspend fun load(force: Boolean = false) {
        if (loaded && !force) return
        // Role from /api/users/me (authoritative role string).
        try {
            val me = AlmaApi.getObject("/api/users/me")
            val u = me.optJSONObject("user") ?: me.optJSONObject("data") ?: me
            u.str("role")?.let { role = it }
            u.flexBool("isSystemOwner")?.let { if (it) isOwner = true }
        } catch (_: Exception) { /* leave least-privilege */ }
        // Owner flag + business access from more-pulse (best-effort).
        try {
            val pulse = AlmaApi.getObject("/api/assistant/more-pulse")
            val p = pulse.optJSONObject("data") ?: pulse
            p.flexBool("isOwner")?.let { if (it) isOwner = true }
            p.optJSONArray("businessAccess")?.let { arr ->
                businessAccess = (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
            }
        } catch (_: Exception) { }
        loaded = true
    }
}

/** Ensures AlmaSession is loaded once when a gated screen appears. Read the flags after. */
@Composable
fun RememberSession() {
    LaunchedEffect(Unit) { AlmaSession.load() }
}
