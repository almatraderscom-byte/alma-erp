//
//  ForcedUpdateGate.kt
//  ALMA ERP — native forced-update gate for the Compose shell.
//
//  The web <ForcedUpdateGate> only renders inside the WebView, which the native shell
//  keeps mounted at 1dp — so an owner who lives on the native screens never sees it.
//  This is the NATIVE twin: it reads the installed APK versionCode, fetches
//  /api/app/native-version { minBuild, apkUrl }, and — only when a KNOWN install is
//  strictly below minBuild — covers the whole shell with a blocking download prompt.
//
//  Fail-safe by design: any error (offline, unknown build, missing url) leaves the app
//  fully usable — the gate only ever appears for a definite too-old build.
//

package com.almatraders.erp.shell

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Native blocking update gate. Renders nothing unless the installed build is a KNOWN
 * value strictly below `minBuild` from /api/app/native-version. Mount it LAST in the
 * shell so it covers every native + web screen when it fires.
 */
@Composable
fun ForcedUpdateGate(dark: Boolean) {
    val ctx = LocalContext.current

    val installed = remember {
        try {
            val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toInt()
            else @Suppress("DEPRECATION") pi.versionCode
        } catch (_: Exception) {
            0
        }
    }

    var minBuild by remember { mutableStateOf(0) }
    var apkUrl by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            val root = AlmaApi.getObject("/api/app/native-version")
            minBuild = root.flexInt("minBuild") ?: 0
            apkUrl = root.str("apkUrl")
        } catch (_: Exception) {
            // Fail-safe: never block the app on a fetch error.
        }
    }

    val url = apkUrl
    // Only gate a definite too-old build; unknown install (0) or fetch failure ⇒ no gate.
    if (minBuild <= 0 || installed <= 0 || installed >= minBuild || url.isNullOrBlank()) return

    AuroraBackground(dark) {
        Box(
            Modifier
                .fillMaxSize()
                // Swallow taps so nothing behind the opaque gate is reachable.
                .pointerInput(Unit) { detectTapGestures { } },
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 32.dp)
                    .almaGlass(dark, AlmaTheme.R_CARD)
                    .padding(horizontal = 24.dp, vertical = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    "ALMA ERP",
                    color = AlmaTheme.coral,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 3.sp,
                )
                Text(
                    "নতুন আপডেট আবশ্যক",
                    color = AlmaTheme.ink(dark),
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                )
                Text(
                    "অ্যাপের নতুন ভার্সন এসেছে। চালিয়ে যেতে নিচের বাটনে নামিয়ে ইনস্টল করুন।",
                    color = AlmaTheme.inkSecondary(dark),
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                )
                Button(
                    onClick = {
                        // Off-domain Supabase URL → system browser download manager fetches
                        // the APK (a WebView/in-app load can't download it).
                        runCatching {
                            ctx.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = AlmaTheme.coral),
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                ) {
                    Text("নতুন ভার্সন ডাউনলোড", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                }
                Text(
                    "ডাউনলোড শেষে ফাইলটি খুলে ইনস্টল দিন।",
                    color = AlmaTheme.inkTertiary(dark),
                    fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
