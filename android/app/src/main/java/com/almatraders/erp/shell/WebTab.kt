//
//  WebTab.kt
//  ALMA ERP — a web fallback screen inside the native shell (twin of the iOS
//  AlmaWebTabViewController). Loads a live ERP route in a WebView that shares the
//  app-global cookie session, injects the embed-mode flags the web reads
//  (window.__almaNative / __almaNativeHeader — src/lib/native-shell.ts) and hides
//  the web's own bottom chrome so the native tab bar is the only chrome.
//

package com.almatraders.erp.shell

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/** JS the iOS shell injects at document start (AlmaEmbed.flagScript/headerFlagScript). */
private fun embedFlagsJs(hideWebHeader: Boolean) = buildString {
    append("window.__almaNative = true;")
    if (hideWebHeader) append("window.__almaNativeHeader = true;")
}

/** Belt-and-suspenders CSS at document end (AlmaEmbed.hideChromeScript twin). */
private const val HIDE_CHROME_JS =
    "(function(){var id='__alma_native_embed';" +
        "if(document.getElementById(id))return;" +
        "var s=document.createElement('style');s.id=id;" +
        "s.textContent='.mobile-app-chrome{display:none !important}';" +
        "(document.head||document.documentElement).appendChild(s);})();"

/**
 * Builds a configured ERP WebView. Not a composable — the shell also uses this for
 * pushed web screens whose instance must survive recomposition.
 */
@SuppressLint("SetJavaScriptEnabled")
fun buildErpWebView(
    context: android.content.Context,
    path: String,
    hideWebHeader: Boolean,
    onLoadingChanged: (Boolean) -> Unit = {},
): WebView {
    val webView = WebView(context)
    webView.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false
        // The web reads window.__almaNative; the ?native param is the deterministic
        // fallback for the very first paint (src/lib/native-shell.ts accepts both).
    }
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

    // True document-start injection where supported (androidx.webkit ≥ 1.5);
    // onPageStarted evaluate is the fallback for older WebView providers.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        try {
            WebViewCompat.addDocumentStartJavaScript(
                webView, embedFlagsJs(hideWebHeader), setOf("*"),
            )
        } catch (_: Exception) { /* fall back to onPageStarted */ }
    }

    webView.webViewClient = object : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            view.evaluateJavascript(embedFlagsJs(hideWebHeader), null)
            onLoadingChanged(true)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            view.evaluateJavascript(embedFlagsJs(hideWebHeader), null)
            view.evaluateJavascript(HIDE_CHROME_JS, null)
            view.evaluateJavascript(AlmaTheme.applyJs(), null)
            onLoadingChanged(false)
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            // Keep the ERP host in-shell; external links (wa.me, tel:) go to the system.
            return if (url.host == "alma-erp-six.vercel.app" || url.scheme == "about") {
                false
            } else {
                try {
                    context.startActivity(
                        android.content.Intent(android.content.Intent.ACTION_VIEW, url),
                    )
                } catch (_: Exception) { }
                true
            }
        }
    }

    val sep = if (path.contains("?")) "&" else "?"
    val suffix = if (hideWebHeader) "${sep}native=1&nativehdr=1" else "${sep}native=1"
    webView.loadUrl(AlmaTheme.BASE_URL + path + suffix)
    return webView
}

/**
 * Web fallback screen: the WebView fills the given area; a branded loading veil
 * covers the first paint (premium-loader stand-in — the aurora already sits behind).
 */
@Composable
fun WebTabScreen(
    path: String,
    hideWebHeader: Boolean,
    modifier: Modifier = Modifier,
    register: ((WebView) -> Unit)? = null,
) {
    var loading by remember { mutableStateOf(true) }
    Box(modifier.fillMaxSize()) {
        AndroidView(
            factory = { ctx ->
                buildErpWebView(ctx, path, hideWebHeader) { loading = it }.also {
                    it.layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    register?.invoke(it)
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
        if (loading) AlmaLoadingVeil()
    }
}
