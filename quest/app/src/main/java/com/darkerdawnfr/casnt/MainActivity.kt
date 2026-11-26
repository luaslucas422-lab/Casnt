package com.darkerdawnfr.casnt

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.util.Calendar

class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var kit: Kit
    private lateinit var root: FrameLayout
    private var screen = ""
    private var castMode = "everything"
    private var pendingPc: SavedPc? = null
    private var pendingQuality = "good"
    private var job = 0 // bumps whenever the user leaves a waiting screen, so stale results are ignored

    private val castListener: (Boolean, String?) -> Unit = { on, note ->
        if (on) showCasting() else if (screen == "casting" || screen == "waiting") showHome(note)
    }

    // ------------------------------------------------------------------ lifecycle
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        root = FrameLayout(this)
        setContentView(root)
        CastState.listen(castListener)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }
        when {
            prefs.userName.isBlank() -> showName()
            CastState.running -> showCasting()
            else -> showHome()
        }
    }

    override fun onDestroy() {
        CastState.unlisten(castListener)
        super.onDestroy()
    }

    @Deprecated("Activity back handling")
    override fun onBackPressed() {
        when (screen) {
            "home", "name" -> @Suppress("DEPRECATION") super.onBackPressed()
            "casting" -> moveTaskToBack(true)
            "waiting" -> cancelWaiting()
            else -> showHome()
        }
    }

    // ------------------------------------------------------------------ helpers
    private fun bg(body: () -> Unit) = Thread(body, "casnt-ui-bg").start()
    private fun ui(body: () -> Unit) = runOnUiThread(body)

    private fun begin(name: String): LinearLayout {
        screen = name
        kit = Kit(this, Look(prefs.cartoonUi, prefs.plainTheme))
        root.removeAllViews()
        root.setBackgroundColor(kit.look.bg)
        return kit.column()
    }

    private fun place(content: View) {
        val wrap = FrameLayout(this)
        wrap.setPadding(dp(40), dp(36), dp(40), dp(36))
        wrap.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        val scroll = ScrollView(this).apply { isFillViewport = true }
        scroll.addView(wrap, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        root.addView(scroll, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        kit.popIn(content)
    }

    private fun greeting(): String {
        val h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val part = when { h < 5 -> "Good night"; h < 12 -> "Good morning"; h < 18 -> "Good afternoon"; else -> "Good evening" }
        return "$part, ${prefs.userName}"
    }

    private fun input(value: String, hint: String, numeric: Boolean = false): EditText = EditText(this).apply {
        setText(value)
        this.hint = hint
        textSize = 24f
        setSingleLine()
        imeOptions = EditorInfo.IME_ACTION_DONE
        inputType = if (numeric) InputType.TYPE_CLASS_NUMBER else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
        setTextColor(kit.look.text)
        setHintTextColor(kit.look.faint)
        background = kit.rounded(intArrayOf(kit.look.bg), 18)
        setPadding(dp(20), dp(14), dp(20), dp(14))
        minWidth = dp(420)
    }

    private fun backButton() = kit.button("Back", Kit.Kind.DARK, 20f, 12, 28) { showHome() }

    // ------------------------------------------------------------------ first launch: name
    private fun showName() {
        val c = begin("name")
        c.add(kit.title("Casnt"))
        c.add(kit.heading("What should we call you?", 30f), top = 18)
        c.add(kit.label("Meta doesn't let apps read your Meta name, so type the name you want Casnt to show.",
            16f, kit.look.faint).apply { maxWidth = dp(560) }, top = 10)
        val field = input(prefs.userName, "Your name")
        c.add(field, top = 22)
        c.add(kit.button("Continue") {
            val n = field.text.toString().trim()
            if (n.isNotEmpty()) { prefs.userName = n; showHome() }
        }, top = 22)
        place(c)
    }

    // ------------------------------------------------------------------ home
    private fun showHome(message: String? = null) {
        job++
        val c = begin("home")
        c.add(kit.title("Casnt", 64f))
        if (prefs.showGreeting) c.add(kit.heading(greeting(), 28f), top = 4)
        if (message != null) c.add(kit.label(message, 18f, kit.look.muted).apply { maxWidth = dp(640) }, top = 12)

        c.add(kit.button("CAST TO PC", sizeSp = 42f, padV = 30, padH = 90) { onCastPressed() }, top = 28)

        val pcs = prefs.pcs()
        val last = pcs.firstOrNull { it.pcId == prefs.lastPcId } ?: pcs.firstOrNull()
        c.add(kit.label(if (last == null) "No PC paired yet — tap Cast to PC to add one." else "Casting to ${last.pcName}",
            16f, kit.look.faint), top = 12)

        // TikTok LIVE sits right under the home controls.
        c.add(kit.button("●  TikTok LIVE", Kit.Kind.PINK, 24f, 14, 40) { showTikTokAsk() }, top = 24)

        val r = kit.row()
        r.add(kit.button("My PCs", Kit.Kind.DARK, 20f, 12, 28) { showPcs() })
        r.add(kit.hspace(16))
        r.add(kit.button("Settings", Kit.Kind.DARK, 20f, 12, 28) { showSettings() })
        c.add(r, top = 22)
        place(c)
    }

    private fun onCastPressed() {
        val pcs = prefs.pcs()
        when {
            pcs.isEmpty() -> showAddPc()
            pcs.size == 1 -> showCastMode(pcs[0])
            else -> showPickPc(pcs)
        }
    }

    private fun showPickPc(pcs: List<SavedPc>) {
        val c = begin("pick")
        c.add(kit.heading("Which PC?", 36f))
        for (pc in pcs) c.add(kit.button(pc.pcName, Kit.Kind.DARK, 24f) { showCastMode(pc) }, LinearLayout.LayoutParams.MATCH_PARENT, top = 14)
        c.add(backButton(), top = 22)
        place(c)
    }

    // ------------------------------------------------------------------ cast: what to share
    private fun showCastMode(pc: SavedPc) {
        val c = begin("mode")
        val appShareOk = Build.VERSION.SDK_INT >= 34
        if (!appShareOk) castMode = "everything"
        c.add(kit.heading("What do you want to cast?", 34f))
        c.add(kit.label("Casting to ${pc.pcName}", 18f, kit.look.muted), top = 6)

        val r = kit.row()
        val everything = option("Everything", "Everything you see, including your Meta menus.", castMode == "everything", true) {
            castMode = "everything"; showCastMode(pc)
        }
        val app = option("Just an app", if (appShareOk) "Pick one app or game. Your Meta menus stay hidden."
            else "Needs a newer Horizon OS update on this Quest.", castMode == "app", appShareOk) {
            castMode = "app"; showCastMode(pc)
        }
        r.add(everything, dp(330))
        r.add(kit.hspace(22))
        r.add(app, dp(330))
        c.add(r, top = 22)

        val b = kit.row()
        b.add(backButton())
        b.add(kit.hspace(16))
        b.add(kit.button("Next", sizeSp = 24f) { startCastRequest(pc) })
        c.add(b, top = 26)
        place(c)
    }

    private fun option(title: String, desc: String, selected: Boolean, enabled: Boolean, onPick: () -> Unit): View {
        val card = kit.card(pad = 22)
        if (selected) card.background = kit.rounded(kit.look.gold, 30, if (kit.look.cartoon) 5 else 2)
        val ink = if (selected) 0xFF1B1408.toInt() else kit.look.text
        card.add(kit.label(title, 26f, ink, bold = true))
        card.add(kit.label(desc, 16f, if (selected) 0xFF3A2A0E.toInt() else kit.look.muted), top = 8)
        card.alpha = if (enabled) 1f else 0.45f
        if (enabled) card.setOnClickListener { kit.bounce(card); onPick() }
        return card
    }

    // ------------------------------------------------------------------ cast: ask the PC
    private fun startCastRequest(pc: SavedPc) {
        pendingPc = pc
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO) // needed for game audio + mic
            return
        }
        askPc(pc)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_AUDIO) pendingPc?.let { askPc(it) } // without it we still cast video
    }

    private fun askPc(pc: SavedPc) {
        val myJob = ++job
        val status = showWaiting("Connecting to ${pc.pcName}…")
        bg {
            when (val r = Connector.connect(prefs, pc)) {
                is Connector.Result.NotFound -> ui {
                    if (myJob == job) showHome("Couldn't find ${pc.pcName}. Make sure it's on with Casnt running, and that your Quest is on the same Wi-Fi (or plugged in by USB).")
                }
                is Connector.Result.Forgotten -> ui {
                    prefs.removePc(pc.pcId)
                    if (myJob == job) showHome("${pc.pcName} forgot this Quest. Pair it again with a new code.")
                }
                is Connector.Result.Ok -> {
                    val link = r.link
                    if (myJob != job) { link.close(); return@bg }
                    Session.link = link
                    Session.pcName = pc.pcName
                    prefs.lastPcId = pc.pcId
                    ui { status.text = "Waiting for ${pc.pcName} to accept…" }
                    link.send(JSONObject().put("t", "cast_request").put("mode", castMode))
                    val answer = link.await(setOf("cast_accept", "cast_decline"), 65_000L)
                    ui {
                        if (myJob != job) { link.close(); return@ui }
                        when (answer?.optString("t")) {
                            "cast_accept" -> launchProjection(answer?.optString("quality", "good") ?: "good")
                            "cast_decline" -> {
                                endSession()
                                showHome(if (answer?.optString("reason") == "busy") "${pc.pcName} is already receiving a cast."
                                    else "${pc.pcName} didn't accept the cast.")
                            }
                            else -> { endSession(); showHome("${pc.pcName} didn't answer.") }
                        }
                    }
                }
            }
        }
    }

    private fun showWaiting(text: String): TextView {
        val c = begin("waiting")
        c.add(kit.title("Casnt", 48f))
        val dot = kit.label("●", 46f, kit.look.gold[1])
        kit.pulse(dot)
        c.add(dot, top = 10)
        val status = kit.label(text, 24f, kit.look.text, bold = true)
        c.add(status, top = 8)
        c.add(kit.button("Cancel", Kit.Kind.DARK, 20f, 12, 28) { cancelWaiting() }, top = 26)
        place(c)
        return status
    }

    private fun cancelWaiting() {
        job++
        endSession()
        showHome()
    }

    private fun endSession() {
        Session.link?.close()
        Session.link = null
    }

    private fun launchProjection(quality: String) {
        pendingQuality = quality
        showWaiting("Confirm the share prompt…")
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val intent = if (Build.VERSION.SDK_INT >= 34) {
            val config = if (castMode == "app") MediaProjectionConfig.createConfigForUserChoice()
            else MediaProjectionConfig.createConfigForDefaultDisplay()
            mpm.createScreenCaptureIntent(config)
        } else mpm.createScreenCaptureIntent()
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQ_PROJECTION)
    }

    @Deprecated("Activity result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        if (resultCode == RESULT_OK && data != null && Session.link != null) {
            val svc = Intent(this, CastService::class.java)
                .putExtra(CastService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(CastService.EXTRA_RESULT_DATA, data)
                .putExtra(CastService.EXTRA_QUALITY, pendingQuality)
            startForegroundService(svc)
        } else {
            Session.link?.send(JSONObject().put("t", "cast_stop"))
            root.postDelayed({ endSession() }, 300)
            showHome("Cast cancelled.")
        }
    }

    // ------------------------------------------------------------------ casting
    private fun showCasting() {
        val c = begin("casting")
        c.add(kit.title("Casnt", 48f))
        val dot = kit.label("●", 54f, 0xFF7DFF6A.toInt())
        kit.pulse(dot)
        c.add(dot, top = 6)
        c.add(kit.heading("Casting to ${Session.pcName}", 34f), top = 4)
        c.add(kit.label(if (castMode == "app") "Only the app you picked is being shared." else "Your PC is showing everything you see.",
            18f, kit.look.muted), top = 8)
        c.add(kit.label("Quality, audio and stats controls arrive in the next Casnt update.", 15f, kit.look.faint), top = 6)
        c.add(kit.button("STOP CASTING", Kit.Kind.RED, 30f, 22, 60) {
            startService(Intent(this, CastService::class.java).setAction(CastService.ACTION_STOP))
        }, top = 26)
        place(c)
    }

    // ------------------------------------------------------------------ pairing
    private fun showAddPc(error: String? = null) {
        job++
        val c = begin("addpc")
        c.add(kit.heading("Add a PC", 38f))
        c.add(kit.label("Open Casnt on your PC and type the 6-digit code it shows.", 18f, kit.look.muted), top = 6)
        if (error != null) c.add(kit.label(error, 16f, 0xFFFF8A7A.toInt()).apply { maxWidth = dp(620) }, top = 10)

        val code = StringBuilder()
        val boxes = kit.row()
        val cells = (0 until 6).map {
            kit.label("", 40f, if (kit.look.cartoon) 0xFF000000.toInt() else kit.look.text, bold = true).apply {
                background = kit.rounded(if (kit.look.cartoon) kit.look.gold else intArrayOf(kit.look.panel), 16)
                gravity = Gravity.CENTER
            }
        }
        cells.forEachIndexed { i, v ->
            boxes.add(v, dp(70), dp(88))
            if (i < 5) boxes.add(kit.hspace(10))
        }
        c.add(boxes, top = 20)
        fun refresh() { cells.forEachIndexed { i, v -> v.text = if (i < code.length) code[i].toString() else "" } }

        val pad = kit.column()
        val keys = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("Back", "0", "⌫"))
        for (rowKeys in keys) {
            val r = kit.row()
            rowKeys.forEachIndexed { i, k ->
                val kind = if (k.length == 1 && k[0].isDigit()) Kit.Kind.GOLD else Kit.Kind.DARK
                r.add(kit.button(k, kind, if (k == "Back") 20f else 30f, 12, 0) {
                    when (k) {
                        "Back" -> showHome()
                        "⌫" -> { if (code.isNotEmpty()) code.deleteCharAt(code.length - 1); refresh() }
                        else -> if (code.length < 6) {
                            code.append(k); refresh()
                            if (code.length == 6) tryCode(code.toString())
                        }
                    }
                }, dp(120))
                if (i < 2) r.add(kit.hspace(12))
            }
            pad.add(r, top = 12)
        }
        c.add(pad, top = 14)
        place(c)
    }

    private fun tryCode(code: String) {
        val myJob = ++job
        showWaiting("Looking for your PC…")
        bg {
            val found = Discovery.scan(prefs)
            for (pc in found) {
                if (myJob != job) return@bg
                val (link, _) = Link.handshake(pc.host, pc.port, prefs) ?: continue
                link.send(JSONObject().put("t", "pair_code").put("code", code))
                val r = link.await(setOf("pair_match", "pair_fail"), 3000L)
                if (r != null && r.optString("t") == "pair_match") {
                    ui {
                        if (myJob != job) link.close()
                        else showConfirmPc(link, r.optString("pcId"), r.optString("pcName"), pc.host, pc.port)
                    }
                    return@bg
                }
                link.close()
            }
            ui {
                if (myJob == job) showAddPc(if (found.isEmpty())
                    "No Casnt PC found. Make sure Casnt is open on your PC and that your Quest is on the same Wi-Fi (or plugged in by USB)."
                else "That code didn't match. Check the code on your PC and try again.")
            }
        }
    }

    private fun showConfirmPc(link: Link, pcId: String, pcName: String, host: String, port: Int) {
        val c = begin("confirm")
        c.add(kit.heading("Is this PC yours?", 36f))
        c.add(kit.title(pcName, 52f), top = 18)
        val r = kit.row()
        r.add(kit.button("No", Kit.Kind.DARK, 26f) {
            link.send(JSONObject().put("t", "pair_cancel"))
            root.postDelayed({ link.close() }, 200)
            showAddPc()
        })
        r.add(kit.hspace(20))
        r.add(kit.button("Yes, it's mine", sizeSp = 26f) {
            val myJob = ++job
            showWaiting("Connecting…")
            bg {
                link.send(JSONObject().put("t", "pair_confirm"))
                val p = link.await(setOf("paired"), 5000L)
                link.close()
                ui {
                    if (myJob != job) return@ui
                    if (p == null) showAddPc("Pairing didn't finish. Try a new code.")
                    else {
                        prefs.savePc(SavedPc(p.optString("pcId", pcId), p.optString("pcName", pcName), p.getString("token"), host, port))
                        prefs.lastPcId = p.optString("pcId", pcId)
                        showHome("You're connected to $pcName!")
                    }
                }
            }
        })
        c.add(r, top = 30)
        place(c)
    }

    private fun showPcs() {
        val c = begin("pcs")
        c.add(kit.heading("My PCs", 38f))
        val pcs = prefs.pcs()
        if (pcs.isEmpty()) c.add(kit.label("No PCs yet.", 18f, kit.look.muted), top = 12)
        for (pc in pcs) {
            val card = kit.card(vertical = false, pad = 18)
            card.add(kit.label("🖥  ${pc.pcName}", 22f, kit.look.text, bold = true).apply { gravity = Gravity.START }, 0, weight = 1f)
            card.add(kit.button("Forget", Kit.Kind.DARK, 18f, 10, 22) { prefs.removePc(pc.pcId); showPcs() })
            c.add(card, dp(620), top = 14)
        }
        val r = kit.row()
        r.add(backButton())
        r.add(kit.hspace(16))
        r.add(kit.button("Add PC", sizeSp = 22f) { showAddPc() })
        c.add(r, top = 24)
        place(c)
    }

    // ------------------------------------------------------------------ settings
    private fun showSettings() {
        val c = begin("settings")
        c.add(kit.heading("Settings", 38f))
        val card = kit.card(pad = 26)

        fun settingRow(title: String, sub: String, control: View) {
            val r = kit.row()
            val texts = kit.column().apply { gravity = Gravity.START }
            texts.add(kit.label(title, 21f, kit.look.text, bold = true).apply { gravity = Gravity.START })
            texts.add(kit.label(sub, 15f, kit.look.faint).apply { gravity = Gravity.START })
            r.add(texts, 0, weight = 1f)
            r.add(control)
            card.add(r, LinearLayout.LayoutParams.MATCH_PARENT, top = 14)
        }

        val name = input(prefs.userName, "Your name").apply { minWidth = dp(260) }
        name.setOnEditorActionListener { _, _, _ ->
            name.text.toString().trim().takeIf { it.isNotEmpty() }?.let { prefs.userName = it }
            false
        }
        settingRow("Your name", "Shown in \"Welcome back\" and on your PC", name)
        settingRow("Show greeting", "\"Good evening, ${prefs.userName}\" on the home screen",
            kit.toggle(prefs.showGreeting) { prefs.showGreeting = it })
        settingRow("Cartoony gold look", "Turn off for a clean look", kit.toggle(prefs.cartoonUi) { prefs.cartoonUi = it; saveName(name); showSettings() })
        if (!prefs.cartoonUi) {
            val pick = kit.row()
            pick.add(kit.button("Dark", if (prefs.plainTheme == "dark") Kit.Kind.GOLD else Kit.Kind.DARK, 18f, 10, 22) { prefs.plainTheme = "dark"; showSettings() })
            pick.add(kit.hspace(10))
            pick.add(kit.button("Light", if (prefs.plainTheme == "light") Kit.Kind.GOLD else Kit.Kind.DARK, 18f, 10, 22) { prefs.plainTheme = "light"; showSettings() })
            settingRow("Clean look colour", "Used when the cartoony look is off", pick)
        }
        c.add(card, dp(760), top = 16)
        c.add(kit.label("Casnt ${BuildConfigLite.VERSION} · by DarkerDawnFR", 14f, kit.look.faint), top = 14)
        c.add(kit.button("Done", sizeSp = 22f) { saveName(name); showHome() }, top = 16)
        place(c)
    }

    private fun saveName(field: EditText) {
        field.text.toString().trim().takeIf { it.isNotEmpty() }?.let { prefs.userName = it }
    }

    // ------------------------------------------------------------------ TikTok LIVE
    private fun showTikTokAsk() {
        val c = begin("tiktok")
        val card = kit.card(pad = 30)
        card.add(kit.heading("Do you have TikTok LIVE Studio installed?", 28f).apply { maxWidth = dp(640) })
        card.add(kit.label("Needs a Windows 10 or 11 (64-bit) PC · a TikTok account with LIVE access · a steady upload connection (about 6 Mbps or more)",
            14f, kit.look.faint).apply { maxWidth = dp(600) }, top = 12)
        val r = kit.row()
        r.add(kit.button("Cancel", Kit.Kind.DARK, 22f) { showHome() })
        r.add(kit.hspace(18))
        r.add(kit.button("Confirm", sizeSp = 22f) { checkTikTok() })
        card.add(r, top = 22)
        c.add(card)
        place(c)
    }

    private fun checkTikTok() {
        val pcs = prefs.pcs()
        val pc = pcs.firstOrNull { it.pcId == prefs.lastPcId } ?: pcs.firstOrNull()
        if (pc == null) { showHome("Pair a PC first — TikTok LIVE Studio runs on your PC."); return }
        val myJob = ++job
        showWaiting("Checking ${pc.pcName} for TikTok LIVE Studio…")
        bg {
            val r = Connector.connect(prefs, pc)
            if (r !is Connector.Result.Ok) {
                ui { if (myJob == job) showHome("Couldn't reach ${pc.pcName}. Is Casnt running on it?") }
                return@bg
            }
            r.link.send(JSONObject().put("t", "tiktok_check"))
            val res = r.link.await(setOf("tiktok_result"), 5000L)
            r.link.close()
            ui { if (myJob == job) showTikTokResult(pc.pcName, res) }
        }
    }

    private fun showTikTokResult(pcName: String, res: JSONObject?) {
        val c = begin("tiktok")
        val card = kit.card(pad = 30)
        if (res?.optBoolean("installed") == true) {
            card.add(kit.heading("TikTok LIVE Studio found! ✅", 30f))
            card.add(kit.label("The TikTok LIVE tools arrive in the next Casnt update.", 18f, kit.look.muted), top = 10)
        } else {
            card.add(kit.heading("Not found on $pcName", 30f))
            card.add(kit.label("Install TikTok LIVE Studio on your PC from tiktok.com/studio/download, then press Confirm again.",
                17f, kit.look.muted).apply { maxWidth = dp(600) }, top = 10)
        }
        card.add(kit.button("Back", Kit.Kind.DARK, 20f, 12, 28) { showHome() }, top = 22)
        c.add(card)
        place(c)
    }

    companion object {
        private const val REQ_PROJECTION = 41
        private const val REQ_AUDIO = 42
        private const val REQ_NOTIFY = 43
    }
}

/** Version label without needing the generated BuildConfig class. */
object BuildConfigLite { const val VERSION = "0.1.0" }
