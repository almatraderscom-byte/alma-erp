//
//  MoreMenuScreen.kt
//  ALMA ERP — the More tab, ported 1:1 from MoreMenuSwiftUI.swift (iOS build 66,
//  Apple-Watch-app layout, owner spec 2026-07-08/09):
//    • header: glossy "Business" pill (business-switcher sheet) + round avatar
//      (profile sheet) + large user-name title. iOS keeps these in the host nav bar;
//      Android's shell header is fixed, so they live at the top of the screen content.
//    • "TODAY" hero carousel: live clock card · rotating alerts card · weekly/monthly
//      progress card (GET /api/assistant/more-pulse, fallback GET /api/users/me).
//    • nav groups are Settings-style rows that PUSH the group's own item page
//      (in-screen AnimatedContent push — PushCtx cannot push arbitrary native views).
//    • profile sheet: avatar upload (POST /api/users/me/profile-image), Appearance
//      (Dark Mode / accent colour / Native স্ক্রিন), Security (change password —
//      POST /api/users/me/password), Account (PATCH /api/users/me, email read-only),
//      NextAuth sign-out (csrf → POST /api/auth/signout → purge session cookies).
//
//  DEFERRED vs iOS build 66: Face ID / biometric app-lock rows (Android biometric
//  later — needs androidx.biometric), the "Phone Companion" native row and the DEBUG
//  loader preview (no Android twins yet).
//
//  Navigation stays in the host: item rows call ctx.openSmart(path, title).
//

package com.almatraders.erp.pages

import com.almatraders.erp.OfficeCallPushRegistration
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.webkit.CookieManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Analytics
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Brush
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Dataset
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Newspaper
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Paid
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PersonSearch
import androidx.compose.material.icons.outlined.PhoneMissed
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.QueryStats
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Rule
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material.icons.outlined.TrackChanges
import androidx.compose.material.icons.outlined.TrendingUp
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.PhonelinkRing
import androidx.compose.ui.zIndex
import androidx.compose.material.icons.outlined.Wallet
import androidx.compose.material.icons.outlined.Work
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.NativeShell
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.TimeUnit

// ── Palette (exact iOS build-66 hexes) ──────────────────────────────────────────────

private val moreSky = Color(0xFF599EF2)       // Color(0.35, 0.62, 0.95)
private val moreAmber = Color(0xFFF09E40)     // Color(0.94, 0.62, 0.25)
private val moreRed = Color(0xFFEF4444)       // error red
private val moreGreen = Color(0xFF059669)     // success green

// ── /api/assistant/more-pulse models (defensive — one bad field never blanks it) ────

private class PulseAlert(
    val id: String,
    val kind: String,       // fine | missed_call | chat | agent
    val title: String,
    val detail: String?,
    val amount: Int?,       // whole taka
) {
    val icon: ImageVector
        get() = when (kind) {
            "fine" -> Icons.Outlined.Paid
            "missed_call" -> Icons.Outlined.PhoneMissed
            "agent" -> Icons.Outlined.AutoAwesome
            else -> Icons.Outlined.Forum
        }
    val tint: Color
        get() = when (kind) {
            "fine" -> AlmaTheme.coral
            "missed_call" -> moreAmber
            "agent" -> AlmaTheme.violet
            else -> moreSky
        }
}

private class PulseProgress(
    val weeklyPct: Int?,
    val monthlyPct: Int?,
    val weeklyLabel: String?,
    val monthlyLabel: String?,
)

// ── Menu data — EXACT copy of the iOS build-66 sections/paths.
//    (PITFALL: computed via functions, never stored top-level icon lists.) ───────────

private class MenuItem(val title: String, val icon: ImageVector, val path: String)
private class MenuGroup(val header: String, val icon: ImageVector, val items: List<MenuItem>)

private fun buildMoreGroups(): List<MenuGroup> = listOf(
    // "Phone Companion" (native:companion) is a NATIVE screen (agent drives this phone's
    // browser on the live-browser bus) — handled by a sentinel path, not a web push.
    MenuGroup(
        "Agent", Icons.Outlined.AutoAwesome,
        listOf(
            MenuItem("Phone Companion", Icons.Outlined.PhonelinkRing, "native:companion"),
            MenuItem("Live Watch", Icons.Outlined.Visibility, "/agent/live-watch"),
            MenuItem("Credit Usage", Icons.Outlined.QueryStats, "/agent/credit-usage"),
            MenuItem("Subscriptions", Icons.Outlined.Repeat, "/agent/subscriptions"),
        ),
    ),
    MenuGroup(
        "Workspace", Icons.Outlined.GridView,
        listOf(
            MenuItem("My Desk", Icons.Outlined.Work, "/portal"),
            MenuItem("Office", Icons.Outlined.Groups, "/portal/office"),
            MenuItem("Product Images", Icons.Outlined.PhotoLibrary, "/agent/catalog-images"),
            MenuItem("Creative Studio", Icons.Outlined.AutoAwesome, "/agent/creative-studio"),
        ),
    ),
    MenuGroup(
        "Money", Icons.Outlined.Payments,
        listOf(
            MenuItem("Finance", Icons.Outlined.Wallet, "/finance"),
            MenuItem("Expenses", Icons.Outlined.CreditCard, "/expenses"),
            MenuItem("Payroll", Icons.Outlined.Payments, "/payroll"),
            MenuItem("Invoices", Icons.AutoMirrored.Outlined.ReceiptLong, "/invoice"),
        ),
    ),
    MenuGroup(
        "Operations", Icons.Outlined.Tune,
        listOf(
            MenuItem("Inventory", Icons.Outlined.Inventory2, "/inventory"),
            MenuItem("Activity", Icons.Outlined.Bolt, "/activity"),
            MenuItem("Task Spotlight", Icons.Outlined.TrackChanges, "/operations/task-spotlight"),
            MenuItem("Archive", Icons.Outlined.Archive, "/operations/business-archive"),
        ),
    ),
    MenuGroup(
        "People", Icons.Outlined.Group,
        listOf(
            MenuItem("Employees", Icons.Outlined.Group, "/employees"),
            MenuItem("Attendance", Icons.Outlined.CalendarMonth, "/attendance"),
            MenuItem("CRM", Icons.Outlined.HowToReg, "/crm"),
        ),
    ),
    MenuGroup(
        "Insights", Icons.Outlined.BarChart,
        listOf(
            MenuItem("Analytics", Icons.Outlined.Analytics, "/analytics"),
            MenuItem("Insights", Icons.Outlined.Lightbulb, "/insights"),
            MenuItem("Briefing", Icons.Outlined.Newspaper, "/briefing"),
            MenuItem("Audit", Icons.Outlined.Rule, "/audit"),
        ),
    ),
    MenuGroup(
        "Settings", Icons.Outlined.Tune,
        listOf(
            MenuItem("Users", Icons.Outlined.PersonSearch, "/settings/users"),
            MenuItem("Notifications", Icons.Outlined.NotificationsActive, "/settings/notifications"),
            MenuItem("Branding", Icons.Outlined.Brush, "/settings/branding"),
            MenuItem("SMS", Icons.Outlined.Sms, "/settings/sms"),
            MenuItem("Telegram Ops", Icons.AutoMirrored.Outlined.Send, "/settings/telegram-ops"),
            MenuItem("Database", Icons.Outlined.Dataset, "/settings/database"),
            MenuItem("Session", Icons.Outlined.Key, "/settings/session"),
        ),
    ),
)

/** The owner's 3 businesses — switching is just navigation (the ERP derives the
 *  active business from the route). bizId matches the ERP's businessAccess ids. */
private class Biz(
    val bizId: String, val name: String, val tagline: String,
    val letter: String, val color: Color, val path: String,
)

private fun buildBusinesses(): List<Biz> = listOf(
    Biz("ALMA_LIFESTYLE", "Alma Lifestyle", "Lifestyle", "A", Color(0xFFC9A84C), "/"),
    Biz("ALMA_TRADING", "Alma Trading", "P2P Operations", "T", Color(0xFF82B299), "/trading"),
    Biz("CREATIVE_DIGITAL_IT", "Creative Digital IT", "Digital Agency", "C", Color(0xFF6B8FE0), "/digital"),
)

// ── Accent (web colour variant) bridge — same 5 presets as src/lib/theme.ts.
//    Choice persists in SharedPreferences + the web's `alma-accent` cookie (1 year);
//    web pages restyle on their next load — one-way native→web, like dark mode. ──────

private enum class AlmaAccent(val label: String, val color: Color) {
    CORAL("Coral", Color(0xFFE07A5F)),
    BLUE("Blue", Color(0xFF3B82F6)),
    GREEN("Green", Color(0xFF22A77A)),
    VIOLET("Violet", Color(0xFF8B5CF6)),
    AMBER("Amber", Color(0xFFD99831));

    val raw: String get() = name.lowercase()

    companion object {
        private const val PREFS = "alma-native-shell"
        private const val KEY = "alma-accent"

        fun current(context: Context): AlmaAccent {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "") ?: ""
            return entries.firstOrNull { it.raw == raw } ?: CORAL
        }

        fun set(context: Context, accent: AlmaAccent) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY, accent.raw).apply()
            val cm = CookieManager.getInstance()
            cm.setCookie(AlmaTheme.BASE_URL, "alma-accent=${accent.raw}; path=/; max-age=31536000; SameSite=Lax")
            cm.flush()
        }
    }
}

// ── Cookie jar bridging OkHttp ↔ the app-global WebView CookieManager (the sign-out
//    flow needs the csrf Set-Cookie persisted; AlmaApi drops response cookies). ──────

private object MoreCookieJar : CookieJar {
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val cm = CookieManager.getInstance()
        cookies.forEach { cm.setCookie(url.toString(), it.toString()) }
        cm.flush()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val header = CookieManager.getInstance().getCookie(url.toString()) ?: return emptyList()
        return header.split("; ", ";").mapNotNull { Cookie.parse(url, it.trim()) }
    }
}

// ── State holder (iOS MoreVM twin) ──────────────────────────────────────────────────

private class MoreState {
    var userName by mutableStateOf("")
    var isOwner by mutableStateOf(false)
    var email by mutableStateOf<String?>(null)
    var phone by mutableStateOf<String?>(null)
    var profileImageUrl by mutableStateOf<String?>(null)
    var allowedBusinessIds by mutableStateOf(listOf<String>())
    var alerts by mutableStateOf(listOf<PulseAlert>())
    var progress by mutableStateOf<PulseProgress?>(null)
    var loadedOnce by mutableStateOf(false)

    var uploadingPhoto by mutableStateOf(false)
    var photoError by mutableStateOf<String?>(null)
    var signingOut by mutableStateOf(false)

    private var lastLoad = 0L

    /** Refetch on appear at most every 3 minutes. */
    suspend fun loadIfStale() {
        if (lastLoad != 0L && System.currentTimeMillis() - lastLoad < 180_000L) return
        load()
    }

    suspend fun load() {
        try {
            val root = AlmaApi.getObject("/api/assistant/more-pulse")
            val o = root.optJSONObject("data") ?: root
            o.optJSONObject("user")?.let { u ->
                userName = u.str("name") ?: ""
                isOwner = u.flexBool("isOwner") ?: false
                email = u.str("email")
                phone = u.str("phone")
                profileImageUrl = u.str("profileImageUrl")
                allowedBusinessIds = u.optJSONArray("businessAccess")?.let { arr ->
                    (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotEmpty() } }
                } ?: emptyList()
            }
            alerts = o.optJSONArray("alerts")?.mapObjects { a ->
                PulseAlert(
                    id = a.str("id") ?: UUID.randomUUID().toString(),
                    kind = a.str("kind") ?: "chat",
                    title = a.str("title") ?: "",
                    detail = a.str("detail"),
                    amount = a.flexInt("amount"),
                )
            } ?: emptyList()
            progress = o.optJSONObject("progress")?.let { p ->
                PulseProgress(
                    weeklyPct = p.flexInt("weeklyPct")?.coerceIn(0, 100),
                    monthlyPct = p.flexInt("monthlyPct")?.coerceIn(0, 100),
                    weeklyLabel = p.str("weeklyLabel"),
                    monthlyLabel = p.str("monthlyLabel"),
                )
            }
        } catch (e: Exception) {
            // Quiet degrade (same as iOS): still try to get the name so the large
            // title personalises even without the pulse route.
            if (userName.isEmpty()) {
                try {
                    val me = AlmaApi.getObject("/api/users/me")
                    me.optJSONObject("user")?.let { u ->
                        userName = u.str("name") ?: ""
                        isOwner = u.flexBool("isSystemOwner") ?: false
                        email = u.str("email")
                        phone = u.str("phone")
                        profileImageUrl = u.str("profileImageUrl")
                        allowedBusinessIds = (u.str("businessAccess") ?: "")
                            .split(",").map { it.trim() }.filter { it.isNotEmpty() }
                    }
                } catch (_: Exception) { /* stay quiet */ }
            }
        } finally {
            loadedOnce = true
            lastLoad = System.currentTimeMillis()
        }
    }

    /** Square-crop + ≤640px + JPEG data URL → POST /api/users/me/profile-image. */
    suspend fun uploadPhoto(context: Context, uri: Uri) {
        photoError = null
        uploadingPhoto = true
        try {
            val bitmap = decodeBitmap(context, uri)
            if (bitmap == null) {
                photoError = "ছবিটা পড়া যায়নি — অন্য একটা ছবি চেষ্টা করুন"
                return
            }
            val dataUrl = withContext(Dispatchers.IO) {
                val side = minOf(bitmap.width, bitmap.height)
                val x = (bitmap.width - side) / 2
                val y = (bitmap.height - side) / 2
                var square = Bitmap.createBitmap(bitmap, x, y, side, side)
                if (side > 640) square = Bitmap.createScaledBitmap(square, 640, 640, true)
                val out = ByteArrayOutputStream()
                square.compress(Bitmap.CompressFormat.JPEG, 85, out)
                "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            }
            val resp = AlmaApi.send("POST", "/api/users/me/profile-image", JSONObject().put("image_data_url", dataUrl))
            val data = resp.optJSONObject("data") ?: resp
            if (data.flexBool("ok") == true) {
                // ?v=timestamp in the returned URL busts the image cache.
                profileImageUrl = data.str("profileImageUrl")
            } else {
                photoError = "আপলোড হয়নি — আবার চেষ্টা করুন"
            }
        } catch (e: Exception) {
            photoError = "আপলোড হয়নি — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
        } finally {
            uploadingPhoto = false
        }
    }

    private suspend fun decodeBitmap(context: Context, uri: Uri): Bitmap? = withContext(Dispatchers.IO) {
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { d, _, _ ->
                    d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                }
            } else {
                context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
            }
        } catch (_: Exception) {
            null
        }
    }

    /** null = success, else the error string to show (iOS MoreChangePasswordSheet). */
    suspend fun changePassword(current: String, newPassword: String): String? {
        return try {
            val resp = AlmaApi.send(
                "POST", "/api/users/me/password",
                JSONObject().put("currentPassword", current).put("newPassword", newPassword),
            )
            val data = resp.optJSONObject("data") ?: resp
            if (data.flexBool("ok") == true) null else "পরিবর্তন হয়নি — আবার চেষ্টা করুন"
        } catch (e: AlmaApiException.Http) {
            if (e.status == 400 && e.message?.contains("incorrect") == true) "বর্তমান password ভুল"
            else "পরিবর্তন হয়নি — আবার চেষ্টা করুন"
        } catch (e: Exception) {
            "পরিবর্তন হয়নি — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
        }
    }

    /** null = saved, else error text (iOS MoreEditContactSheet, PATCH /api/users/me). */
    suspend fun saveContact(name: String, phone: String): String? {
        return try {
            AlmaApi.send("PATCH", "/api/users/me", JSONObject().put("name", name).put("phone", phone))
            userName = name
            this.phone = phone.ifEmpty { null }
            null
        } catch (e: Exception) {
            "সেভ হয়নি — আবার চেষ্টা করুন"
        }
    }

    /** NextAuth sign-out: csrf → form-POST /api/auth/signout → purge session cookies
     *  from the app-global jar (URLSession/WK dance not needed — one jar on Android). */
    suspend fun signOut(context: Context) {
        signingOut = true
        try {
            // Unbind this physical installation while the current account cookie
            // still exists, so a shared phone cannot ring for the signed-out user.
            runCatching {
                AlmaApi.send(
                    "DELETE",
                    "/api/assistant/internal/call-push/register",
                    JSONObject().put("installationId", OfficeCallPushRegistration.installationId(context)),
                )
            }
            withContext(Dispatchers.IO) {
                try {
                    val client = OkHttpClient.Builder()
                        .cookieJar(MoreCookieJar)
                        .connectTimeout(20, TimeUnit.SECONDS)
                        .readTimeout(20, TimeUnit.SECONDS)
                        .build()
                    val csrfReq = Request.Builder()
                        .url(AlmaTheme.BASE_URL + "/api/auth/csrf")
                        .header("Accept", "application/json")
                        .build()
                    val token = client.newCall(csrfReq).execute().use { r ->
                        JSONObject(r.body?.string() ?: "{}").str("csrfToken")
                    }
                    if (!token.isNullOrEmpty()) {
                        val form = FormBody.Builder()
                            .add("csrfToken", token)
                            .add("json", "true")
                            .build()
                        val req = Request.Builder()
                            .url(AlmaTheme.BASE_URL + "/api/auth/signout")
                            .header("Accept", "application/json")
                            .post(form)
                            .build()
                        client.newCall(req).execute().close()
                    }
                } catch (_: Exception) {
                    // Even if the POST failed, fall through to the local purge — a dead
                    // session cookie must not keep the user "in".
                }
                val cm = CookieManager.getInstance()
                listOf("next-auth.session-token", "__Secure-next-auth.session-token").forEach { name ->
                    cm.setCookie(AlmaTheme.BASE_URL, "$name=; path=/; max-age=0")
                    cm.setCookie(AlmaTheme.BASE_URL, "$name=; path=/; max-age=0; Secure")
                }
                cm.flush()
            }
            // Flip identity to signed-out so the startup login gate reappears immediately
            // (main thread — state write). Without this the app kept acting "logged in".
            com.almatraders.erp.shell.AlmaSession.signedOut()
        } finally {
            signingOut = false
        }
    }
}

/** Absolute URL for API-relative paths like /api/users/{id}/profile-image. */
private fun moreAbsoluteUrl(s: String?): String? {
    if (s.isNullOrEmpty()) return null
    return if (s.startsWith("http")) s
    else AlmaTheme.BASE_URL + (if (s.startsWith("/")) s else "/$s")
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoreMenuScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val st = remember { MoreState() }
    val scope = rememberCoroutineScope()
    val businesses = remember { buildBusinesses() }

    // Role-gated menu (security audit 2026-07-12): a non-privileged user must not even
    // SEE a section they can't use. Drop items the role can't reach (web nav gate
    // mirror, via AlmaSession.canSee), then drop any group left empty. Fail-closed —
    // an unknown/not-yet-loaded role reads as STAFF, so nothing privileged flashes.
    val role = com.almatraders.erp.shell.AlmaSession.effectiveRole
    val groups = remember(role) {
        buildMoreGroups().mapNotNull { g ->
            val items = g.items.filter { com.almatraders.erp.shell.AlmaSession.canSee(it.path) }
            if (items.isEmpty()) null else MenuGroup(g.header, g.icon, items)
        }
    }

    var openGroup by remember { mutableStateOf<MenuGroup?>(null) }
    var showBusinessSheet by remember { mutableStateOf(false) }
    var showProfileSheet by remember { mutableStateOf(false) }
    var showCompanion by remember { mutableStateOf(false) }

    // native: sentinel paths open a NATIVE screen in-place; everything else is a web push.
    fun openItem(path: String, title: String) {
        if (path == "native:companion") showCompanion = true else ctx.openSmart(path, title)
    }

    LaunchedEffect(Unit) { st.loadIfStale() }
    // Hardware back closes the pushed group page first (shell stack is empty here).
    BackHandler(enabled = openGroup != null) { openGroup = null }

    // Businesses the sheet offers: FAIL-CLOSED by access list (security audit 2026-07-12).
    // The Trading/Digital business homes reach money-writes whose only web gate is route
    // middleware that native navigation bypasses — so the switcher must never over-offer.
    // Owner (isSystemOwner) sees all; everyone else sees exactly their businessAccess list,
    // and an unknown/empty list falls back to Lifestyle ONLY (the base business), never all 3.
    val allowedBusinesses = remember(st.allowedBusinessIds, st.isOwner, businesses) {
        when {
            st.isOwner -> businesses
            st.allowedBusinessIds.isNotEmpty() ->
                businesses.filter { it.bizId in st.allowedBusinessIds }.ifEmpty { businesses.take(1) }
            else -> businesses.take(1)   // fail-closed: Lifestyle only
        }
    }

    // Settings-style push: root list ⇄ group page (iOS pushNative twin — PushCtx
    // cannot push arbitrary native views, so the "push" lives inside this screen).
    AnimatedContent(
        targetState = openGroup,
        transitionSpec = {
            if (targetState != null) {
                (slideInHorizontally { it } + fadeIn()) togetherWith
                    (slideOutHorizontally { -it / 3 } + fadeOut())
            } else {
                (slideInHorizontally { -it / 3 } + fadeIn()) togetherWith
                    (slideOutHorizontally { it } + fadeOut())
            }
        },
        label = "moreNav",
    ) { group ->
        if (group == null) {
            MoreRootList(
                st = st, dark = dark, groups = groups,
                onBusiness = { showBusinessSheet = true },
                onProfile = { showProfileSheet = true },
                onGroup = { openGroup = it },
                openPath = { path, title -> openItem(path, title) },
            )
        } else {
            MoreGroupPage(
                group = group, dark = dark,
                onBack = { openGroup = null },
                open = { item -> openItem(item.path, item.title) },
            )
        }
    }

    // Phone Companion — full-screen native overlay (agent drives this phone's browser).
    if (showCompanion) {
        BackHandler { showCompanion = false }
        Box(Modifier.fillMaxSize().zIndex(50f)) {
            AlmaCompanionScreen(dark = dark, onClose = { showCompanion = false })
        }
    }

    // ── Business switcher sheet (the glossy pill) ──
    if (showBusinessSheet) {
        ModalBottomSheet(
            onDismissRequest = { showBusinessSheet = false },
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            MoreBusinessSheet(
                businesses = allowedBusinesses, dark = dark,
                select = { biz ->
                    showBusinessSheet = false
                    ctx.openSmart(biz.path, biz.name)
                },
            )
        }
    }

    // ── Profile sheet (the round avatar) ──
    if (showProfileSheet) {
        ModalBottomSheet(
            onDismissRequest = { showProfileSheet = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            MoreProfileSheet(
                st = st, dark = dark,
                onSignedOut = {
                    showProfileSheet = false
                    ctx.openSmart("/login", "Login")
                },
            )
        }
    }
}

// ── Root list: header pill/avatar + hero carousel + group rows ──────────────────────

@Composable
private fun MoreRootList(
    st: MoreState,
    dark: Boolean,
    groups: List<MenuGroup>,
    onBusiness: () -> Unit,
    onProfile: () -> Unit,
    onGroup: (MenuGroup) -> Unit,
    openPath: (String, String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = com.almatraders.erp.shell.LocalHeaderInset.current, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        // ── Watch-app header: Business pill (left) + avatar (right) + large name ──
        Column(Modifier.padding(horizontal = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier
                        .almaGlass(dark, 20)
                        .plainClick(onBusiness)
                        .padding(horizontal = 13.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Outlined.Business, contentDescription = null,
                        tint = AlmaTheme.violet, modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "Business", color = AlmaTheme.ink(dark),
                        fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
                Spacer(Modifier.weight(1f))
                MoreAvatar(st = st, dark = dark, size = 38, fontSize = 16, onClick = onProfile)
            }
            Text(
                st.userName.ifEmpty { "More" },
                color = AlmaTheme.ink(dark),
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 10.dp),
            )
        }

        // ── "TODAY" hero carousel (My Faces slot) ──
        MoreHeroRow(st = st, dark = dark, openPath = openPath)

        // ── Nav group rows (each pushes its own Settings-style page) ──
        Column(
            Modifier.padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            groups.forEach { group ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .almaGlass(dark, AlmaTheme.R_CARD)
                        .plainClick { onGroup(group) }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    MoreIconSquare(group.icon, AlmaTheme.violet, dark)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        group.header, color = AlmaTheme.ink(dark),
                        fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        "${group.items.size}",
                        color = AlmaTheme.inkSecondary(dark),
                        fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                            .padding(horizontal = 7.dp, vertical = 3.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Icon(
                        Icons.Outlined.ChevronRight, contentDescription = null,
                        tint = AlmaTheme.inkTertiary(dark), modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

/** Round avatar: cookie-authed image when set, violet→coral initials otherwise. */
@Composable
private fun MoreAvatar(st: MoreState, dark: Boolean, size: Int, fontSize: Int, onClick: (() -> Unit)? = null) {
    val context = LocalContext.current
    val url = moreAbsoluteUrl(st.profileImageUrl)
    Box(
        Modifier
            .size(size.dp)
            .then(if (onClick != null) Modifier.plainClick(onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.linearGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.85f), AlmaTheme.coral.copy(alpha = 0.75f)),
                    ),
                    CircleShape,
                )
                .border(
                    (if (size >= 100) 3 else 1.5f.toInt().coerceAtLeast(1)).dp,
                    Color.White.copy(alpha = if (dark) 0.18f else 0.75f), CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                st.userName.take(1).uppercase().ifEmpty { "—" },
                color = Color.White, fontSize = fontSize.sp, fontWeight = FontWeight.Bold,
            )
        }
        if (url != null) {
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(url)
                    .apply {
                        CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)?.let {
                            setHeader("Cookie", it)
                        }
                    }
                    .crossfade(true)
                    .build(),
                contentDescription = "Profile photo",
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Transparent, CircleShape)
                    .border(1.dp, Color.White.copy(alpha = if (dark) 0.18f else 0.75f), CircleShape)
                    .clip(CircleShape),
            )
        }
    }
}

// ── Group page (Settings-style pushed list — one page per nav group) ────────────────

@Composable
private fun MoreGroupPage(
    group: MenuGroup,
    dark: Boolean,
    onBack: () -> Unit,
    open: (MenuItem) -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = com.almatraders.erp.shell.LocalHeaderInset.current, bottom = 28.dp),
    ) {
        // In-screen back header (the shell header stays "More" — PushCtx cannot
        // retitle it for an internal push).
        Row(
            Modifier
                .padding(bottom = 10.dp)
                .plainClick(onBack),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back",
                tint = AlmaTheme.ink(dark), modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                group.header, color = AlmaTheme.ink(dark),
                fontSize = 22.sp, fontWeight = FontWeight.Bold,
            )
        }
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
            group.items.forEachIndexed { i, item ->
                if (i > 0) MoreRowDivider(dark)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .plainClick { open(item) }
                        .padding(horizontal = 14.dp, vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    MoreIconSquare(item.icon, AlmaTheme.violet, dark)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        item.title, color = AlmaTheme.ink(dark), fontSize = 16.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        Icons.Outlined.ChevronRight, contentDescription = null,
                        tint = AlmaTheme.inkTertiary(dark), modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

// ── Hero cards ("My Faces" slot — clock · alerts · progress) ────────────────────────

@Composable
private fun MoreHeroRow(st: MoreState, dark: Boolean, openPath: (String, String) -> Unit) {
    // Card width sized off the SCREEN so two cards + a visible sliver of the third
    // always fit (owner spec 2026-07-09: the third card must peek, never fully hide).
    val screenW = LocalConfiguration.current.screenWidthDp
    val cardW = maxOf(150f, (screenW - 16 - 12 - 12 - 26) / 2f).dp

    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(
            "TODAY",
            color = if (dark) Color.White.copy(alpha = 0.72f) else Color.Black.copy(alpha = 0.55f),
            fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp,
            modifier = Modifier.padding(start = 30.dp),
        )
        LazyRow(
            contentPadding = PaddingValues(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { ClockHeroCard(dark, cardW) }
            item { AlertsHeroCard(st, dark, cardW) { openPath("/portal/office", "Office") } }
            item {
                ProgressHeroCard(st, dark, cardW) {
                    // /attendance is admin/HR-only; a STAFF/VIEWER tap would land on a
                    // web login page. Route them to their own desk instead.
                    if (com.almatraders.erp.shell.AlmaSession.canSee("/attendance")) {
                        openPath("/attendance", "Attendance")
                    } else {
                        openPath("/portal", "My Desk")
                    }
                }
            }
        }
    }
}

/** Shared premium card scaffold: two-stop gradient, glass top sheen, hairline border. */
@Composable
private fun HeroCardChrome(
    light: Pair<Color, Color>,
    darkStops: Pair<Color, Color>,
    dark: Boolean,
    width: androidx.compose.ui.unit.Dp,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val stops = if (dark) darkStops else light
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .width(width)
            .height(168.dp)
            .background(Brush.linearGradient(listOf(stops.first, stops.second)), shape)
            .background(
                Brush.verticalGradient(
                    0f to Color.White.copy(alpha = if (dark) 0.10f else 0.35f),
                    0.5f to Color.Transparent,
                ),
                shape,
            )
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.08f else 0.55f), shape)
            .then(if (onClick != null) Modifier.plainClick(onClick) else Modifier)
            .padding(14.dp),
        content = content,
    )
}

/** Card 1 — live clock, day name, date, timezone. Fully local; ticks every minute. */
@Composable
private fun ClockHeroCard(dark: Boolean, width: androidx.compose.ui.unit.Dp) {
    var now by remember { mutableStateOf(Date()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = Date()
            delay(60_000L - System.currentTimeMillis() % 60_000L + 50L)
        }
    }
    val timeFmt = remember { SimpleDateFormat("h:mm", Locale.ENGLISH) }
    val ampmFmt = remember { SimpleDateFormat("a", Locale.ENGLISH) }
    val dayFmt = remember { SimpleDateFormat("EEEE", Locale.ENGLISH) }
    val dateFmt = remember { SimpleDateFormat("d MMMM yyyy", Locale.ENGLISH) }
    val hour = remember(now) {
        java.util.Calendar.getInstance().apply { time = now }.get(java.util.Calendar.HOUR_OF_DAY)
    }
    // "Asia/Dhaka · GMT+6" from the device's live timezone (owner spec: show it).
    val tzLine = remember(now) {
        val tz = TimeZone.getDefault()
        val offMin = tz.getOffset(System.currentTimeMillis()) / 60_000
        val h = offMin / 60
        val m = kotlin.math.abs(offMin) % 60
        val off = if (m == 0) "GMT${if (h >= 0) "+" else ""}$h" else String.format(Locale.ENGLISH, "GMT%+d:%02d", h, m)
        "${tz.id} · $off"
    }

    HeroCardChrome(
        light = Color(0xFFFFE8C2) to Color(0xFFFFF7E6),
        darkStops = Color(0xFF2E2142) to Color(0xFF171521),
        dark = dark, width = width,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                dayFmt.format(now), color = AlmaTheme.inkSecondary(dark),
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Icon(
                if (hour in 6..17) Icons.Outlined.LightMode else Icons.Outlined.DarkMode,
                contentDescription = null,
                tint = if (hour in 6..17) Color(0xFFF2A626) else AlmaTheme.violet,
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                timeFmt.format(now), color = AlmaTheme.ink(dark),
                fontSize = 40.sp, fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.width(4.dp))
            Text(
                ampmFmt.format(now), color = AlmaTheme.inkSecondary(dark),
                fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        Text(
            dateFmt.format(now), color = AlmaTheme.ink(dark).copy(alpha = 0.8f),
            fontSize = 13.sp, fontWeight = FontWeight.Medium,
        )
        Text(
            tzLine, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            modifier = Modifier.padding(top = 1.dp),
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Card 2 — dynamic alerts. Rotates through items every 4s when there are >2. */
@Composable
private fun AlertsHeroCard(st: MoreState, dark: Boolean, width: androidx.compose.ui.unit.Dp, onTap: () -> Unit) {
    var idx by remember { mutableStateOf(0) }
    LaunchedEffect(st.alerts.size) {
        idx = 0
        if (st.alerts.size > 2) {
            while (true) {
                delay(4_000L)
                idx = (idx + 1) % st.alerts.size
            }
        }
    }

    HeroCardChrome(
        light = Color(0xFFD9EDFF) to Color(0xFFF2FAFF),
        darkStops = Color(0xFF1B2645) to Color(0xFF14182A),
        dark = dark, width = width, onClick = onTap,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Outlined.NotificationsActive, contentDescription = null,
                tint = moreSky, modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                "Alerts", color = AlmaTheme.inkSecondary(dark),
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            if (st.alerts.isNotEmpty()) {
                Text(
                    "${st.alerts.size}", color = Color.White,
                    fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(AlmaTheme.coral, CircleShape)
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                )
            }
        }
        if (st.alerts.isEmpty()) {
            Spacer(Modifier.weight(1f))
            Icon(
                if (st.loadedOnce) Icons.Outlined.CheckCircle else Icons.Outlined.MoreHoriz,
                contentDescription = null,
                tint = if (st.loadedOnce) AlmaTheme.sage else AlmaTheme.inkSecondary(dark),
                modifier = Modifier.size(24.dp),
            )
            Spacer(Modifier.height(6.dp))
            Text(
                if (st.loadedOnce) "সব ঠিক আছে" else "লোড হচ্ছে…",
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.weight(1f))
        } else {
            Spacer(Modifier.height(8.dp))
            AnimatedContent(
                targetState = if (st.alerts.size <= 2) 0 else idx,
                transitionSpec = { (slideInVertically { it / 2 } + fadeIn()) togetherWith fadeOut() },
                label = "alertRotate",
            ) { shownIdx ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val n = st.alerts.size
                    if (n > 0) {
                        HeroAlertRow(st.alerts[shownIdx % n], dark)
                        if (n > 1) HeroAlertRow(st.alerts[(shownIdx + 1) % n], dark)
                    }
                }
            }
        }
    }
}

@Composable
private fun HeroAlertRow(alert: PulseAlert, dark: Boolean) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            Modifier
                .size(22.dp)
                .background(alert.tint.copy(alpha = if (dark) 0.22f else 0.15f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(alert.icon, contentDescription = null, tint = alert.tint, modifier = Modifier.size(13.dp))
        }
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(
                alert.title, color = AlmaTheme.ink(dark),
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            if (!alert.detail.isNullOrEmpty()) {
                Text(
                    alert.detail, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (alert.amount != null && alert.amount != 0) {
            Spacer(Modifier.width(4.dp))
            Text(
                AlmaTheme.taka(alert.amount), color = AlmaTheme.coral,
                fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }
    }
}

/** Card 3 — weekly + monthly progress; bars sweep in with a spring on appear. */
@Composable
private fun ProgressHeroCard(st: MoreState, dark: Boolean, width: androidx.compose.ui.unit.Dp, onTap: () -> Unit) {
    var appeared by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(200L)
        appeared = true
    }
    val sweep by animateFloatAsState(
        targetValue = if (appeared) 1f else 0f,
        animationSpec = spring(dampingRatio = 0.85f, stiffness = Spring.StiffnessLow),
        label = "progressSweep",
    )

    HeroCardChrome(
        light = Color(0xFFDEF5E8) to Color(0xFFF2FCF5),
        darkStops = Color(0xFF122E22) to Color(0xFF101D17),
        dark = dark, width = width, onClick = onTap,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Outlined.TrendingUp, contentDescription = null,
                tint = AlmaTheme.sage, modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                "Progress", color = AlmaTheme.inkSecondary(dark),
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        Spacer(Modifier.weight(1f))
        val p = st.progress
        if (p != null && (p.weeklyPct != null || p.monthlyPct != null)) {
            HeroProgressRow("Weekly", p.weeklyPct, p.weeklyLabel, dark, sweep)
            Spacer(Modifier.height(8.dp))
            HeroProgressRow("Monthly", p.monthlyPct, p.monthlyLabel, dark, sweep)
        } else {
            Icon(
                if (st.loadedOnce) Icons.Outlined.BarChart else Icons.Outlined.MoreHoriz,
                contentDescription = null,
                tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(24.dp),
            )
            Spacer(Modifier.height(6.dp))
            Text(
                if (st.loadedOnce) "এখনো ডেটা নেই" else "লোড হচ্ছে…",
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.weight(1f))
        }
    }
}

private fun heroBarColor(pct: Int): Color = when {
    pct >= 75 -> AlmaTheme.sage
    pct >= 45 -> moreAmber
    else -> AlmaTheme.coral
}

@Composable
private fun HeroProgressRow(name: String, pct: Int?, label: String?, dark: Boolean, sweep: Float) {
    Column {
        Row {
            Text(
                name, color = AlmaTheme.ink(dark),
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Text(
                pct?.let { "$it%" } ?: "—",
                color = pct?.let { heroBarColor(it) } ?: AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.height(3.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(7.dp)
                .background(AlmaTheme.ink(dark).copy(alpha = if (dark) 0.14f else 0.08f), CircleShape),
        ) {
            if (pct != null && pct > 0) {
                Box(
                    Modifier
                        .fillMaxWidth(fraction = (pct / 100f * sweep).coerceIn(0f, 1f))
                        .fillMaxHeight()
                        .background(
                            Brush.horizontalGradient(
                                listOf(heroBarColor(pct).copy(alpha = 0.75f), heroBarColor(pct)),
                            ),
                            CircleShape,
                        ),
                )
            }
        }
        if (!label.isNullOrEmpty()) {
            Text(
                label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

// ── Business switcher sheet ─────────────────────────────────────────────────────────

@Composable
private fun MoreBusinessSheet(businesses: List<Biz>, dark: Boolean, select: (Biz) -> Unit) {
    Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 30.dp)) {
        Text(
            "Switch Business", color = AlmaTheme.ink(dark),
            fontSize = 20.sp, fontWeight = FontWeight.Bold,
        )
        Text(
            "যে বিজনেসে যেতে চান সেটি বেছে নিন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
            modifier = Modifier.padding(top = 3.dp, bottom = 14.dp),
        )
        Column(
            Modifier
                .fillMaxWidth()
                .background(AlmaTheme.cardBg(dark), RoundedCornerShape(AlmaTheme.R_CARD.dp)),
        ) {
            businesses.forEachIndexed { i, biz ->
                if (i > 0) {
                    HorizontalDivider(
                        modifier = Modifier.padding(start = 62.dp),
                        thickness = 0.7.dp,
                        color = AlmaTheme.separator(dark),
                    )
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .plainClick { select(biz) }
                        .padding(horizontal = 14.dp, vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        Modifier.size(36.dp).background(biz.color, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(biz.letter, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(biz.name, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Medium)
                        Text(biz.tagline, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                    }
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null,
                        tint = biz.color.copy(alpha = 0.8f), modifier = Modifier.size(22.dp),
                    )
                }
            }
        }
    }
}

// ── Profile sheet (avatar upload · appearance · security · account · sign out) ──────

@Composable
private fun MoreProfileSheet(st: MoreState, dark: Boolean, onSignedOut: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var accent by remember { mutableStateOf(AlmaAccent.current(context)) }
    var showPasswordSheet by remember { mutableStateOf(false) }
    var showContactSheet by remember { mutableStateOf(false) }
    var confirmSignOut by remember { mutableStateOf(false) }

    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri != null) scope.launch { st.uploadPhoto(context, uri) }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 10.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        // ── Header: big avatar + camera badge + identity ──
        Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box {
                MoreAvatar(st = st, dark = dark, size = 120, fontSize = 44)
                if (st.uploadingPhoto) {
                    Box(
                        Modifier.size(120.dp).background(Color.Black.copy(alpha = 0.35f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(color = Color.White, modifier = Modifier.size(26.dp))
                    }
                }
                // Camera badge = the photo picker (upload / change).
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .size(34.dp)
                        .background(AlmaTheme.violet, CircleShape)
                        .border(2.dp, Color.White.copy(alpha = 0.9f), CircleShape)
                        .plainClick {
                            if (!st.uploadingPhoto) {
                                photoPicker.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                                )
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Outlined.CameraAlt, contentDescription = "Change photo",
                        tint = Color.White, modifier = Modifier.size(16.dp),
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(
                st.userName.ifEmpty { "—" }, color = AlmaTheme.ink(dark),
                fontSize = 20.sp, fontWeight = FontWeight.Bold,
            )
            if (!st.email.isNullOrEmpty()) {
                Text(st.email ?: "", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
            }
            Spacer(Modifier.height(4.dp))
            val roleTint = if (st.isOwner) AlmaTheme.coral else AlmaTheme.violet
            Text(
                if (st.isOwner) "Owner" else "Staff",
                color = roleTint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .background(roleTint.copy(alpha = 0.14f), CircleShape)
                    .padding(horizontal = 10.dp, vertical = 3.dp),
            )
            st.photoError?.let {
                Text(it, color = AlmaTheme.coral, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
            }
        }

        // ── Appearance: dark mode · accent variants · native screens ──
        ProfileSection("Appearance", dark) {
            ProfileSwitchRow(
                icon = if (dark) Icons.Outlined.DarkMode else Icons.Outlined.LightMode,
                tint = if (dark) AlmaTheme.violet else Color(0xFFFF9500),
                title = "Dark Mode", subtitle = null,
                checked = dark, dark = dark, accent = AlmaTheme.violet,
            ) {
                AlmaTheme.setDark(context, it)
                NativeShell.applyThemeToWebViews()
            }
            MoreRowDivider(dark)
            // Accent variants — the web menu's colour presets, now native.
            Column(Modifier.padding(horizontal = 14.dp, vertical = 11.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    MoreIconSquare(Icons.Outlined.Palette, accent.color, dark)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        "Accent Color", color = AlmaTheme.ink(dark), fontSize = 16.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Text(accent.label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                }
                Spacer(Modifier.height(9.dp))
                Row(
                    Modifier.padding(start = 44.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    AlmaAccent.entries.forEach { option ->
                        Box(
                            Modifier
                                .size(30.dp)
                                .background(option.color, CircleShape)
                                .then(
                                    if (option == accent) {
                                        Modifier.border(3.dp, option.color.copy(alpha = 0.45f), CircleShape)
                                    } else Modifier,
                                )
                                .plainClick {
                                    accent = option
                                    AlmaAccent.set(context, option)
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (option == accent) {
                                Icon(
                                    Icons.Outlined.CheckCircle, contentDescription = option.label,
                                    tint = Color.White, modifier = Modifier.size(14.dp),
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "ওয়েব পেজগুলোতে পরের লোড থেকে নতুন রং কার্যকর হবে",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    modifier = Modifier.padding(start = 44.dp),
                )
            }
            MoreRowDivider(dark)
            ProfileSwitchRow(
                icon = Icons.Outlined.Badge,
                tint = AlmaTheme.coral,
                title = "Native স্ক্রিন",
                subtitle = "বন্ধ করলে আগের ওয়েব স্ক্রিন ফিরবে",
                checked = AlmaTheme.nativeScreensOn, dark = dark, accent = AlmaTheme.coral,
            ) { on ->
                AlmaTheme.setNativeScreens(context, on)
                (context as? Activity)?.recreate()
            }
        }

        // ── Security ──
        // iOS has an "অ্যাপ লক (Face ID)" row here — DEFERRED on Android until the
        // androidx.biometric pass (needs a BiometricPrompt gate in the shell).
        ProfileSection("Security", dark) {
            ProfileNavRow(
                icon = Icons.Outlined.Key, tint = AlmaTheme.violet,
                title = "Password পরিবর্তন", subtitle = null, dark = dark,
            ) { showPasswordSheet = true }
        }

        // ── Account: name/phone (editable) · email (admin-managed) ──
        ProfileSection("Account", dark) {
            ProfileNavRow(
                icon = Icons.Outlined.Person, tint = AlmaTheme.violet,
                title = "নাম ও ফোন",
                subtitle = listOf(st.userName, st.phone ?: "").filter { it.isNotEmpty() }.joinToString(" · "),
                dark = dark,
            ) { showContactSheet = true }
            MoreRowDivider(dark)
            // Email is the login identifier — self-service change has no backend
            // (only admins via /api/users/[id]), so it is read-only on purpose.
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MoreIconSquare(Icons.Outlined.Email, AlmaTheme.inkSecondary(dark), dark)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Email", color = AlmaTheme.ink(dark), fontSize = 16.sp)
                    Text(
                        (st.email?.takeIf { it.isNotEmpty() } ?: "সেট করা নেই") + " · পরিবর্তনের জন্য অ্যাডমিন",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
                Icon(
                    Icons.Outlined.Lock, contentDescription = null,
                    tint = AlmaTheme.inkTertiary(dark), modifier = Modifier.size(14.dp),
                )
            }
        }

        // ── Sign out ──
        Row(
            Modifier
                .fillMaxWidth()
                .almaGlass(dark, AlmaTheme.R_CARD)
                .plainClick { if (!st.signingOut) confirmSignOut = true }
                .padding(vertical = 13.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (st.signingOut) {
                CircularProgressIndicator(color = AlmaTheme.coral, modifier = Modifier.size(18.dp))
            } else {
                Icon(
                    Icons.AutoMirrored.Outlined.Logout, contentDescription = null,
                    tint = AlmaTheme.coral, modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text("সাইন আউট", color = AlmaTheme.coral, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        // ── Version footer ──
        val versionLine = remember {
            try {
                val info = context.packageManager.getPackageInfo(context.packageName, 0)
                val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toString()
                else @Suppress("DEPRECATION") info.versionCode.toString()
                "ALMA ERP v${info.versionName ?: "—"} ($code)"
            } catch (_: Exception) {
                "ALMA ERP"
            }
        }
        Text(
            versionLine, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            modifier = Modifier.fillMaxWidth(),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            containerColor = AlmaTheme.cardBg(dark),
            title = { Text("সাইন আউট করবেন?", color = AlmaTheme.ink(dark)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    scope.launch {
                        st.signOut(context)
                        onSignedOut()
                    }
                }) { Text("সাইন আউট", color = AlmaTheme.coral, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = {
                TextButton(onClick = { confirmSignOut = false }) {
                    Text("বাতিল", color = AlmaTheme.inkSecondary(dark))
                }
            },
        )
    }

    if (showPasswordSheet) {
        MoreChangePasswordSheet(st = st, dark = dark, onDone = { showPasswordSheet = false })
    }
    if (showContactSheet) {
        MoreEditContactSheet(st = st, dark = dark, onDone = { showContactSheet = false })
    }
}

// ── Change-password sheet (POST /api/users/me/password) ─────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MoreChangePasswordSheet(st: MoreState, dark: Boolean, onDone: () -> Unit) {
    var current by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val valid = current.isNotEmpty() && newPassword.length >= 8 && newPassword == confirm

    ModalBottomSheet(
        onDismissRequest = onDone,
        containerColor = AlmaTheme.rootBg(dark),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Password পরিবর্তন", color = AlmaTheme.ink(dark),
                fontSize = 19.sp, fontWeight = FontWeight.Bold,
            )
            SheetPasswordField("বর্তমান password", current, dark) { current = it }
            SheetPasswordField("নতুন password (কমপক্ষে ৮ অক্ষর)", newPassword, dark) { newPassword = it }
            SheetPasswordField("নতুন password আবার লিখুন", confirm, dark) { confirm = it }
            if (newPassword.isNotEmpty() && newPassword.length < 8) {
                Text(
                    "নতুন password কমপক্ষে ৮ অক্ষরের হতে হবে",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            }
            if (confirm.isNotEmpty() && confirm != newPassword) {
                Text("দুইবার লেখা password মিলছে না", color = AlmaTheme.coral, fontSize = 12.sp)
            }
            errorText?.let { Text(it, color = AlmaTheme.coral, fontSize = 12.sp) }
            SheetPrimaryButton(
                text = "পরিবর্তন করুন", busy = busy, enabled = valid && !busy,
            ) {
                busy = true
                errorText = null
                scope.launch {
                    val err = st.changePassword(current, newPassword)
                    busy = false
                    if (err == null) onDone() else errorText = err
                }
            }
        }
    }
}

// ── Edit name/phone sheet (PATCH /api/users/me) ─────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MoreEditContactSheet(st: MoreState, dark: Boolean, onDone: () -> Unit) {
    var name by remember { mutableStateOf(st.userName) }
    var phone by remember { mutableStateOf(st.phone ?: "") }
    var busy by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    ModalBottomSheet(
        onDismissRequest = onDone,
        containerColor = AlmaTheme.rootBg(dark),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("নাম ও ফোন", color = AlmaTheme.ink(dark), fontSize = 19.sp, fontWeight = FontWeight.Bold)
            OutlinedTextField(
                value = name, onValueChange = { name = it },
                label = { Text("নাম") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = phone, onValueChange = { phone = it },
                label = { Text("ফোন (01… / +880…)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            errorText?.let { Text(it, color = AlmaTheme.coral, fontSize = 12.sp) }
            SheetPrimaryButton(
                text = "সেভ করুন", busy = busy,
                enabled = name.trim().isNotEmpty() && !busy,
            ) {
                busy = true
                errorText = null
                scope.launch {
                    val err = st.saveContact(name.trim(), phone.trim())
                    busy = false
                    if (err == null) onDone() else errorText = err
                }
            }
        }
    }
}

// ── Shared scaffolding ──────────────────────────────────────────────────────────────

@Composable
private fun ProfileSection(header: String, dark: Boolean, rows: @Composable ColumnScope.() -> Unit) {
    Column {
        Text(
            header.uppercase(),
            color = if (dark) Color.White.copy(alpha = 0.72f) else Color.Black.copy(alpha = 0.55f),
            fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp,
            modifier = Modifier.padding(start = 14.dp, bottom = 7.dp),
        )
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) { rows() }
    }
}

@Composable
private fun MoreIconSquare(icon: ImageVector, tint: Color, dark: Boolean) {
    Box(
        Modifier
            .size(32.dp)
            .background(tint.copy(alpha = if (dark) 0.18f else 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun MoreRowDivider(dark: Boolean) {
    HorizontalDivider(
        modifier = Modifier.padding(start = 58.dp),
        thickness = 0.7.dp,
        color = AlmaTheme.separator(dark),
    )
}

@Composable
private fun ProfileNavRow(
    icon: ImageVector, tint: Color, title: String, subtitle: String?, dark: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .plainClick(onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MoreIconSquare(icon, tint, dark)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 16.sp)
            if (!subtitle.isNullOrEmpty()) {
                Text(
                    subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Icon(
            Icons.Outlined.ChevronRight, contentDescription = null,
            tint = AlmaTheme.inkTertiary(dark), modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun ProfileSwitchRow(
    icon: ImageVector, tint: Color, title: String, subtitle: String?,
    checked: Boolean, dark: Boolean, accent: Color,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MoreIconSquare(icon, tint, dark)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 16.sp)
            if (subtitle != null) {
                Text(subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedTrackColor = accent,
                checkedThumbColor = Color.White,
            ),
        )
    }
}

@Composable
private fun SheetPasswordField(label: String, value: String, dark: Boolean, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun SheetPrimaryButton(text: String, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(
                AlmaTheme.violet.copy(alpha = if (enabled || busy) 1f else 0.4f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .plainClick { if (enabled) onClick() }
            .padding(vertical = 13.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) {
            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(18.dp))
        } else {
            Text(text, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}
