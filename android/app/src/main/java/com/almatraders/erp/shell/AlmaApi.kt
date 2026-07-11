//
//  AlmaApi.kt
//  ALMA ERP — native networking for the Compose screens. Twin of iOS AlmaAPI.swift.
//
//  Android is simpler than iOS here: the WebView cookie store (CookieManager) is
//  app-global and synchronous, so instead of the iOS WKHTTPCookieStore→URLSession
//  copy dance we just read the cookie header per request. Auth semantics match iOS:
//  redirect-following is DISABLED so a Next.js middleware 307 → /login surfaces as
//  the real "not logged in" signal (401/403 from API routes counts too).
//
//  Transport = OkHttp (HttpURLConnection cannot send PATCH — the approvals route needs it).
//
//  JSON: org.json + defensive readers (the ERP's legacy rows mix ints/strings in the
//  same field — one bad row must never kill a whole list; same rule as the iOS
//  flexInt decoder).
//

package com.almatraders.erp.shell

import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

sealed class AlmaApiException(message: String) : Exception(message) {
    /** Session cookies missing/expired — the owner must log in via a web view. */
    class NotAuthenticated : AlmaApiException("সেশন পাওয়া যায়নি — একবার লগইন করুন")
    class Http(val status: Int, body: String) :
        AlmaApiException("Server error $status: ${body.take(200)}")
    class Transport(cause: Throwable) :
        AlmaApiException(cause.message ?: "নেটওয়ার্ক সমস্যা")
}

object AlmaApi {

    /** Set by the shell when a request bounces even though we sent cookies — the UI
     *  shows the login card. (iOS: almaAuthExpired notification.) */
    @Volatile var onAuthExpired: (() -> Unit)? = null

    private val client = OkHttpClient.Builder()
        .followRedirects(false)   // 307 → /login must stay visible (iOS RedirectBlocker)
        .followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    suspend fun get(path: String, query: Map<String, String?> = emptyMap()): String =
        request("GET", path, query, null)

    suspend fun getObject(path: String, query: Map<String, String?> = emptyMap()): JSONObject =
        JSONObject(get(path, query))

    suspend fun getArray(path: String, query: Map<String, String?> = emptyMap()): JSONArray =
        JSONArray(get(path, query))

    suspend fun send(method: String, path: String, body: JSONObject? = null): JSONObject {
        val raw = request(method, path, emptyMap(), body?.toString())
        return if (raw.trimStart().startsWith("[")) JSONObject().put("data", JSONArray(raw))
        else JSONObject(raw.ifBlank { "{}" })
    }

    private suspend fun request(
        method: String,
        path: String,
        query: Map<String, String?>,
        jsonBody: String?,
    ): String = withContext(Dispatchers.IO) {
        val qs = query.entries
            .mapNotNull { (k, v) -> v?.let { "${enc(k)}=${enc(it)}" } }
            .joinToString("&")
        val url = AlmaTheme.BASE_URL + path + if (qs.isEmpty()) "" else "?$qs"

        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("X-Requested-With", "XMLHttpRequest")
        CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)?.let {
            builder.header("Cookie", it)
        }
        builder.method(method, jsonBody?.toRequestBody(JSON_MEDIA))

        try {
            client.newCall(builder.build()).execute().use { resp ->
                val status = resp.code
                val body = resp.body?.string() ?: ""
                val location = resp.header("Location") ?: ""
                val unauthenticated = status == 401 || status == 403 ||
                    (status in 300..399 && location.contains("/login"))
                if (unauthenticated) {
                    onAuthExpired?.invoke()
                    throw AlmaApiException.NotAuthenticated()
                }
                if (status !in 200..299) throw AlmaApiException.Http(status, body)
                body
            }
        } catch (e: AlmaApiException) {
            throw e
        } catch (e: Exception) {
            throw AlmaApiException.Transport(e)
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

// ── Defensive JSON readers (iOS flexInt twins) ───────────────────────────────────

/** Int from int/double/string, else null — legacy rows mix types. */
fun JSONObject.flexInt(key: String): Int? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is Int -> v
        is Long -> v.toInt()
        is Number -> Math.round(v.toDouble()).toInt()
        is String -> v.trim().toDoubleOrNull()?.let { Math.round(it).toInt() }
        else -> null
    }
}

fun JSONObject.flexLong(key: String): Long? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is Int -> v.toLong()
        is Long -> v
        is Number -> Math.round(v.toDouble())
        is String -> v.trim().toDoubleOrNull()?.let { Math.round(it) }
        else -> null
    }
}

fun JSONObject.flexDouble(key: String): Double? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is Number -> v.toDouble()
        is String -> v.trim().toDoubleOrNull()
        else -> null
    }
}

/** String or null — JSONObject.optString would coerce numbers/null to text. */
fun JSONObject.str(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is String -> v
        is Number, is Boolean -> v.toString()
        else -> null
    }
}

fun JSONObject.flexBool(key: String): Boolean? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is Boolean -> v
        is String -> v.equals("true", true) || v == "1"
        is Number -> v.toInt() != 0
        else -> null
    }
}

/** Iterate an array of objects, skipping malformed rows. */
inline fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T?): List<T> {
    val out = ArrayList<T>(length())
    for (i in 0 until length()) {
        val o = optJSONObject(i) ?: continue
        try { transform(o)?.let(out::add) } catch (_: Exception) { /* one bad row never kills the list */ }
    }
    return out
}
