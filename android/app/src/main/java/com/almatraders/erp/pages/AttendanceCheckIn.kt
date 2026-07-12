//
//  AttendanceCheckIn.kt
//  ALMA ERP — NATIVE attendance check-in (front-camera selfie) + check-out (GPS),
//  replacing the former web escape in My Desk. iOS build 66 kept selfie capture on
//  the web; the owner wants it fully native on Android (2026-07-12).
//
//  Flow mirrors the web FaceVerificationCheckIn:
//    • Front camera → JPEG (system camera via TakePicture + FileProvider).
//    • Downscale to ≤1000px JPEG (image_data_url) + a ≤256px thumb (thumb_data_url).
//    • Best-effort GPS fix (LocationManager, no Play Services) → metadata.location.
//    • POST /api/attendance/check-in  { business_id, request_id, metadata,
//        face_verification:{ image_data_url, thumb_data_url } }
//    • Check-out: POST /api/attendance/check-out { business_id, metadata:{location} }
//
//  Camera + fine-location are declared in the manifest; a runtime permission prompt
//  precedes capture / location. The system owner cannot check in (server 403) — we
//  surface that message in Bangla so the owner knows to test with a staff account.
//

package com.almatraders.erp.pages

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Image
import androidx.core.content.FileProvider
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.coroutines.resume

// ── Location ────────────────────────────────────────────────────────────────────────

private class LocationFix(val lat: Double, val lng: Double, val acc: Float?)

private fun hasLocationPermission(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

private fun Location.toFix() = LocationFix(latitude, longitude, if (hasAccuracy()) accuracy else null)

/** Best-effort single fresh GPS/network fix within [timeoutMs]; falls back to the
 *  most recent last-known location. Never throws — a null fix just omits location. */
private suspend fun acquireLocationOnce(context: Context, timeoutMs: Long = 15_000L): LocationFix? {
    if (!hasLocationPermission(context)) return null
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
    val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        .filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }

    val fresh = if (providers.isEmpty()) null else withTimeoutOrNull(timeoutMs) {
        suspendCancellableCoroutine<LocationFix?> { cont ->
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    runCatching { lm.removeUpdates(this) }
                    if (cont.isActive) cont.resume(location.toFix())
                }
                override fun onProviderDisabled(provider: String) {}
                override fun onProviderEnabled(provider: String) {}
                @Deprecated("legacy") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
            }
            try {
                providers.forEach { lm.requestLocationUpdates(it, 0L, 0f, listener, Looper.getMainLooper()) }
            } catch (_: SecurityException) {
                if (cont.isActive) cont.resume(null)
                return@suspendCancellableCoroutine
            }
            cont.invokeOnCancellation { runCatching { lm.removeUpdates(listener) } }
        }
    }
    if (fresh != null) return fresh
    // Fallback: newest last-known across providers.
    return runCatching {
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }
            ?.toFix()
    }.getOrNull()
}

// ── Client metadata (parity with the web attendanceMetadata) ─────────────────────────

private fun buildAttendanceMetadata(context: Context, fix: LocationFix?): JSONObject {
    val prefs = context.getSharedPreferences("alma-native-shell", Context.MODE_PRIVATE)
    val sid = prefs.getString("alma-attendance-session-id", null)
        ?: UUID.randomUUID().toString().also { prefs.edit().putString("alma-attendance-session-id", it).apply() }
    val dm = context.resources.displayMetrics
    val screen = "${dm.widthPixels}x${dm.heightPixels}x32"
    val fingerprint = listOf(
        "${Build.MANUFACTURER} ${Build.MODEL}",
        Locale.getDefault().toLanguageTag(),
        TimeZone.getDefault().id,
        "Android ${Build.VERSION.RELEASE}",
        screen,
    ).joinToString("|")
    return JSONObject().apply {
        put("browserFingerprint", fingerprint)
        put("sessionId", sid)
        put("timezone", TimeZone.getDefault().id)
        put("language", Locale.getDefault().toLanguageTag())
        put("platform", "Android")
        put("screen", screen)
        if (fix != null) {
            put("location", JSONObject().apply {
                put("latitude", fix.lat)
                put("longitude", fix.lng)
                fix.acc?.let { put("accuracy", it.toDouble()) }
            })
        }
    }
}

// ── Image processing ─────────────────────────────────────────────────────────────────

private fun bitmapToDataUrl(bitmap: Bitmap, maxSide: Int, quality: Int): String {
    val side = maxOf(bitmap.width, bitmap.height)
    val scaled = if (side > maxSide) {
        val ratio = maxSide.toFloat() / side
        Bitmap.createScaledBitmap(bitmap, (bitmap.width * ratio).toInt().coerceAtLeast(1), (bitmap.height * ratio).toInt().coerceAtLeast(1), true)
    } else bitmap
    val out = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
    return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

private fun decodeSampled(file: File, reqSide: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    var sample = 1
    val big = maxOf(bounds.outWidth, bounds.outHeight)
    while (big / sample > reqSide * 2) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeFile(file.absolutePath, opts)
}

// ── Custom contract: hint the front (selfie) camera ──────────────────────────────────

private class TakeFrontPicture : ActivityResultContracts.TakePicture() {
    override fun createIntent(context: Context, input: Uri): Intent =
        super.createIntent(context, input).apply {
            // OEM-specific hints; harmless where unsupported (user can still flip).
            putExtra("android.intent.extras.CAMERA_FACING", 1)
            putExtra("android.intent.extras.LENS_FACING_FRONT", 1)
            putExtra("android.intent.extra.USE_FRONT_CAMERA", true)
        }
}

// ── Check-out (GPS only) ─────────────────────────────────────────────────────────────

/** Runs check-out: acquires a GPS fix (best-effort) and POSTs. Returns null on
 *  success, else a Bangla error to show. */
suspend fun runAttendanceCheckOut(context: Context, businessId: String): String? {
    return try {
        val fix = acquireLocationOnce(context)
        val body = JSONObject()
            .put("business_id", businessId)
            .put("metadata", buildAttendanceMetadata(context, fix))
        AlmaApi.send("POST", "/api/attendance/check-out", body)
        null
    } catch (e: AlmaApiException.Http) {
        e.message?.takeIf { it.isNotBlank() } ?: "চেক-আউট হয়নি — আবার চেষ্টা করুন"
    } catch (_: Exception) {
        "চেক-আউট হয়নি — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
    }
}

// ── Check-in sheet ───────────────────────────────────────────────────────────────────

private enum class CheckInPhase { CAPTURE, CONFIRM, SUBMITTING, SUCCESS, ERROR }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttendanceCheckInSheet(
    businessId: String,
    dark: Boolean,
    onDismiss: () -> Unit,
    onSuccess: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var phase by remember { mutableStateOf(CheckInPhase.CAPTURE) }
    var preview by remember { mutableStateOf<Bitmap?>(null) }
    var imageDataUrl by remember { mutableStateOf<String?>(null) }
    var thumbDataUrl by remember { mutableStateOf<String?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var progressText by remember { mutableStateOf("") }

    // A stable capture file in cacheDir (matches file_paths.xml cache-path).
    val photoFile = remember { File(context.cacheDir, "attendance-selfie.jpg") }
    val photoUri = remember {
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", photoFile)
    }

    val cameraLauncher = rememberLauncherForActivityResult(TakeFrontPicture()) { ok ->
        if (!ok) return@rememberLauncherForActivityResult
        scope.launch {
            phase = CheckInPhase.SUBMITTING
            progressText = "ছবি প্রসেস হচ্ছে…"
            val processed = withContext(Dispatchers.IO) {
                val bmp = decodeSampled(photoFile, 1000) ?: return@withContext null
                Triple(bmp, bitmapToDataUrl(bmp, 1000, 85), bitmapToDataUrl(bmp, 256, 70))
            }
            if (processed == null) {
                errorText = "ছবিটা পড়া যায়নি — আবার তুলুন"
                phase = CheckInPhase.ERROR
                return@launch
            }
            preview = processed.first
            imageDataUrl = processed.second
            thumbDataUrl = processed.third
            phase = CheckInPhase.CONFIRM
        }
    }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) cameraLauncher.launch(photoUri)
        else { errorText = "ক্যামেরা পারমিশন দরকার — সেটিংসে অনুমতি দিন"; phase = CheckInPhase.ERROR }
    }

    fun openCamera() {
        errorText = null
        if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            cameraLauncher.launch(photoUri)
        } else {
            permLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    fun submit() {
        val img = imageDataUrl ?: return
        scope.launch {
            phase = CheckInPhase.SUBMITTING
            // Location is best-effort — do NOT block check-in on a slow GPS fix
            // (the server requires only the face; check-out is where geofence bites).
            progressText = "লোকেশন নেওয়া হচ্ছে…"
            val fix = acquireLocationOnce(context, 12_000L)
            progressText = "চেক-ইন হচ্ছে…"
            val result = try {
                val body = JSONObject()
                    .put("business_id", businessId)
                    .put("request_id", UUID.randomUUID().toString())
                    .put("metadata", buildAttendanceMetadata(context, fix))
                    .put(
                        "face_verification",
                        JSONObject().put("image_data_url", img).apply {
                            thumbDataUrl?.let { put("thumb_data_url", it) }
                        },
                    )
                val resp = AlmaApi.send("POST", "/api/attendance/check-in", body)
                val data = resp.optJSONObject("data") ?: resp
                val record = data.optJSONObject("record")
                if (record?.str("id") != null || data.flexBool("ok") == true || data.flexBool("duplicate") == true) null
                else "চেক-ইন সেভ হয়েছে কিনা নিশ্চিত নয় — My Desk রিফ্রেশ করুন"
            } catch (e: AlmaApiException.Http) {
                mapCheckInError(e.message, e.status)
            } catch (_: Exception) {
                "চেক-ইন হয়নি — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
            }
            if (result == null) {
                phase = CheckInPhase.SUCCESS
                onSuccess()
            } else {
                errorText = result
                phase = CheckInPhase.ERROR
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AlmaTheme.rootBg(dark),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                when (phase) {
                    CheckInPhase.SUCCESS -> "🟢 উপস্থিতি নিশ্চিত হয়েছে"
                    CheckInPhase.ERROR -> "⚠️ চেক-ইন হয়নি"
                    else -> "📸 কাজ শুরুর ভেরিফিকেশন"
                },
                color = AlmaTheme.ink(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )

            when (phase) {
                CheckInPhase.CAPTURE -> {
                    Box(
                        Modifier.fillMaxWidth().height(180.dp)
                            .background(AlmaTheme.cardBg(dark), RoundedCornerShape(AlmaTheme.R_CARD.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "সামনের ক্যামেরায় সেলফি তুলুন",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                    CheckInButton("সামনের ক্যামেরা খুলুন", AlmaTheme.sage, dark) { openCamera() }
                }
                CheckInPhase.CONFIRM -> {
                    preview?.let {
                        Image(
                            it.asImageBitmap(), contentDescription = "Selfie",
                            modifier = Modifier.fillMaxWidth().aspectRatio(1f)
                                .clip(RoundedCornerShape(AlmaTheme.R_CARD.dp)),
                            contentScale = ContentScale.Crop,
                        )
                    }
                    Text("ছবি ঠিক থাকলে নিচে কনফার্ম করুন", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                    CheckInButton("✅ চেক-ইন কনফার্ম করুন", AlmaTheme.sage, dark) { submit() }
                    CheckInButton("আবার তুলুন", AlmaTheme.cardBg(dark), dark, textColor = AlmaTheme.ink(dark)) { openCamera() }
                }
                CheckInPhase.SUBMITTING -> {
                    Box(Modifier.fillMaxWidth().height(140.dp), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            CircularProgressIndicator(color = AlmaTheme.sage)
                            Text(progressText, color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
                        }
                    }
                }
                CheckInPhase.SUCCESS -> {
                    Box(
                        Modifier.size(72.dp).background(AlmaTheme.sage.copy(alpha = 0.16f), RoundedCornerShape(36.dp)),
                        contentAlignment = Alignment.Center,
                    ) { Text("✓", color = AlmaTheme.sage, fontSize = 34.sp, fontWeight = FontWeight.Bold) }
                    Text("উপস্থিতি রেকর্ড হয়েছে", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    CheckInButton("বন্ধ করুন", AlmaTheme.sage, dark) { onDismiss() }
                }
                CheckInPhase.ERROR -> {
                    Text(
                        errorText ?: "কিছু একটা সমস্যা হয়েছে",
                        color = AlmaTheme.coral, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                    )
                    if (imageDataUrl != null) {
                        CheckInButton("আবার চেষ্টা করুন", AlmaTheme.sage, dark) { submit() }
                    }
                    CheckInButton("আবার তুলুন", AlmaTheme.cardBg(dark), dark, textColor = AlmaTheme.ink(dark)) { openCamera() }
                    CheckInButton("বন্ধ করুন", AlmaTheme.cardBg(dark), dark, textColor = AlmaTheme.ink(dark)) { onDismiss() }
                }
            }
        }
    }
}

@Composable
private fun CheckInButton(
    label: String,
    bg: Color,
    dark: Boolean,
    textColor: Color = Color.White,
    onClick: () -> Unit,
) {
    Text(
        label,
        color = textColor, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth()
            .background(bg, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onClick)
            .padding(vertical = 13.dp),
    )
}

/** Map the server's check-in errors to a short Bangla line. The system-owner block is
 *  the common surprise (the owner cannot check in — attendance is for employees). */
private fun mapCheckInError(message: String?, status: Int): String {
    val m = message ?: ""
    return when {
        m.contains("System owner", true) -> "মালিক অ্যাকাউন্টে হাজিরা হয় না — স্টাফ অ্যাকাউন্ট দিয়ে টেস্ট করুন"
        m.contains("employee ID", true) || m.contains("employee id", true) -> "আপনার অ্যাকাউন্টে HR employee ID যুক্ত নেই — অ্যাডমিনকে বলুন"
        m.contains("storage", true) -> "ছবি স্টোরেজ কনফিগার করা নেই — অ্যাডমিনকে জানান"
        m.contains("Face", true) || m.contains("face", true) -> "মুখের ছবি ভালো করে তুলুন (ভালো আলোয়, সামনের ক্যামেরা)"
        status == 403 -> "অনুমতি নেই — $m"
        else -> m.ifBlank { "চেক-ইন হয়নি — আবার চেষ্টা করুন" }
    }
}
