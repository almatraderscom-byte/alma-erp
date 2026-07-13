//
//  AlmaAccess.kt
//  ALMA ERP — role → route visibility, a 1:1 Kotlin port of the web authority
//  `isPathAllowedForRole` / `filterNavByRole` in src/lib/roles.ts. The native shell
//  and the More menu were building the FULL super-admin nav for every role (iOS
//  build-66 had the same gap — only the owner ever used it). This is the missing
//  gate: a non-privileged user must never even SEE a tab / section they can't use.
//
//  The server stays the real authority (routes + APIs enforce independently); this
//  only decides what the app OFFERS. It fails CLOSED — an unknown/blank role is
//  treated as the least-privilege STAFF baseline, never as admin.
//

package com.almatraders.erp.shell

/** The five ERP roles (mirrors AlmaRole in src/lib/roles.ts). */
object AlmaRoles {
    const val SUPER_ADMIN = "SUPER_ADMIN"
    const val ADMIN = "ADMIN"
    const val HR = "HR"
    const val STAFF = "STAFF"
    const val VIEWER = "VIEWER"

    /** Normalise any raw string to a known role; unknown → least-privilege VIEWER. */
    fun normalize(raw: String?): String {
        val u = (raw ?: "").trim().uppercase().replace(Regex("\\s+"), "_")
        return when (u) {
            SUPER_ADMIN, ADMIN, HR, STAFF, VIEWER -> u
            else -> VIEWER
        }
    }
}

/** The three businesses (mirrors BusinessId). */
object AlmaBusinesses {
    const val LIFESTYLE = "ALMA_LIFESTYLE"
    const val TRADING = "ALMA_TRADING"
    const val DIGITAL = "CREATIVE_DIGITAL_IT"
}

object AlmaAccess {

    private fun startsWith(path: String, prefix: String) = path.startsWith(prefix)
    private fun rootMatch(path: String, root: String) = path == root || path.startsWith("$root/")

    /**
     * 1:1 port of isPathAllowedForRole (src/lib/roles.ts). `role` is a normalised
     * AlmaRole string; `businessId` scopes the STAFF/HR route sets. We omit the
     * isRouteAllowed(business) pre-check because the native menu never lists a route
     * outside its business — the caller passes the business the route belongs to.
     */
    fun isPathAllowedForRole(
        pathname: String,
        role: String,
        businessId: String = AlmaBusinesses.LIFESTYLE,
    ): Boolean {
        if (startsWith(pathname, "/login") ||
            startsWith(pathname, "/forgot-password") ||
            startsWith(pathname, "/reset-password")
        ) return true

        if (startsWith(pathname, "/invoice/share")) return true
        if (startsWith(pathname, "/portal")) return true
        if (startsWith(pathname, "/settings/session")) return true

        if (startsWith(pathname, "/settings/database")) {
            return role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN || role == AlmaRoles.HR
        }
        if (startsWith(pathname, "/settings/notifications")) {
            return role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN
        }
        if (startsWith(pathname, "/trading/target-control")) {
            return role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN
        }
        if (startsWith(pathname, "/trading/telegram")) {
            if (role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN) return true
            if (role == AlmaRoles.STAFF && businessId == AlmaBusinesses.TRADING) return true
            return false
        }
        if (startsWith(pathname, "/operations")) return role == AlmaRoles.SUPER_ADMIN

        // Product-image screen is shared with Admins; everything else under /agent is owner-only.
        if (startsWith(pathname, "/agent/catalog-images")) {
            return role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN
        }
        if (startsWith(pathname, "/agent")) return role == AlmaRoles.SUPER_ADMIN

        if (startsWith(pathname, "/briefing")) return role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN
        if (startsWith(pathname, "/insights")) return role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN
        if (startsWith(pathname, "/activity")) return role == AlmaRoles.SUPER_ADMIN || role == AlmaRoles.ADMIN

        if (role == AlmaRoles.SUPER_ADMIN) return true

        // Finance hub, expense ledger and CDIT (digital) are owner/admin only.
        if (startsWith(pathname, "/finance") ||
            startsWith(pathname, "/expenses") ||
            startsWith(pathname, "/digital")
        ) return role == AlmaRoles.ADMIN

        if (startsWith(pathname, "/settings/users")) return role == AlmaRoles.ADMIN

        if (startsWith(pathname, "/audit") || startsWith(pathname, "/settings/branding")) return false

        if (role == AlmaRoles.VIEWER) {
            val deny = listOf("/settings/users", "/settings/branding", "/settings/database", "/audit")
            if (deny.any { pathname == it || pathname.startsWith("$it/") }) return false
            return true
        }

        if (role == AlmaRoles.ADMIN) {
            if (startsWith(pathname, "/employees")) return false
            return true
        }

        if (role == AlmaRoles.HR) {
            return if (businessId == AlmaBusinesses.TRADING) {
                listOf("/trading/hr", "/attendance", "/payroll", "/portal").any { rootMatch(pathname, it) }
            } else {
                listOf("/finance", "/expenses", "/employees", "/attendance", "/payroll", "/portal")
                    .any { rootMatch(pathname, it) }
            }
        }

        if (role == AlmaRoles.STAFF) {
            return when (businessId) {
                AlmaBusinesses.TRADING -> listOf("/trading", "/portal").any { rootMatch(pathname, it) }
                AlmaBusinesses.LIFESTYLE ->
                    listOf("/", "/orders", "/invoice", "/portal").any {
                        if (it == "/") pathname == "/" else rootMatch(pathname, it)
                    }
                else -> listOf("/digital", "/invoice", "/portal").any { rootMatch(pathname, it) }
            }
        }

        return false
    }
}
