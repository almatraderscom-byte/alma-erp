//
//  AlmaMediaViewer.kt
//  ALMA ERP — native video/audio playback + media download/share, replacing the
//  Creative Studio "play / download / share on web" escapes. Media is downloaded to
//  cache (handles same-origin cookie auth + reliability), played with the framework
//  VideoView (no ExoPlayer dependency), and shared via ACTION_SEND (FileProvider).
//

package com.almatraders.erp.pages

import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import android.webkit.CookieManager
import com.almatraders.erp.shell.AlmaTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

private val mediaHttp by lazy {
    OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()
}

private fun absoluteUrl(url: String): String =
    if (url.startsWith("http")) url else AlmaTheme.BASE_URL + (if (url.startsWith("/")) url else "/$url")

/** Download a media file to cache (adds session cookie for same-origin ALMA URLs). */
private suspend fun downloadMedia(context: Context, url: String, fileName: String): File? = withContext(Dispatchers.IO) {
    try {
        val absolute = absoluteUrl(url)
        val b = Request.Builder().url(absolute)
        if (absolute.startsWith(AlmaTheme.BASE_URL)) {
            CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)?.let { b.header("Cookie", it) }
        }
        mediaHttp.newCall(b.build()).execute().use { resp ->
            if (!resp.isSuccessful) return@withContext null
            val bytes = resp.body?.bytes() ?: return@withContext null
            File(context.cacheDir, fileName).apply { writeBytes(bytes) }
        }
    } catch (_: Exception) {
        null
    }
}

/** Fetch a media URL and open the native share sheet. */
fun downloadAndShareMedia(context: Context, url: String, mime: String, fileName: String, onState: (String?) -> Unit) {
    // Runs on a background thread via a tiny coroutine-free executor to avoid blocking UI.
    Thread {
        val absolute = absoluteUrl(url)
        try {
            val b = Request.Builder().url(absolute)
            if (absolute.startsWith(AlmaTheme.BASE_URL)) {
                CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)?.let { b.header("Cookie", it) }
            }
            mediaHttp.newCall(b.build()).execute().use { resp ->
                if (!resp.isSuccessful) { onState("ডাউনলোড হয়নি"); return@Thread }
                val bytes = resp.body?.bytes() ?: run { onState("ডাউনলোড হয়নি"); return@Thread }
                val file = File(context.cacheDir, fileName).apply { writeBytes(bytes) }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(Intent.createChooser(send, "Share").apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
                onState(null)
            }
        } catch (_: Exception) {
            onState("ডাউনলোড হয়নি")
        }
    }.start()
}

/** Full native video/audio player sheet. Downloads [url] then plays the local file. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlmaMediaPlayerSheet(
    url: String,
    isVideo: Boolean,
    title: String,
    dark: Boolean,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var file by remember { mutableStateOf<File?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        val ext = if (isVideo) "mp4" else "m4a"
        val f = downloadMedia(context, url, "alma-play.$ext")
        if (f == null) error = "মিডিয়া লোড হয়নি" else file = f
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = AlmaTheme.rootBg(dark)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 16.sp, textAlign = TextAlign.Center)
            when {
                error != null -> Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) {
                    Text(error!!, color = AlmaTheme.coral, fontSize = 13.sp)
                }
                file == null -> Box(Modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = AlmaTheme.violet)
                }
                isVideo -> AndroidView(
                    factory = { ctx ->
                        VideoView(ctx).apply {
                            setVideoPath(file!!.absolutePath)
                            val mc = MediaController(ctx)
                            mc.setAnchorView(this)
                            setMediaController(mc)
                            setOnPreparedListener { mp -> mp.isLooping = false; start() }
                        }
                    },
                    modifier = Modifier.fillMaxWidth().aspectRatio(9f / 16f),
                )
                else -> {
                    // Audio: auto-play via MediaPlayer.
                    LaunchedEffect(file) {
                        withContext(Dispatchers.IO) {
                            runCatching {
                                MediaPlayer().apply { setDataSource(file!!.absolutePath); prepare(); start() }
                            }
                        }
                    }
                    Text("🎵 অডিও চলছে…", color = AlmaTheme.ink(dark), fontSize = 14.sp)
                }
            }
        }
    }
}
