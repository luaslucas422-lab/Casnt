package com.darkerdawnfr.casnt

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
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Surface
import org.json.JSONObject

/** Cast quality presets. Stage 2 adds the picker, the Max option and a Custom mode. */
enum class Quality(val width: Int, val height: Int, val fps: Int, val bitrate: Int) {
    POTATO(854, 480, 30, 2_500_000),
    MEDIUM(1280, 720, 30, 6_000_000),
    GOOD(2560, 1440, 60, 20_000_000),
    GOOD_FALLBACK(1920, 1080, 60, 12_000_000);

    companion object {
        fun from(name: String) = when (name.lowercase()) {
            "potato" -> POTATO
            "medium" -> MEDIUM
            else -> GOOD
        }
    }
}

/** Observers for the casting screen. Always called on the main thread. */
object CastState {
    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<(Boolean, String?) -> Unit>()
    @Volatile var running = false
        private set

    fun listen(l: (Boolean, String?) -> Unit) { listeners.add(l) }
    fun unlisten(l: (Boolean, String?) -> Unit) { listeners.remove(l) }
    fun set(on: Boolean, note: String? = null) {
        running = on
        main.post { listeners.toList().forEach { it(on, note) } }
    }
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
    private var codecConfig = ByteArray(0)
    @Volatile private var running = false
    private val threads = mutableListOf<Thread>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopCast(tellPc = true, note = null); return START_NOT_STICKY }
        if (running) return START_NOT_STICKY

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        val quality = Quality.from(intent?.getStringExtra(EXTRA_QUALITY) ?: "good")
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
        }, Handler(Looper.getMainLooper()))

        link.listener = { msg ->
            when (msg.optString("t")) {
                "cast_stop" -> stopCast(tellPc = false, note = "${Session.pcName} stopped the cast")
                "key_request" -> requestKeyFrame()
            }
        }
        link.onClosed = { stopCast(tellPc = false, note = "Lost connection to ${Session.pcName}") }

        running = true
        val used = startVideo(mp, quality, link)
        if (used == null) { stopCast(tellPc = true, note = "This Quest couldn't start the video encoder"); return START_NOT_STICKY }
        startGameAudio(mp, link, micAllowed)
        if (micAllowed) startMic(link)

        link.send(JSONObject().put("t", "cast_started").put("width", used.width).put("height", used.height).put("fps", used.fps))
        CastState.set(true)
        return START_NOT_STICKY
    }

    // ---------------- video ----------------
    private fun startVideo(mp: MediaProjection, wanted: Quality, link: Link): Quality? {
        val tries = when (wanted) {
            Quality.GOOD -> listOf(Quality.GOOD, Quality.GOOD_FALLBACK, Quality.MEDIUM)
            else -> listOf(wanted, Quality.POTATO)
        }
        for (q in tries) {
            try {
                val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, q.width, q.height).apply {
                    setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                    setInteger(MediaFormat.KEY_BIT_RATE, q.bitrate)
                    setInteger(MediaFormat.KEY_FRAME_RATE, q.fps)
                    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                    setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L)
                    setInteger(MediaFormat.KEY_PRIORITY, 0) // real-time
                    if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
                try {
                    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                } catch (e: Exception) {
                    codec.release(); continue
                }
                val surface = codec.createInputSurface()
                codec.start()
                encoder = codec
                inputSurface = surface
                display = mp.createVirtualDisplay(
                    "Casnt", q.width, q.height, resources.displayMetrics.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null,
                )
                spawn("casnt-video") { drainVideo(codec, link) }
                return q
            } catch (e: Exception) {
                encoder?.let { try { it.release() } catch (_: Exception) { } }
                encoder = null
                if (display != null) return null // a projection can only make one display
            }
        }
        return null
    }

    private fun drainVideo(codec: MediaCodec, link: Link) {
        val info = MediaCodec.BufferInfo()
        var dropping = false
        while (running) {
            val idx = try { codec.dequeueOutputBuffer(info, 20_000) } catch (_: Exception) { break }
            if (idx < 0) continue
            val buf = codec.getOutputBuffer(idx)
            if (buf != null && info.size > 0) {
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
            pump("casnt-game-audio", rec, 3840, Proto.AGAME, link) // 20 ms stereo
        } catch (_: Exception) { }
    }

    private fun startMic(link: Link) {
        try {
            val min = AudioRecord.getMinBufferSize(48_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            @Suppress("MissingPermission")
            val rec = AudioRecord(MediaRecorder.AudioSource.MIC, 48_000, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(min, 1920 * 4))
            pump("casnt-mic", rec, 1920, Proto.AMIC, link) // 20 ms mono
        } catch (_: Exception) { }
    }

    private fun pump(name: String, rec: AudioRecord, chunk: Int, type: Int, link: Link) {
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return }
        spawn(name) {
            val buf = ByteArray(chunk)
            try {
                rec.startRecording()
                while (running) {
                    val n = rec.read(buf, 0, chunk)
                    if (n > 0) link.sendMedia(type, buf.copyOf(n))
                }
            } catch (_: Exception) {
            } finally {
                try { rec.stop() } catch (_: Exception) { }
                rec.release()
            }
        }
    }

    // ---------------- lifecycle ----------------
    private fun spawn(name: String, body: () -> Unit) {
        val t = Thread(body, name)
        threads.add(t)
        t.start()
    }

    @Synchronized
    private fun stopCast(tellPc: Boolean, note: String?) {
        val wasRunning = running || projection != null
        running = false
        val link = Session.link
        if (link != null) {
            link.listener = null
            link.onClosed = null
            if (tellPc && !link.closed) link.send(JSONObject().put("t", "cast_stop"))
            // give the writer a moment to flush the stop message
            Handler(Looper.getMainLooper()).postDelayed({ link.close() }, 300)
            Session.link = null
        }
        try { display?.release() } catch (_: Exception) { }
        display = null
        try { encoder?.stop() } catch (_: Exception) { }
        try { encoder?.release() } catch (_: Exception) { }
        encoder = null
        try { inputSurface?.release() } catch (_: Exception) { }
        inputSurface = null
        val mp = projection
        projection = null
        try { mp?.stop() } catch (_: Exception) { }
        threads.clear()
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
        const val EXTRA_QUALITY = "quality"
        const val ACTION_STOP = "com.darkerdawnfr.casnt.STOP"
        private const val CHANNEL = "casnt_cast"
        private const val NOTIFICATION_ID = 7
    }
}
