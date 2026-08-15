# LIBERTY — Android app

A thin WebView wrapper around the deployed game (`https://libertymmo.up.railway.app/`,
see `GAME_URL` in `app/src/main/java/com/liberty/mmorpg/MainActivity.kt`). It does not
ship the game — it loads the live site, same as a browser would.

## Why this exists

The game is a Telegram Mini App: inside Telegram it authenticates via
`window.Telegram.WebApp.initData` (see `_initTelegramWidget()` in `js/network.js`),
which only exists when Telegram itself opens the page. A plain WebView has no such
context, so this app instead:

1. Sets a custom token in its WebView user agent (`LibertyAndroidApp/1.0`).
2. `_initTelegramWidget()` detects that token and renders the
   [Telegram Login Widget](https://core.telegram.org/widgets/login) on the splash
   screen instead of the "open in Telegram" message.
3. The widget's callback sends the signed Telegram user data to the existing
   `loginTelegram` socket event, verified server-side by `verifyTelegramAuth()`
   in `server/security.js` — a second, already-implemented auth path alongside
   the Mini App one.

## One manual step required before this works

Telegram's Login Widget only renders for a domain the bot owner has registered.
Whoever controls the bot must message **@BotFather**:

```
/setdomain
<select the bot>
libertymmo.up.railway.app
```

Without this, the widget on the login screen will fail silently (no login button,
or an error from Telegram). This cannot be done from code — only the bot's owner
can set it via BotFather.

## Building

Requires JDK 17+ and the Android SDK (platform 34, build-tools 34.0.0).

```
cd android
./gradlew assembleDebug      # unsigned/debug-signed, fine for sideloading & testing
./gradlew assembleRelease    # needs a signing keystore, see below
```

### Signing a release build

The release build reads its signing config from environment variables — no
keystore is committed to this repo:

```
export LIBERTY_KEYSTORE=/path/to/your.keystore
export LIBERTY_KEYSTORE_PASSWORD=...
export LIBERTY_KEY_ALIAS=liberty
export LIBERTY_KEY_PASSWORD=...
./gradlew assembleRelease
```

A keystore was generated for this build and delivered to you outside of git —
**keep it**. Every future release must be signed with the same keystore, or
Android will refuse to install the update over the existing app (and, for the
Play Store, refuse the update outright). Losing it means the next release has to
ship as a new, separate app.

## Icon / splash

Both come from `images/splash-liberty.jpg` (the game's own loading screen art):
the launcher icon is a square crop of its top portion (the statue), regenerated
via `res/mipmap-*/ic_launcher*.png`; the in-app splash (`res/drawable/splash.jpg`)
is the full image, shown until the WebView's `onPageFinished` fires.
