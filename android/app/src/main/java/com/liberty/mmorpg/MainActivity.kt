package com.liberty.mmorpg

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible

// The deployed game — same origin the TON Connect manifest and BotFather
// Mini App URL point at (see tonconnect-manifest.json).
private const val GAME_URL = "https://libertymmo.up.railway.app/"

// js/network.js._initTelegramWidget() looks for this token in the WebView's
// user agent to decide the client has no Telegram Mini App context and
// should render the Telegram Login Widget instead of the "open in Telegram"
// splash. Keep the two in sync.
private const val UA_SUFFIX = " LibertyAndroidApp/1.0"

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var offlineView: View

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        offlineView = findViewById(R.id.offline_view)
        val splash = findViewById<View>(R.id.splash_overlay)

        findViewById<Button>(R.id.retry_button).setOnClickListener {
            offlineView.isVisible = false
            webView.loadUrl(GAME_URL)
        }

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.userAgentString = settings.userAgentString + UA_SUFFIX
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val scheme = uri.scheme
                // Keep the game and Telegram's own login-widget iframe (oauth.telegram.org)
                // inside the WebView; hand everything else (tg://, t.me deep links into
                // the Telegram app, mailto:, etc.) to the system so it opens for real.
                if (scheme == "http" || scheme == "https") {
                    val host = uri.host ?: ""
                    if (host == Uri.parse(GAME_URL).host || host == "oauth.telegram.org" || host.endsWith(".telegram.org") || host == "telegram.org") {
                        return false
                    }
                }
                return openExternally(uri)
            }

            override fun onPageFinished(view: WebView, url: String) {
                splash.isVisible = false
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    splash.isVisible = false
                    offlineView.isVisible = true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // The Telegram Login Widget confirms via an iframe, not a popup, but some
            // Telegram flows (e.g. the desktop "web login" fallback) call window.open.
            // Route those through the system browser/Telegram app rather than dropping
            // them, since WebView has no second window to show them in.
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message
            ): Boolean {
                val href = view.handler?.obtainMessage()
                val transport = resultMsg.obj as? WebView.WebViewTransport
                val popup = WebView(this@MainActivity)
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        openExternally(request.url)
                        return true
                    }
                }
                transport?.webView = popup
                resultMsg.sendToTarget()
                href?.recycle()
                return true
            }
        }

        // Exposes AndroidLiberty.switchAccount() to js/network.js
        // (_switchTelegramAccount). The Telegram Login Widget's session lives
        // in a cookie on oauth.telegram.org — cross-origin from the game, so
        // page JS can't clear it with document.cookie. This can, natively.
        webView.addJavascriptInterface(JsBridge(), "AndroidLiberty")

        webView.loadUrl(GAME_URL)
    }

    private inner class JsBridge {
        @JavascriptInterface
        fun switchAccount() {
            runOnUiThread {
                val cookieManager = CookieManager.getInstance()
                cookieManager.removeAllCookies(null)
                cookieManager.flush()
                webView.loadUrl(GAME_URL)
            }
        }
    }

    private fun openExternally(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (e: ActivityNotFoundException) {
            true
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
