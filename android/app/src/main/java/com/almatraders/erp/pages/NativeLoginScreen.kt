//
//  NativeLoginScreen.kt
//  ALMA ERP — native sign-in (web /login parity), Kotlin/Compose twin of
//  NativeLoginSwiftUI.swift. Speaks the NextAuth credentials flow directly:
//    GET  /api/auth/csrf                   → { csrfToken } (+ csrf cookie)
//    POST /api/auth/callback/credentials   → form-encoded csrfToken/identifier/
//                                            password/redirect=false/json=true
//    GET  /api/auth/session                → { user } = success
//
//  Cookie handling (Android): the iOS WKWebsiteDataStore copy dance is unnecessary
//  because android.webkit.CookieManager is the app-global WebView store AlmaApi
//  already reads. This screen runs its OWN small OkHttp client whose CookieJar
//  reads every Set-Cookie response header and copies it into
//  CookieManager.getInstance().setCookie(BASE, cookie) + flush(), so once the flow
//  finishes every WebView (and AlmaApi) is signed in. The password is never logged
//  or persisted. A "ওয়েবে লগইন" escape always renders (ctx.openWebForced).
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Color
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.plainClick
import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// ── Web login-card golds (bg-gold/15, text-gold-lt — the web page is dark-only) ─────
private val LOGIN_GOLD_LT = Color(0xFFF4A28C)
private val LOGIN_GOLD_DIM = Color(0xFFC45A3C)

// ── NextAuth wire flow (own OkHttp client; CookieJar mirrors Set-Cookie → CookieManager) ──

private sealed class LoginResult {
    data class Success(val name: String?) : LoginResult()
    object BadCredentials : LoginResult()
    object Transport : LoginResult()
}

private object NativeLoginFlow {

    /** CookieJar backed by the app-global WebView store: every Set-Cookie lands in
     *  CookieManager (+flush), and requests replay whatever CookieManager holds. */
    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val cm = CookieManager.getInstance()
            cookies.forEach { cm.setCookie(AlmaTheme.BASE_URL, it.toString()) }
            cm.flush()
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val header = CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL) ?: return emptyList()
            return header.split(";").mapNotNull { pair ->
                val t = pair.trim()
                val eq = t.indexOf('=')
                if (eq <= 0) return@mapNotNull null
                Cookie.Builder()
                    .name(t.substring(0, eq)).value(t.substring(eq + 1))
                    .domain(url.host).build()
            }
        }
    }

    private val client = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private fun url(path: String): HttpUrl = (AlmaTheme.BASE_URL + path).toHttpUrl()

    /** Full credentials round-trip. Returns the signed-in display name (if any). */
    suspend fun signIn(identifier: String, password: String): LoginResult = withContext(Dispatchers.IO) {
        try {
            // 1. CSRF token (sets the next-auth.csrf-token cookie in the shared store).
            val csrfReq = Request.Builder().url(url("/api/auth/csrf"))
                .header("Accept", "application/json").get().build()
            val token = client.newCall(csrfReq).execute().use { resp ->
                if (resp.code != 200) return@withContext LoginResult.Transport
                JSONObject(resp.body?.string() ?: "{}").optString("csrfToken", "")
            }
            if (token.isEmpty()) return@withContext LoginResult.Transport

            // 2. Credentials callback — form-encoded, json=true → 200 with {url}.
            val form = FormBody.Builder()
                .add("csrfToken", token)
                .add("identifier", identifier)
                .add("password", password)
                .add("redirect", "false")
                .add("json", "true")
                .add("callbackUrl", AlmaTheme.BASE_URL)
                .build()
            val cbReq = Request.Builder().url(url("/api/auth/callback/credentials"))
                .header("Accept", "application/json").post(form).build()
            client.newCall(cbReq).execute().use { resp ->
                // NextAuth answers 200 {url:...}; a url with error= means bad login (401 too).
                if (resp.code == 401) return@withContext LoginResult.BadCredentials
                if (resp.code != 200) return@withContext LoginResult.Transport
                val body = resp.body?.string() ?: ""
                if (body.contains("error=")) return@withContext LoginResult.BadCredentials
            }

            // 3. Confirm the session actually exists (the web page polls getSession too).
            repeat(5) { attempt ->
                if (attempt > 0) delay(400)
                val sReq = Request.Builder().url(url("/api/auth/session"))
                    .header("Accept", "application/json").get().build()
                val user = runCatching {
                    client.newCall(sReq).execute().use { resp ->
                        if (resp.code != 200) return@use null
                        JSONObject(resp.body?.string() ?: "{}").optJSONObject("user")
                    }
                }.getOrNull()
                if (user != null) {
                    val name = user.optString("name", "").ifEmpty { user.optString("email", "") }
                    return@withContext LoginResult.Success(name.ifEmpty { null })
                }
            }
            LoginResult.BadCredentials
        } catch (e: Exception) {
            LoginResult.Transport
        }
    }
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@Composable
fun NativeLoginScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val scope = rememberCoroutineScope()

    var identifier by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var welcome by remember { mutableStateOf<String?>(null) }

    val canSubmit = identifier.trim().isNotEmpty() && password.isNotEmpty()

    fun submit() {
        if (!canSubmit || loading) return
        loading = true
        errorText = null
        val id = identifier.trim()
        val pw = password
        scope.launch {
            when (val r = NativeLoginFlow.signIn(id, pw)) {
                is LoginResult.Success -> {
                    welcome = r.name
                    password = ""
                    delay(600)
                    ctx.pop()   // signed in — leave the login screen
                }
                LoginResult.BadCredentials -> errorText = "Invalid phone/email or password"
                LoginResult.Transport -> errorText = "Login failed — নেটওয়ার্ক চেক করে আবার চেষ্টা করুন"
            }
            loading = false
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(70.dp))
        LoginMonogram()
        Text(
            "ALMA ERP", color = LOGIN_GOLD_LT, fontSize = 11.sp, fontWeight = FontWeight.Black,
            letterSpacing = 3.2.sp, modifier = Modifier.padding(top = 18.dp),
        )
        Text(
            "Sign in", color = AlmaTheme.ink(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            "Secure multi-business workspace",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
        )

        LoginCard(
            dark = dark,
            identifier = identifier, onIdentifier = { identifier = it },
            password = password, onPassword = { password = it },
            showPassword = showPassword, onToggle = { showPassword = !showPassword },
            loading = loading, canSubmit = canSubmit,
            errorText = errorText, welcome = welcome,
            onSubmit = { submit() },
        )

        Text(
            "Forgot password?",
            color = LOGIN_GOLD_LT, fontSize = 12.sp,
            modifier = Modifier
                .padding(top = 22.dp)
                .plainClick { ctx.openWebForced("/forgot-password", "Password reset") }
                .padding(4.dp),
        )
        Row(
            Modifier
                .padding(top = 10.dp, bottom = 40.dp)
                .plainClick { ctx.openWebForced("/login", "Login") }
                .padding(4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Icon(Icons.Outlined.Language, contentDescription = null, tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(13.dp))
            Text("ওয়েবে লগইন", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

@Composable
private fun LoginMonogram() {
    val shape = RoundedCornerShape(16.dp)
    Box(
        Modifier
            .size(52.dp)
            .background(LOGIN_GOLD_DIM.copy(alpha = 0.15f), shape)
            .border(1.dp, LOGIN_GOLD_DIM.copy(alpha = 0.5f), shape),
        contentAlignment = Alignment.Center,
    ) {
        Text("A", color = LOGIN_GOLD_LT, fontSize = 20.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun LoginCard(
    dark: Boolean,
    identifier: String, onIdentifier: (String) -> Unit,
    password: String, onPassword: (String) -> Unit,
    showPassword: Boolean, onToggle: () -> Unit,
    loading: Boolean, canSubmit: Boolean,
    errorText: String?, welcome: String?,
    onSubmit: () -> Unit,
) {
    Column(
        Modifier
            .padding(top = 26.dp, start = 22.dp, end = 22.dp)
            .widthIn(max = 380.dp)
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, LOGIN_GOLD_DIM.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CARD.dp))
            .padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        LoginField(dark, "PHONE OR EMAIL", identifier, "+8801XXXXXXXXX or you@company.com", KeyboardType.Email, onIdentifier)
        LoginField(
            dark, "PASSWORD", password, "••••••••", KeyboardType.Password, onPassword,
            secure = !showPassword,
            trailing = {
                Icon(
                    if (showPassword) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                    contentDescription = "toggle password",
                    tint = AlmaTheme.inkSecondary(dark),
                    modifier = Modifier.size(18.dp).plainClick(onToggle),
                )
            },
        )

        errorText?.let {
            Text("⚠ $it", color = Color(0xFFEF4444), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
        welcome?.let {
            Text("✓ স্বাগতম, $it!", color = Color(0xFF059669), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(
                    if (canSubmit && !loading) AlmaTheme.coral else AlmaTheme.coral.copy(alpha = 0.45f),
                    RoundedCornerShape(14.dp),
                )
                .plainClick { if (canSubmit && !loading) onSubmit() }
                .padding(vertical = 14.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (loading) {
                CircularProgressIndicator(Modifier.size(15.dp), color = Color.White, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(
                if (loading) "Signing in…" else "Continue",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun LoginField(
    dark: Boolean,
    label: String,
    value: String,
    placeholder: String,
    keyboardType: KeyboardType,
    onChange: (String) -> Unit,
    secure: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
        Row(
            Modifier
                .fillMaxWidth()
                .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
                textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(AlmaTheme.coral),
                decorationBox = { inner ->
                    Box {
                        if (value.isEmpty()) {
                            Text(placeholder, color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                        }
                        inner()
                    }
                },
                modifier = Modifier.weight(1f),
            )
            trailing?.invoke()
        }
    }
}
