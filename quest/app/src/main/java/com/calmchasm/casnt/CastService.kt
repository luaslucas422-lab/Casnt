package com.calmchasm.casnt

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Surface
import org.json.JSONObject

/** What the encoder is asked to make. Comes from the PC (or the Quest's own quality buttons). */
data class Spec(val preset: String, val width: Int, val height: Int, val fps: Int, val bitrate: Int) {
    fun toJson(): JSONObject = JSONObject().put("preset", preset).put("width", width).put("height", height)
        .put("fps", fps).put("bitrate", bitrate)

    fun label() = "${height}p · $fps fps"

    companion object {
        val POTATO = Spec("potato", 854, 480, 30, 2_500_000)
        val MEDIUM = Spec("medium", 1280, 720, 60, 8_000_000)
        val GOOD = Spec("good", 2560, 1440, 60, 20_000_000)
        val MAX = Spec("max", 3840, 2160, 72, 50_000_000)

        fun preset(name: String) = when (name) { "potato" -> POTATO; "medium" -> MEDIUM; "max" -> MAX; else -> GOOD }

        fun fromJson(o: JSONObject?, fallback: Spec = GOOD): Spec {
            if (o == null) return fallback
            val w = o.optInt("width", fallback.width).coerceIn(320, 3840)
            val h = o.optInt("height", fallback.height).coerceIn(240, 2160)
            return Spec(o.optString("preset", fallback.preset), w - w % 2, h - h % 2,
                o.optInt("fps", fallback.fps).coerceIn(15, 120), o.optInt("bitrate", fallback.bitrate).coerceIn(500_000, 100_000_000))
        }

        /** If the encoder can't do [s], step down through these. */
        fun fallbacks(s: Spec): List<Spec> = (listOf(s) + listOf(
            Spec(s.preset, 2560, 1440, minOf(s.fps, 60), minOf(s.bitrate, 20_000_000)),
            Spec(s.preset, 1920, 1080, minOf(s.fps, 60), minOf(s.bitrate, 12_000_000)),
            Spec(s.preset, 1280, 720, minOf(s.fps, 60), minOf(s.bitrate, 8_000_000)),
            Spec(s.preset, 854, 480, 30, 2_500_000),
        ).filter { it.height < s.height || (it.height == s.height && it.fps < s.fps) }).distinct()
    }
}

/** Observers for the casting screen. Always called on the main thread. */
object CastState {
    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<(Boolean, String?) -> Unit>()
    @Volatile var running = false
        private set
    @Volatile var spec: Spec? = null
    @Volatile var game = true
    @Volatile var mic = true
    @Volatile var mode = "everything"

    fun listen(l: (Boolean, String?) -> Unit) { listeners.add(l) }
    fun unlisten(l: (Boolean, String?) -> Unit) { listeners.remove(l) }
    fun set(on: Boolean, note: String? = null) {
        running = on
        main.post { listeners.toList().forEach { it(on, note) } }
    }
    /** Something changed mid-cast (quality / audio): refresh the casting screen. */
    fun changed() = set(running, null)
}

/**
 * Foreground service that captures the Quest view with MediaProjection, encodes H.264 and
 * streams it (plus game audio and the mic) to the PC over the Session link.
 */
class CastService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var encoder: MediaCodec? = null
    private var inputSurface: Surface? = null
    @Volatile private var codecConfig = ByteArray(0)
    @Volatile private var running = false
    @Volatile private var generation = 0
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopCast(tellPc = true, note = null); return START_NOT_STICKY }
        if (running) return START_NOT_STICKY

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        val wanted = try { Spec.fromJson(JSONObject(intent?.getStringExtra(EXTRA_SPEC) ?: "{}")) } catch (_: Exception) { Spec.GOOD }
        val link = Session.link
        if (data == null || link == null || link.closed) { stopSelf(); return START_NOT_STICKY }

        val micAllowed = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        startInForeground(micAllowed)

        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = try { mpm.getMediaProjection(resultCode, data) } catch (e: Exception) { null }
        if (mp == null) { stopCast(tellPc = true, note = "Couldn't start the capture"); return START_NOT_STICKY }
        projection = mp
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { stopCast(tellPc = true, note = null) }
        }, main)

        link.listener = { msg ->
            when (msg.optString("t")) {
                "cast_stop" -> stopCast(tellPc = false, note = "${Session.pcName} stopped the cast")
                "key_request" -> requestKeyFrame()
                "ping" -> link.send(JSONObject().put("t", "pong").put("ts", msg.opt("ts")))
                "set_quality" -> main.post { setQuality(Spec.fromJson(msg.optJSONObject("spec"))) }
                "set_audio" -> setAudio(msg.optBoolean("game", CastState.game), msg.optBoolean("mic", CastState.mic))
            }
        }
        link.onClosed = { stopCast(tellPc = false, note = "Lost connection to ${Session.pcName}") }

        running = true
        current = this
        val used = startVideo(mp, wanted, link)
        if (used == null) { stopCast(tellPc = true, note = "This Quest couldn't start the video encoder"); return START_NOT_STICKY }
        startGameAudio(mp, link, micAllowed)
        if (micAllowed) startMic(link)
        startStatus(link)

        link.send(JSONObject().put("t", "cast_started").put("width", used.width).put("height", used.height).put("fps", used.fps))
        CastState.set(true)
        return START_NOT_STICKY
    }

    // ---------------- video ----------------
    private fun configure(s: Spec): Pair<MediaCodec, Surface>? {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, s.width, s.height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, s.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, s.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L)
            setInteger(MediaFormat.KEY_PRIORITY, 0) // real-time
            if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        }
        val codec = try { MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC) } catch (_: Exception) { return null }
        return try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val surface = codec.createInputSurface()
            codec.start()
            codec to surface
        } catch (_: Exception) {
            try { codec.release() } catch (_: Exception) { }
            null
        }
    }

    private fun startVideo(mp: MediaProjection, wanted: Spec, link: Link): Spec? {
        for (s in Spec.fallbacks(wanted)) {
            val (codec, surface) = configure(s) ?: continue
            encoder = codec
            inputSurface = surface
            display = try {
                mp.createVirtualDisplay("Casnt", s.width, s.height, resources.displayMetrics.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null)
            } catch (_: Exception) { null }
            if (display == null) { releaseEncoder(); return null }
            val gen = ++generation
            Thread({ drainVideo(codec, link, gen) }, "casnt-video").start()
            CastState.spec = s
            return s
        }
        return null
    }

    /** Switch quality mid-cast: new encoder, same capture (a projection only allows one display). */
    fun setQuality(wanted: Spec) {
        val vd = display ?: return
        val link = Session.link ?: return
        if (!running) return
        for (s in Spec.fallbacks(wanted)) {
            val (codec, surface) = configure(s) ?: continue
            val oldCodec = encoder
            val oldSurface = inputSurface
            val gen = ++generation // stops the old drain loop
            vd.resize(s.width, s.height, resources.displayMetrics.densityDpi)
            vd.surface = surface
            encoder = codec
            inputSurface = surface
            codecConfig = ByteArray(0)
            Thread({ drainVideo(codec, link, gen) }, "casnt-video").start()
            Thread({
                Thread.sleep(150)
                try { oldCodec?.stop() } catch (_: Exception) { }
                try { oldCodec?.release() } catch (_: Exception) { }
                try { oldSurface?.release() } catch (_: Exception) { }
            }, "casnt-old-encoder").start()
            CastState.spec = s
            sendStatus(link)
            CastState.changed()
            return
        }
    }

    fun setAudio(game: Boolean, mic: Boolean) {
        CastState.game = game
        CastState.mic = mic
        Session.link?.let { sendStatus(it) }
        CastState.changed()
    }

    private fun drainVideo(codec: MediaCodec, link: Link, gen: Int) {
        val info = MediaCodec.BufferInfo()
        var dropping = false
        while (running && gen == generation) {
            val idx = try { codec.dequeueOutputBuffer(info, 20_000) } catch (_: Exception) { break }
            if (idx < 0) continue
            val buf = try { codec.getOutputBuffer(idx) } catch (_: Exception) { null }
            if (buf != null && info.size > 0 && gen == generation) {
                val bytes = ByteArray(info.size)
                buf.position(info.offset); buf.get(bytes, 0, info.size)
                when {
                    info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> {
                        codecConfig = bytes
                        link.sendMedia(Proto.VCONF, bytes, force = true)
                    }
                    info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> {
                        link.sendMedia(Proto.VKEY, withPts(info.presentationTimeUs, codecConfig, bytes), force = true)
                        dropping = false
                    }
                    !dropping -> {
                        if (!link.sendMedia(Proto.VFRAME, withPts(info.presentationTimeUs, ByteArray(0), bytes))) {
                            dropping = true // Wi-Fi is behind: skip to the next key frame
                            requestKeyFrame()
                        }
                    }
                }
            }
            try { codec.releaseOutputBuffer(idx, false) } catch (_: Exception) { break }
        }
    }

    private fun withPts(pts: Long, prefix: ByteArray, data: ByteArray): ByteArray {
        val out = ByteArray(8 + prefix.size + data.size)
        for (i in 0 until 8) out[i] = (pts ushr (56 - 8 * i)).toByte()
        System.arraycopy(prefix, 0, out, 8, prefix.size)
        System.arraycopy(data, 0, out, 8 + prefix.size, data.size)
        return out
    }

    private fun requestKeyFrame() {
        try { encoder?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) } catch (_: Exception) { }
    }

    // ---------------- audio ----------------
    private fun startGameAudio(mp: MediaProjection, link: Link, allowed: Boolean) {
        if (!allowed) return // AudioPlaybackCapture also needs RECORD_AUDIO
        try {
            val config = AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48_000)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build()
            val min = AudioRecord.getMinBufferSize(48_000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
            @Suppress("MissingPermission")
            val rec = AudioRecord.Builder().setAudioFormat(format)
                .setBufferSizeInBytes(maxOf(min, 3840 * 4)).setAudioPlaybackCaptureConfig(config).build()
            pump("casnt-game-audio", rec, 3840, Proto.AGAME, link) { CastState.game } // 20 ms stereo
        } catch (_: Exception) { }
    }

    private fun startMic(link: Link) {
        try {
            val min = AudioRecord.getMinBufferSize(48_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            @Suppress("MissingPermission")
            val rec = AudioRecord(MediaRecorder.AudioSource.MIC, 48_000, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(min, 1920 * 4))
            pump("casnt-mic", rec, 1920, Proto.AMIC, link) { CastState.mic } // 20 ms mono
        } catch (_: Exception) { }
    }

    private fun pump(name: String, rec: AudioRecord, chunk: Int, type: Int, link: Link, enabled: () -> Boolean) {
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return }
        Thread({
            val buf = ByteArray(chunk)
            try {
                rec.startRecording()
                while (running) {
                    val n = rec.read(buf, 0, chunk)
                    if (n > 0 && enabled()) link.sendMedia(type, buf.copyOf(n))
                }
            } catch (_: Exception) {
            } finally {
                try { rec.stop() } catch (_: Exception) { }
                rec.release()
            }
        }, name).start()
    }

    // ---------------- status (battery etc.) ----------------
    private fun sendStatus(link: Link) {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = try { bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) } catch (_: Exception) { -1 }
        val plugged = try { bm.isCharging } catch (_: Exception) { false }
        val msg = JSONObject().put("t", "status").put("battery", level).put("charging", plugged)
            .put("game", CastState.game).put("mic", CastState.mic)
        CastState.spec?.let { msg.put("spec", it.toJson()) }
        link.send(msg)
    }

    private fun startStatus(link: Link) {
        Thread({
            while (running && !link.closed) {
                try { sendStatus(link) } catch (_: Exception) { }
                try { Thread.sleep(5000) } catch (_: InterruptedException) { break }
            }
        }, "casnt-status").start()
    }

    // ---------------- lifecycle ----------------
    private fun releaseEncoder() {
        try { encoder?.stop() } catch (_: Exception) { }
        try { encoder?.release() } catch (_: Exception) { }
        encoder = null
        try { inputSurface?.release() } catch (_: Exception) { }
        inputSurface = null
    }

    @Synchronized
    private fun stopCast(tellPc: Boolean, note: String?) {
        val wasRunning = running || projection != null
        running = false
        generation++
        if (current === this) current = null
        val link = Session.link
        if (link != null) {
            link.listener = null
            link.onClosed = null
            if (tellPc && !link.closed) link.send(JSONObject().put("t", "cast_stop"))
            main.postDelayed({ link.close() }, 300) // let the stop message go out first
            Session.link = null
        }
        try { display?.release() } catch (_: Exception) { }
        display = null
        releaseEncoder()
        val mp = projection
        projection = null
        try { mp?.stop() } catch (_: Exception) { }
        if (wasRunning) CastState.set(false, note)
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        if (running) stopCast(tellPc = true, note = null)
        super.onDestroy()
    }

    private fun startInForeground(withMic: Boolean) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Casting", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 1, Intent(this, CastService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Casnt")
            .setContentText("Casting to ${Session.pcName}")
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Stop", stop).build())
            .setOngoing(true)
            .build()
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (withMic && Build.VERSION.SDK_INT >= 30) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        startForeground(NOTIFICATION_ID, n, types)
    }

    companion object {
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_SPEC = "spec"
        const val ACTION_STOP = "com.calmchasm.casnt.STOP"
        private const val CHANNEL = "casnt_cast"
        private const val NOTIFICATION_ID = 7

        /** The running cast (for the casting screen's quality/audio buttons). */
        @Volatile var current: CastService? = null
    }
}
