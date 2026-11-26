package com.calmchasm.casnt

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
    private var pendingSpec = "{}"
    private var job = 0 // bumps whenever the user leaves a waiting screen, so stale results are ignored
    private var update: Updater.Release? = null
    private var updateChecked = false
    private var updateNote = ""

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
        if (prefs.autoUpdateCheck) checkForUpdate(quiet = true)
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
        kit = Kit(this, Look(prefs.cartoonUi, prefs.plainTheme), prefs.animations, prefs.sounds)
        root.removeAllViews()
        root.setBackgroundColor(kit.look.bg)
        return kit.column()
    }

    /** Shows a screen. Normal screens shrink to fit the panel; long ones (settings) scroll. */
    private fun place(content: View, scroll: Boolean = false) {
        if (scroll) {
            val wrap = FrameLayout(this)
            wrap.setPadding(dp(40), dp(30), dp(40), dp(40))
            wrap.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
            val sv = ScrollView(this).apply { isFillViewport = true }
            sv.addView(wrap, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
            root.addView(sv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        } else {
            val fit = FitFrame(this)
            fit.addView(content)
            root.addView(fit, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        kit.popIn(content)
    }

    private fun greeting(): String {
        val h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val part = when { h < 5 -> "Good night"; h < 12 -> "Good morning"; h < 18 -> "Good afternoon"; else -> "Good evening" }
        return "$part, ${prefs.userName}"
    }

    private fun input(value: String, hint: String): EditText = EditText(this).apply {
        setText(value)
        this.hint = hint
        textSize = 24f
        setSingleLine()
        imeOptions = EditorInfo.IME_ACTION_DONE
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
        setTextColor(kit.look.text)
        setHintTextColor(kit.look.faint)
        background = kit.rounded(intArrayOf(kit.look.bg), 18)
        setPadding(dp(20), dp(14), dp(20), dp(14))
        minWidth = dp(420)
    }

    /** Row of choices; the picked one is gold. */
    private fun seg(options: List<Pair<String, String>>, current: String, size: Float = 17f, onPick: (String) -> Unit): LinearLayout {
        val r = kit.row()
        options.forEachIndexed { i, (value, label) ->
            r.add(kit.button(label, if (value == current) Kit.Kind.GOLD else Kit.Kind.DARK, size, 9, 16) { onPick(value) })
            if (i < options.size - 1) r.add(kit.hspace(8))
        }
        return r
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
        val myJob = job
        val c = begin("home")
        c.add(kit.title("Casnt", 64f))
        if (prefs.showGreeting) c.add(kit.heading(greeting(), 28f), top = 4)
        if (message != null) c.add(kit.label(message, 18f, kit.look.muted).apply { maxWidth = dp(640) }, top = 12)

        c.add(kit.button("CAST TO PC", sizeSp = 42f, padV = 30, padH = 90) { onCastPressed() }, top = 26)

        val pcs = prefs.pcs()
        val last = pcs.firstOrNull { it.pcId == prefs.lastPcId } ?: pcs.firstOrNull()
        c.add(kit.label(if (last == null) "No PC paired yet. Tap Cast to PC, or plug into your PC by USB." else "Casting to ${last.pcName}",
            16f, kit.look.faint), top = 12)

        // TikTok LIVE sits right under the home controls.
        c.add(kit.button("●  TikTok LIVE", Kit.Kind.PINK, 24f, 14, 40) { showTikTokAsk() }, top = 22)

        val r = kit.row()
        r.add(kit.button("My PCs", Kit.Kind.DARK, 20f, 12, 28) { showPcs() })
        r.add(kit.hspace(16))
        r.add(kit.button("Settings", Kit.Kind.DARK, 20f, 12, 28) { showSettings() })
        c.add(r, top = 20)

        update?.let { rel ->
            c.add(kit.button("⬆  Update to Casnt ${rel.version}", Kit.Kind.GOLD, 18f, 10, 24) { showUpdate(rel) }, top = 16)
        }
        place(c)
        if (prefs.usbInstantConnect && message == null) watchUsb(myJob)
    }

    /** USB instant connect: if the PC is reachable over the cable and we're not paired, pair now. */
    private fun watchUsb(myJob: Int) {
        bg {
            while (myJob == job && (screen == "home" || screen == "addpc")) {
                when (val r = UsbConnect.check(prefs)) {
                    is UsbConnect.Result.NewlyPaired -> { ui { if (myJob == job) showHome("Connected to ${r.pc.pcName} over USB!") }; return@bg }
                    is UsbConnect.Result.AlreadyPaired -> return@bg
                    is UsbConnect.Result.TurnedOffOnPc -> return@bg
                    is UsbConnect.Result.NoUsb -> Unit
                }
                try { Thread.sleep(2500) } catch (_: InterruptedException) { return@bg }
            }
        }
    }

    private fun onCastPressed() {
        val pcs = prefs.pcs()
        when {
            pcs.isEmpty() -> showAddPc()
            pcs.size == 1 -> pickMode(pcs[0])
            else -> showPickPc(pcs)
        }
    }

    private fun pickMode(pc: SavedPc) {
        val d = prefs.defaultMode
        if (d == "everything" || (d == "app" && Build.VERSION.SDK_INT >= 34)) { castMode = d; startCastRequest(pc) }
        else showCastMode(pc)
    }

    private fun showPickPc(pcs: List<SavedPc>) {
        val c = begin("pick")
        c.add(kit.heading("Which PC?", 36f))
        for (pc in pcs) c.add(kit.button(pc.pcName, Kit.Kind.DARK, 24f) { pickMode(pc) }, LinearLayout.LayoutParams.MATCH_PARENT, top = 14)
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
        r.add(option("Everything", "Everything you see, including your Meta menus.", castMode == "everything", true) {
            castMode = "everything"; showCastMode(pc)
        }, dp(330))
        r.add(kit.hspace(22))
        r.add(option("Just an app", if (appShareOk) "Pick one app or game. Your Meta menus stay hidden."
            else "Needs a newer Horizon OS update on this Quest.", castMode == "app", appShareOk) {
            castMode = "app"; showCastMode(pc)
        }, dp(330))
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
                    if (myJob == job) showHome("${pc.pcName} forgot this Quest. Pair it again.")
                }
                is Connector.Result.Ok -> {
                    val link = r.link
                    if (myJob != job) { link.close(); return@bg }
                    Session.link = link
                    Session.pcName = pc.pcName
                    prefs.lastPcId = pc.pcId
                    ui { status.text = "Waiting for ${pc.pcName} to accept…" }
                    link.send(JSONObject().put("t", "cast_request").put("mode", castMode).put("quality", prefs.startQuality))
                    val answer = link.await(setOf("cast_accept", "cast_decline"), 125_000L)
                    ui {
                        if (myJob != job) { link.close(); return@ui }
                        when (answer?.optString("t")) {
                            "cast_accept" -> launchProjection(answer?.optJSONObject("spec") ?: Spec.GOOD.toJson())
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

    private fun launchProjection(spec: JSONObject) {
        pendingSpec = spec.toString()
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
            CastState.game = prefs.gameOnStart
            CastState.mic = prefs.micOnStart
            CastState.mode = castMode
            val svc = Intent(this, CastService::class.java)
                .putExtra(CastService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(CastService.EXTRA_RESULT_DATA, data)
                .putExtra(CastService.EXTRA_SPEC, pendingSpec)
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
        val top = kit.row()
        val dot = kit.label("●", 40f, 0xFF7DFF6A.toInt())
        kit.pulse(dot)
        top.add(dot)
        top.add(kit.hspace(12))
        top.add(kit.heading("Casting to ${Session.pcName}", 32f))
        c.add(top)
        val spec = CastState.spec
        c.add(kit.label((if (CastState.mode == "app") "Sharing just the app you picked" else "Sharing everything you see") +
            (spec?.let { " · ${it.label()}" } ?: ""), 17f, kit.look.muted), top = 6)

        // quality settings while casting
        val q = kit.card(pad = 20)
        q.add(kit.label("Quality", 20f, kit.look.text, bold = true))
        q.add(seg(listOf("potato" to "Potato", "medium" to "Medium", "good" to "Good", "max" to "Max"), spec?.preset ?: "good", 19f) {
            CastService.current?.setQuality(Spec.preset(it))
        }, top = 10)
        q.add(kit.label("Better quality = more battery. Max uses everything the Quest can do.", 14f, kit.look.faint), top = 8)
        c.add(q, top = 16)

        // audio on/off
        val a = kit.row()
        a.add(kit.button(if (CastState.game) "🎮 Game audio: ON" else "🎮 Game audio: OFF",
            if (CastState.game) Kit.Kind.GOLD else Kit.Kind.DARK, 19f, 12, 22) {
            CastService.current?.setAudio(!CastState.game, CastState.mic)
        })
        a.add(kit.hspace(14))
        a.add(kit.button(if (CastState.mic) "🎙️ Mic: ON" else "🎙️ Mic: OFF",
            if (CastState.mic) Kit.Kind.GOLD else Kit.Kind.DARK, 19f, 12, 22) {
            CastService.current?.setAudio(CastState.game, !CastState.mic)
        })
        c.add(a, top = 16)

        c.add(kit.button("STOP CASTING", Kit.Kind.RED, 28f, 18, 54) {
            startService(Intent(this, CastService::class.java).setAction(CastService.ACTION_STOP))
        }, top = 20)
        place(c)
    }

    // ------------------------------------------------------------------ pairing
    private fun showAddPc(error: String? = null) {
        job++
        val myJob = job
        val c = begin("addpc")
        val two = kit.row()

        // left: instructions + code boxes
        val left = kit.column()
        left.add(kit.heading("Add a PC", 38f))
        left.add(kit.label("Type the 6-digit code shown in Casnt on your PC.", 18f, kit.look.muted).apply { maxWidth = dp(470) }, top = 6)
        if (prefs.usbInstantConnect) left.add(kit.label("Or plug your Quest into the PC with USB to skip the code.", 15f, kit.look.faint).apply { maxWidth = dp(470) }, top = 6)
        if (error != null) left.add(kit.label(error, 16f, 0xFFFF8A7A.toInt()).apply { maxWidth = dp(470) }, top = 10)
        val code = StringBuilder()
        val boxes = kit.row()
        val cells = (0 until 6).map {
            kit.label("", 36f, if (kit.look.cartoon) 0xFF000000.toInt() else kit.look.text, bold = true).apply {
                background = kit.rounded(if (kit.look.cartoon) kit.look.gold else intArrayOf(kit.look.panel), 16)
                gravity = Gravity.CENTER
            }
        }
        cells.forEachIndexed { i, v ->
            boxes.add(v, dp(62), dp(80))
            if (i < 5) boxes.add(kit.hspace(8))
        }
        left.add(boxes, top = 18)
        fun refresh() { cells.forEachIndexed { i, v -> v.text = if (i < code.length) code[i].toString() else "" } }
        two.add(left)
        two.add(kit.hspace(36))

        // right: number pad
        val pad = kit.column()
        val keys = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("Back", "0", "⌫"))
        keys.forEachIndexed { ri, rowKeys ->
            val r = kit.row()
            rowKeys.forEachIndexed { i, k ->
                val kind = if (k.length == 1 && k[0].isDigit()) Kit.Kind.GOLD else Kit.Kind.DARK
                r.add(kit.button(k, kind, if (k == "Back") 19f else 28f, 10, 0) {
                    when (k) {
                        "Back" -> showHome()
                        "⌫" -> { if (code.isNotEmpty()) code.deleteCharAt(code.length - 1); refresh() }
                        else -> if (code.length < 6) {
                            code.append(k); refresh()
                            if (code.length == 6) tryCode(code.toString())
                        }
                    }
                }, dp(104))
                if (i < 2) r.add(kit.hspace(10))
            }
            pad.add(r, top = if (ri == 0) 0 else 10)
        }
        two.add(pad)
        c.add(two)
        place(c)
        if (prefs.usbInstantConnect) watchUsb(myJob)
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
                    "No Casnt PC found. Make sure Casnt is open on your PC and your Quest is on the same Wi-Fi (or plugged in by USB)."
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
        c.add(kit.heading("Settings", 40f))
        val name = input(prefs.userName, "Your name").apply { minWidth = dp(280) }
        fun saveName() { name.text.toString().trim().takeIf { it.isNotEmpty() }?.let { prefs.userName = it } }
        name.setOnEditorActionListener { _, _, _ -> saveName(); false }
        fun reopen() { saveName(); showSettings() }

        fun section(title: String, experimental: Boolean = false): LinearLayout {
            val card = kit.card(pad = 24)
            val h = kit.row()
            h.add(kit.heading(title, 26f))
            if (experimental) {
                h.add(kit.hspace(10))
                h.add(kit.label(" EXPERIMENTAL ", 12f, 0xFFFFFFFF.toInt(), bold = true).apply { background = kit.rounded(kit.look.pink, 10, 2) })
            }
            card.add(h)
            c.add(card, dp(820), top = 18)
            return card
        }
        fun rowIn(card: LinearLayout, title: String, sub: String, control: View) {
            val r = kit.row()
            val texts = kit.column().apply { gravity = Gravity.START }
            texts.add(kit.label(title, 20f, kit.look.text, bold = true).apply { gravity = Gravity.START })
            if (sub.isNotEmpty()) texts.add(kit.label(sub, 14f, kit.look.faint).apply { gravity = Gravity.START })
            r.add(texts, 0, weight = 1f)
            r.add(control)
            card.add(r, LinearLayout.LayoutParams.MATCH_PARENT, top = 14)
        }

        val you = section("You")
        rowIn(you, "Your name", "Shown in \"Welcome back\" and on your PC", name)
        rowIn(you, "Show greeting", "\"${greeting()}\" on the home screen", kit.toggle(prefs.showGreeting) { prefs.showGreeting = it })

        val look = section("Look")
        rowIn(look, "Cartoony gold look", "Turn off for a clean look", kit.toggle(prefs.cartoonUi) { prefs.cartoonUi = it; reopen() })
        if (!prefs.cartoonUi) rowIn(look, "Clean look colour", "", seg(listOf("dark" to "Dark", "light" to "Light"), prefs.plainTheme) { prefs.plainTheme = it; reopen() })
        rowIn(look, "Animations", "Bouncy buttons and pop-ins", kit.toggle(prefs.animations) { prefs.animations = it; reopen() })
        rowIn(look, "Sound effects", "Little blips on buttons", kit.toggle(prefs.sounds) { prefs.sounds = it; reopen() })

        val cast = section("Casting")
        rowIn(cast, "What Cast to PC shares", "Ask = choose every time", seg(listOf("ask" to "Ask", "everything" to "Everything", "app" to "Just an app"), prefs.defaultMode) { prefs.defaultMode = it; reopen() })
        rowIn(cast, "Start quality", "PC = use the quality set on your PC", seg(listOf("pc" to "PC", "potato" to "Potato", "medium" to "Medium", "good" to "Good", "max" to "Max"), prefs.startQuality, 15f) { prefs.startQuality = it; reopen() })
        rowIn(cast, "Game audio at start", "Send game sound to the PC", kit.toggle(prefs.gameOnStart) { prefs.gameOnStart = it })
        rowIn(cast, "Mic at start", "Send your Quest mic to the PC", kit.toggle(prefs.micOnStart) { prefs.micOnStart = it })

        val conn = section("Connecting")
        rowIn(conn, "USB instant connect", "Plugged into your PC by USB? Skip the code.", kit.toggle(prefs.usbInstantConnect) { prefs.usbInstantConnect = it })
        rowIn(conn, "My PCs", "${prefs.pcs().size} paired", kit.button("Open", Kit.Kind.DARK, 17f, 9, 20) { saveName(); showPcs() })

        val upd = section("Updates")
        rowIn(upd, "Check for updates automatically", "Looks on the Casnt GitHub releases when Casnt opens", kit.toggle(prefs.autoUpdateCheck) { prefs.autoUpdateCheck = it })
        val ver = Updater.currentVersion(this)
        rowIn(upd, "Casnt $ver", updateNote.ifEmpty { "Tap to look for a newer version" },
            kit.button("Check now", Kit.Kind.GOLD, 17f, 9, 20) { saveName(); checkForUpdate(quiet = false) })

        val exp = section("Experimental", experimental = true)
        exp.add(kit.label("Camera view (first / third person)", 20f, kit.look.text, bold = true).apply { gravity = Gravity.START },
            LinearLayout.LayoutParams.MATCH_PARENT, top = 14)
        exp.add(kit.label("Casnt can only cast what the game draws, so it can't put the camera behind you in other games. " +
            "Third person only works in games or mods with their own spectator camera. More experimental options will show up here.",
            14f, kit.look.faint).apply { gravity = Gravity.START }, LinearLayout.LayoutParams.MATCH_PARENT, top = 4)

        c.add(kit.label("Casnt $ver · by calm.chasm", 14f, kit.look.faint), top = 16)
        c.add(kit.button("Done", sizeSp = 22f) { saveName(); showHome() }, top = 14)
        place(c, scroll = true)
    }

    // ------------------------------------------------------------------ updates
    private fun checkForUpdate(quiet: Boolean) {
        if (!quiet) { updateNote = "Checking…"; showSettings() }
        bg {
            val rel = Updater.latest()
            val cur = Updater.currentVersion(this)
            ui {
                updateChecked = true
                update = if (rel != null && Updater.isNewer(rel.version, cur)) rel else null
                updateNote = when {
                    rel == null -> "Couldn't reach GitHub. Check the Quest's Wi-Fi."
                    update != null -> "Casnt ${rel?.version} is out!"
                    else -> "You're on the newest version."
                }
                if (!quiet) { val u = update; if (u != null) showUpdate(u) else if (screen == "settings") showSettings() }
                else if (update != null && screen == "home") showHome()
            }
        }
    }

    private fun showUpdate(rel: Updater.Release) {
        val c = begin("update")
        c.add(kit.title("Casnt ${rel.version}", 48f))
        c.add(kit.label("A new Casnt is out. You have ${Updater.currentVersion(this)}.", 18f, kit.look.muted), top = 8)
        val status = kit.label("", 18f, kit.look.text, bold = true)
        c.add(status, top = 14)
        val r = kit.row()
        r.add(backButton())
        r.add(kit.hspace(16))
        r.add(kit.button("Download & install", sizeSp = 22f) {
            status.text = "Downloading… 0%"
            UpdateState.onFail = { msg -> ui { status.text = "Install failed: $msg\nYou can also update from your PC: Settings → Updates → Update Quest (USB)." } }
            bg {
                val file = Updater.download(this, rel) { p -> ui { status.text = "Downloading… $p%" } }
                ui {
                    if (file == null) status.text = "Download failed. Check the Quest's Wi-Fi and try again."
                    else if (!Updater.install(this, file)) status.text = "Allow Casnt to install apps (the settings page just opened), then tap Download & install again."
                    else status.text = "Confirm the install on the popup."
                }
            }
        })
        c.add(r, top = 20)
        c.add(kit.label("Tip: with the Quest plugged in, Casnt on your PC can also update it (Settings → Updates).", 14f, kit.look.faint), top = 14)
        place(c)
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
        if (pc == null) { showHome("Pair a PC first. TikTok LIVE Studio runs on your PC."); return }
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
