//
//  AlmaPdfViewer.kt
//  ALMA ERP — native in-app PDF viewing + share, replacing the "PDF — ওয়েবে খুলুন"
//  escapes (invoices, digital invoices, salary slips). A PDF is generated server-side
//  (returns a pdf_url), downloaded to cache, rendered page-by-page with the framework
//  PdfRenderer (no external lib), and shown in a scrollable Compose viewer with a
//  native share button (ACTION_SEND via the manifest FileProvider). No web page.
//

package com.almatraders.erp.pages

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import android.webkit.CookieManager
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.plainClick
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

private val pdfHttp by lazy {
    OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .build()
}

/** Download a PDF (external pdf_url or same-origin path) into cache. Adds the session
 *  cookie only for same-origin ALMA URLs. Returns the file or null. */
private suspend fun downloadPdf(context: Context, url: String): File? = withContext(Dispatchers.IO) {
    try {
        val absolute = if (url.startsWith("http")) url else AlmaTheme.BASE_URL + (if (url.startsWith("/")) url else "/$url")
        val b = Request.Builder().url(absolute).header("Accept", "application/pdf")
        if (absolute.startsWith(AlmaTheme.BASE_URL)) {
            CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)?.let { b.header("Cookie", it) }
        }
        pdfHttp.newCall(b.build()).execute().use { resp ->
            if (!resp.isSuccessful) return@withContext null
            val bytes = resp.body?.bytes() ?: return@withContext null
            val f = File(context.cacheDir, "alma-view.pdf")
            f.writeBytes(bytes)
            f
        }
    } catch (_: Exception) {
        null
    }
}

/** Decode a base64 PDF (optionally a data: URL) to a cache file. */
private suspend fun base64ToCache(context: Context, b64: String): File? = withContext(Dispatchers.IO) {
    try {
        val payload = b64.substringAfter("base64,", b64)
        val bytes = android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
        File(context.cacheDir, "alma-view.pdf").apply { writeBytes(bytes) }
    } catch (_: Exception) {
        null
    }
}

/** Render every page of [file] to a bitmap (width-fit to [targetWidth] px). */
private suspend fun renderPdf(file: File, targetWidth: Int = 1400): List<Bitmap> = withContext(Dispatchers.IO) {
    val out = ArrayList<Bitmap>()
    try {
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
            PdfRenderer(pfd).use { renderer ->
                for (i in 0 until renderer.pageCount) {
                    renderer.openPage(i).use { page ->
                        val scale = targetWidth.toFloat() / page.width
                        val w = targetWidth
                        val h = (page.height * scale).toInt().coerceAtLeast(1)
                        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        bmp.eraseColor(AndroidColor.WHITE)
                        page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        out.add(bmp)
                    }
                }
            }
        }
    } catch (_: Exception) { /* return whatever rendered */ }
    out
}

private fun sharePdf(context: Context, file: File) {
    try {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/pdf"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(send, "Share PDF").apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
    } catch (_: Exception) { }
}

/**
 * Full native PDF viewer sheet. Give it either a ready [pdfUrl], or a [generate]
 * suspend that returns the pdf_url (server generation) — the sheet shows a spinner
 * while generating/downloading, then renders the pages in-app with a Share action.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlmaPdfViewerSheet(
    title: String,
    dark: Boolean,
    onDismiss: () -> Unit,
    pdfUrl: String? = null,
    generate: (suspend () -> String?)? = null,
    generateBase64: (suspend () -> String?)? = null,
) {
    val context = LocalContext.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var pages by remember { mutableStateOf<List<Bitmap>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var file by remember { mutableStateOf<File?>(null) }
    var status by remember { mutableStateOf("PDF তৈরি হচ্ছে…") }

    LaunchedEffect(Unit) {
        val f: File? = when {
            generateBase64 != null -> {
                val b64 = try { generateBase64.invoke() } catch (_: Exception) { null }
                if (b64.isNullOrEmpty()) null else base64ToCache(context, b64)
            }
            else -> {
                val url = try { pdfUrl ?: generate?.invoke() } catch (_: Exception) { null }
                if (url.isNullOrEmpty()) null else { status = "ডাউনলোড হচ্ছে…"; downloadPdf(context, url) }
            }
        }
        if (f == null) { error = "PDF তৈরি/ডাউনলোড হয়নি — আবার চেষ্টা করুন"; return@LaunchedEffect }
        file = f
        status = "রেন্ডার হচ্ছে…"
        val rendered = renderPdf(f)
        if (rendered.isEmpty()) { error = "PDF খোলা গেল না" } else pages = rendered
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = AlmaTheme.rootBg(dark)) {
        Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
            Row(title, dark) { file?.let { sharePdf(context, it) } }
            when {
                error != null -> Box(Modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) {
                    Text(error!!, color = AlmaTheme.coral, fontSize = 13.sp, textAlign = TextAlign.Center)
                }
                pages == null -> Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        CircularProgressIndicator(color = AlmaTheme.violet)
                        Text(status, color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
                    }
                }
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(pages!!) { bmp ->
                        Image(
                            bmp.asImageBitmap(), contentDescription = null,
                            contentScale = ContentScale.FillWidth,
                            modifier = Modifier.fillMaxWidth()
                                .background(androidx.compose.ui.graphics.Color.White, RoundedCornerShape(6.dp)),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Row(title: String, dark: Boolean, onShare: () -> Unit) {
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 4.dp))
        androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
        Text(
            "↗ শেয়ার", color = androidx.compose.ui.graphics.Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(AlmaTheme.violet, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick(onShare)
                .padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}
