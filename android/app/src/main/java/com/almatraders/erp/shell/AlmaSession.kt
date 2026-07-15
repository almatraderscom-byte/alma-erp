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

    /** Our ERP User.id — the OneSignal external_id every push is addressed to.
     *  Without it OneSignal has no identity to attach this device to. */
    var userId by mutableStateOf<String?>(null)
        private set

    /** Business ids the user may access (ERP businessAccess). */
    var businessAccess by mutableStateOf(listOf<String>())
        private set

    @Volatile private var loaded = false

    /** App context (set once by the shell) so the session can drive NativePush.login. */
    @Volatile private var appContext: android.content.Context? = null
    fun attach(context: android.content.Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    /** Bumps after every COMPLETED load. Screens key their fetch on this so a fresh
     *  login (which force-reloads the session) makes them re-fetch automatically —
     *  the fix for "role-based nav/data didn't appear after signing in". */
    var authVersion by mutableStateOf(0)
        private set

    /** Tri-state auth signal for the startup gate:
     *   null  = not yet checked / couldn't reach the server (offline) → don't gate,
     *   true  = /users/me returned a user → signed in,
     *   false = server said 401/403 → NOT signed in → show the native login gate.
     *  Only a definite `false` gates, so an offline launch with a valid cookie still
     *  opens the app instead of wrongly forcing a login. */
    var authed by mutableStateOf<Boolean?>(null)
        private set

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
        // Role from /api/users/me (authoritative role string). A 401/403 here is the
        // definite "not signed in" signal that drives the startup login gate; a network
        // error leaves `authed` unknown (null) so we never gate an offline-but-valid user.
        try {
            val me = AlmaApi.getObject("/api/users/me")
            val u = me.optJSONObject("user") ?: me.optJSONObject("data") ?: me
            u.str("id")?.let { userId = it }
            u.str("role")?.let { role = it }
            u.flexBool("isSystemOwner")?.let { if (it) isOwner = true }
            authed = true
        } catch (e: AlmaApiException.NotAuthenticated) {
            authed = false
        } catch (_: Exception) { /* offline / transient — leave authed unknown */ }
        // Owner flag + business access from more-pulse (best-effort).
        try {
            val pulse = AlmaApi.getObject("/api/assistant/more-pulse")
            val p = pulse.optJSONObject("data") ?: pulse
            p.flexBool("isOwner")?.let { if (it) isOwner = true }
            p.optJSONArray("businessAccess")?.let { arr ->
                businessAccess = (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
            }
        } catch (_: Exception) { }
        // Attach this device to our user in OneSignal the moment we know who we are.
        // Push is addressed to this external_id; without the login the device is
        // anonymous and every targeted push (calls included) misses it.
        appContext?.let { ctx -> userId?.let { NativePush.login(ctx, it) } }
        loaded = true
        authVersion++          // signal every screen keyed on authVersion to re-fetch
    }

    /** Force a fresh identity fetch — call right after a successful sign-in so the role
     *  (and owner flag) update from the fail-closed STAFF default to the real values,
     *  and every screen keyed on [authVersion] reloads. Resets owner first so an
     *  account switch can't keep a stale elevated flag. */
    suspend fun reload() {
        isOwner = false
        role = null
        loaded = false
        load(force = true)
    }

    /** Clear all identity on explicit sign-out (fail closed to STAFF + gate to login). */
    fun signedOut() {
        isOwner = false
        role = null
        businessAccess = emptyList()
        loaded = false
        authed = false
        authVersion++
    }
}

/** Ensures AlmaSession is loaded once when a gated screen appears. Read the flags after. */
@Composable
fun RememberSession() {
    LaunchedEffect(Unit) { AlmaSession.load() }
}
