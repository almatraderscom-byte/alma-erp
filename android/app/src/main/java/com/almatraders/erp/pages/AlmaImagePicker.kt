//
//  AlmaImagePicker.kt
//  ALMA ERP — reusable native image capture/pick + downscale, shared by every screen
//  that used to escape to the web for an upload (catalog images, receipts, expense
//  photos, brand models/logos, office media). Gallery uses the modern Photo Picker
//  (no storage permission); camera reuses the manifest FileProvider. Output is a
//  downscaled JPEG (bytes for multipart, or a data URL for base64 endpoints).
//
//  This is the one-way native replacement for the "ওয়েবে খুলুন" upload buttons —
//  each page wires rememberImagePick { … } to AlmaApi.uploadMultipart / send(base64).
//

package com.almatraders.erp.pages

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import com.almatraders.erp.shell.AlmaApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File

/** A picked + already-downscaled JPEG. */
class PickedImage(val bytes: ByteArray, val fileName: String) {
    val mime: String get() = "image/jpeg"
    fun toFilePart(field: String = "file") = AlmaApi.FilePart(field, fileName, mime, bytes)
    fun toDataUrl(): String = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
}

// ── Shared bitmap → downscaled JPEG bytes ────────────────────────────────────────────

private fun decodeSampledBytes(input: ByteArray, reqSide: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(input, 0, input.size, bounds)
    var sample = 1
    val big = maxOf(bounds.outWidth, bounds.outHeight)
    while (big / sample > reqSide * 2) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(input, 0, input.size, opts)
}

fun bitmapToJpegBytes(bitmap: Bitmap, maxSide: Int, quality: Int): ByteArray {
    val side = maxOf(bitmap.width, bitmap.height)
    val scaled = if (side > maxSide) {
        val ratio = maxSide.toFloat() / side
        Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * ratio).toInt().coerceAtLeast(1),
            (bitmap.height * ratio).toInt().coerceAtLeast(1),
            true,
        )
    } else bitmap
    return ByteArrayOutputStream().apply { scaled.compress(Bitmap.CompressFormat.JPEG, quality, this) }.toByteArray()
}

private suspend fun uriToPicked(context: Context, uri: Uri, maxSide: Int, quality: Int): PickedImage? =
    withContext(Dispatchers.IO) {
        val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@withContext null
        val bmp = decodeSampledBytes(raw, maxSide) ?: return@withContext null
        PickedImage(bitmapToJpegBytes(bmp, maxSide, quality), "upload-${System.identityHashCode(bmp)}.jpg")
    }

private suspend fun fileToPicked(context: Context, file: File, maxSide: Int, quality: Int): PickedImage? =
    withContext(Dispatchers.IO) {
        val raw = runCatching { file.readBytes() }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return@withContext null
        val bmp = decodeSampledBytes(raw, maxSide) ?: return@withContext null
        PickedImage(bitmapToJpegBytes(bmp, maxSide, quality), "camera-${System.identityHashCode(bmp)}.jpg")
    }

// ── Composable pickers ────────────────────────────────────────────────────────────────

/** Gallery pick via the system Photo Picker (no runtime permission). Returns a launch
 *  lambda; [onResult] fires with the downscaled JPEG (null if cancelled/unreadable). */
@Composable
fun rememberGalleryPick(
    maxSide: Int = 1600,
    quality: Int = 85,
    onResult: (PickedImage?) -> Unit,
): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) { onResult(null); return@rememberLauncherForActivityResult }
        scope.launch { onResult(uriToPicked(context, uri, maxSide, quality)) }
    }
    return { launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
}

/** Camera capture via the manifest FileProvider. Returns a launch lambda; [onResult]
 *  fires with the downscaled JPEG (null if cancelled). Camera permission is handled by
 *  the system camera app that the intent opens. */
@Composable
fun rememberCameraPick(
    maxSide: Int = 1600,
    quality: Int = 85,
    onResult: (PickedImage?) -> Unit,
): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val file = remember { File(context.cacheDir, "pick-camera.jpg") }
    val uri = remember { FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (!ok) { onResult(null); return@rememberLauncherForActivityResult }
        scope.launch { onResult(fileToPicked(context, file, maxSide, quality)) }
    }
    return { launcher.launch(uri) }
}

/** Convenience wrapper used by upload sheets — opens the gallery picker; some sites
 *  (grantUriPermission) also expose the camera picker separately. */
@Suppress("unused")
private fun grantRead(context: Context, intent: Intent, uri: Uri) {
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.grantUriPermission(context.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
}
