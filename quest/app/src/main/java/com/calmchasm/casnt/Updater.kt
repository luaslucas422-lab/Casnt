package com.calmchasm.casnt

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Casnt's own updater: checks the GitHub releases and installs the newest Quest APK. */
object Updater {
    private const val API = "https://api.github.com/repos/luaslucas422-lab/Casnt/releases/latest"

    data class Release(val version: String, val apkUrl: String, val size: Long)

    fun currentVersion(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "0"
    } catch (_: Exception) { "0" }

    /** Newest release, or null if it can't be reached / has no APK. */
    fun latest(): Release? = try {
        val c = URL(API).openConnection() as HttpURLConnection
        c.connectTimeout = 6000; c.readTimeout = 8000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "Casnt-Quest")
        val body = c.inputStream.bufferedReader().use { it.readText() }
        val o = JSONObject(body)
        val assets = o.optJSONArray("assets")
        var rel: Release? = null
        if (assets != null) for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            if (a.optString("name").endsWith(".apk", true)) {
                rel = Release(o.optString("tag_name").removePrefix("v"), a.optString("browser_download_url"), a.optLong("size"))
                break
            }
        }
        rel
    } catch (_: Exception) { null }

    /** "0.10.1" > "0.9.3" */
    fun isNewer(candidate: String, current: String): Boolean {
        val a = candidate.split('.', '-').map { it.toIntOrNull() ?: 0 }
        val b = current.split('.', '-').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }; val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** Downloads the APK into the app cache. [progress] gets 0..100. */
    fun download(ctx: Context, rel: Release, progress: (Int) -> Unit): File? = downloadInner(ctx, rel, progress)

    private fun downloadInner(ctx: Context, rel: Release, progress: (Int) -> Unit): File? { try {
        val file = File(ctx.cacheDir, "Casnt-update.apk")
        fun open(u: URL): HttpURLConnection = (u.openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = false
            connectTimeout = 8000; readTimeout = 15000
            setRequestProperty("User-Agent", "Casnt-Quest")
        }
        var url = URL(rel.apkUrl)
        var conn = open(url)
        var hops = 0
        while (conn.responseCode in 300..399 && hops++ < 5) { // GitHub redirects to its file host
            val next = URL(url, conn.getHeaderField("Location"))
            conn.disconnect()
            url = next
            conn = open(url)
        }
        if (conn.responseCode != 200) return null
        val total = if (conn.contentLengthLong > 0) conn.contentLengthLong else rel.size
        conn.inputStream.use { input ->
            file.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                var last = -1
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    val pct = if (total > 0) (done * 100 / total).toInt() else 0
                    if (pct != last) { last = pct; progress(pct) }
                }
            }
        }
        return file
    } catch (_: Exception) { return null } }

    /**
     * Hands the APK to the system installer. Returns false if Casnt first needs the
     * "install unknown apps" permission (the settings page is opened for that).
     */
    fun install(activity: Activity, apk: File): Boolean {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            try {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            } catch (_: Exception) { }
            return false
        }
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("casnt.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            val pi = PendingIntent.getBroadcast(activity, 77, Intent(activity, InstallReceiver::class.java), flags or PendingIntent.FLAG_UPDATE_CURRENT)
            session.commit(pi.intentSender)
        }
        return true
    }
}

/** Gets the installer's answer; when it needs the user to confirm, shows the system prompt. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm: Intent? = intent.getParcelableExtra(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (confirm != null) context.startActivity(confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            else -> UpdateState.failed(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Install failed")
        }
    }
}

/** Lets the update screen hear about install failures. */
object UpdateState {
    @Volatile var onFail: ((String) -> Unit)? = null
    fun failed(msg: String) { onFail?.invoke(msg) }
}
