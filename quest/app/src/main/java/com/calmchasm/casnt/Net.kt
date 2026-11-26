package com.calmchasm.casnt

import android.os.Build
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Casnt wire protocol — must match pc/src/protocol.js. */
object Proto {
    const val PORT = 47820
    const val DISCOVERY_PORT = 47821
    const val PROBE = "CASNT?"
    const val USB_HOST = "127.0.0.1" // PC runs `adb reverse` when the Quest is plugged in

    const val JSON = 1
    const val VCONF = 2
    const val VKEY = 3
    const val VFRAME = 4
    const val AGAME = 5
    const val AMIC = 6

    fun frame(type: Int, payload: ByteArray, len: Int = payload.size): ByteArray {
        val out = ByteArray(5 + len)
        out[0] = type.toByte()
        out[1] = (len ushr 24).toByte(); out[2] = (len ushr 16).toByte()
        out[3] = (len ushr 8).toByte(); out[4] = len.toByte()
        System.arraycopy(payload, 0, out, 5, len)
        return out
    }

    fun model(): String = when {
        Build.MODEL.contains("Quest", ignoreCase = true) && !Build.MODEL.startsWith("Meta") -> "Meta ${Build.MODEL}"
        else -> Build.MODEL
    }
}

/** One TCP link to a Casnt PC. Writes go through a queue so media never blocks the UI. */
class Link private constructor(val host: String, val port: Int, private val socket: Socket) {
    private val out = LinkedBlockingQueue<ByteArray>()
    private val inbox = LinkedBlockingQueue<JSONObject>()
    private val queuedBytes = AtomicLong(0)
    @Volatile var closed = false
        private set

    /** Messages that arrive while nobody is awaiting them (cast_stop, key_request, unpaired…). */
    @Volatile var listener: ((JSONObject) -> Unit)? = null
    @Volatile var onClosed: (() -> Unit)? = null
    /** Panels (TikTok, Cast Player) take every message through [listener]. */
    @Volatile var catchAll = false

    private fun startThreads() {
        Thread({
            try {
                val stream = BufferedOutputStream(socket.getOutputStream(), 64 * 1024)
                while (!closed) {
                    val f = out.poll(250, TimeUnit.MILLISECONDS) ?: continue
                    stream.write(f)
                    queuedBytes.addAndGet(-f.size.toLong())
                    if (out.isEmpty()) stream.flush()
                }
            } catch (_: Exception) { } finally { close() }
        }, "casnt-writer").start()

        Thread({
            try {
                val input = DataInputStream(socket.getInputStream())
                while (!closed) {
                    val type = input.readUnsignedByte()
                    val len = input.readInt()
                    if (len < 0 || len > 16 * 1024 * 1024) break
                    val buf = ByteArray(len)
                    input.readFully(buf)
                    if (type == Proto.JSON) {
                        val msg = JSONObject(String(buf, Charsets.UTF_8))
                        val l = listener
                        if (l != null && (catchAll || msg.optString("t") in ASYNC)) l(msg) else inbox.put(msg)
                    }
                }
            } catch (_: Exception) { } finally { close() }
        }, "casnt-reader").start()
    }

    fun send(msg: JSONObject) = enqueue(Proto.frame(Proto.JSON, msg.toString().toByteArray(Charsets.UTF_8)))

    /** Queue a media frame. Returns false (and drops it) when the link is backed up, unless [force]. */
    fun sendMedia(type: Int, data: ByteArray, force: Boolean = false): Boolean {
        if (!force && queuedBytes.get() > MAX_QUEUED_BYTES) return false
        enqueue(Proto.frame(type, data))
        return true
    }

    private fun enqueue(f: ByteArray) {
        if (closed) return
        queuedBytes.addAndGet(f.size.toLong())
        out.put(f)
    }

    /** Wait for the next message whose type is in [types]. Anything else goes to [listener] or is dropped. */
    fun await(types: Set<String>, timeoutMs: Long): JSONObject? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!closed || inbox.isNotEmpty()) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) return null
            val msg = inbox.poll(minOf(left, 250), TimeUnit.MILLISECONDS) ?: continue
            if (msg.optString("t") in types) return msg
            listener?.invoke(msg)
        }
        return null
    }

    fun close() {
        if (closed) return
        closed = true
        try { socket.close() } catch (_: Exception) { }
        onClosed?.invoke()
    }

    companion object {
        private const val MAX_QUEUED_BYTES = 6L * 1024 * 1024
        private val ASYNC = setOf("cast_stop", "key_request", "unpaired", "set_quality", "set_audio", "ping")

        fun open(host: String, port: Int = Proto.PORT, timeoutMs: Int = 2500): Link {
            val s = Socket()
            s.connect(InetSocketAddress(host, port), timeoutMs)
            s.tcpNoDelay = true
            s.sendBufferSize = 1024 * 1024
            return Link(host, port, s).also { it.startThreads() }
        }

        /** Open + say hello. Returns the link and the PC's hello reply. */
        fun handshake(host: String, port: Int, prefs: Prefs, timeoutMs: Int = 2500): Pair<Link, JSONObject>? = try {
            val link = open(host, port, timeoutMs)
            link.send(JSONObject().put("t", "hello").put("deviceId", prefs.deviceId)
                .put("name", prefs.userName.ifBlank { "Quest" }).put("model", Proto.model()))
            val hello = link.await(setOf("hello"), 3000L)
            if (hello == null) { link.close(); null } else link to hello
        } catch (_: Exception) { null }
    }
}

data class FoundPc(val pcId: String, val pcName: String, val host: String, val port: Int)

/** Finds Casnt PCs on the Wi-Fi (UDP broadcast) and over USB (adb reverse to 127.0.0.1). */
object Discovery {
    fun scan(prefs: Prefs, timeoutMs: Long = 1600): List<FoundPc> {
        val found = LinkedHashMap<String, FoundPc>()

        // USB first: if the PC forwarded the port, 127.0.0.1 reaches it.
        Link.handshake(Proto.USB_HOST, Proto.PORT, prefs, 600)?.let { (link, hello) ->
            found[hello.optString("pcId")] = FoundPc(hello.optString("pcId"), hello.optString("pcName"), Proto.USB_HOST, Proto.PORT)
            link.close()
        }

        try {
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 200
                val probe = Proto.PROBE.toByteArray()
                for (addr in broadcastAddresses()) {
                    try { sock.send(DatagramPacket(probe, probe.size, addr, Proto.DISCOVERY_PORT)) } catch (_: Exception) { }
                }
                val buf = ByteArray(2048)
                val deadline = System.currentTimeMillis() + timeoutMs
                while (System.currentTimeMillis() < deadline) {
                    val p = DatagramPacket(buf, buf.size)
                    try { sock.receive(p) } catch (_: SocketTimeoutException) { continue }
                    try {
                        val o = JSONObject(String(p.data, 0, p.length, Charsets.UTF_8))
                        if (o.optString("app") != "casnt") continue
                        val id = o.optString("pcId")
                        if (!found.containsKey(id)) {
                            found[id] = FoundPc(id, o.optString("pcName"), p.address.hostAddress ?: continue, o.optInt("port", Proto.PORT))
                        }
                    } catch (_: Exception) { }
                }
            }
        } catch (_: Exception) { }
        return found.values.toList()
    }

    private fun broadcastAddresses(): List<InetAddress> {
        val list = mutableListOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
        try {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) ia.broadcast?.let { list.add(it) }
            }
        } catch (_: Exception) { }
        return list.distinct()
    }
}

/** Connects to a paired PC and authenticates with its token. */
object Connector {
    sealed class Result {
        data class Ok(val link: Link, val host: String) : Result()
        object NotFound : Result()
        object Forgotten : Result() // the PC removed this Quest
    }

    fun connect(prefs: Prefs, pc: SavedPc): Result {
        val hosts = LinkedHashSet<Pair<String, Int>>()
        hosts.add(Proto.USB_HOST to Proto.PORT)
        if (pc.lastHost.isNotBlank()) hosts.add(pc.lastHost to pc.port)
        for ((host, port) in hosts) tryAuth(prefs, pc, host, port)?.let { return it }
        for (f in Discovery.scan(prefs)) {
            if (f.pcId == pc.pcId) tryAuth(prefs, pc, f.host, f.port)?.let { return it }
        }
        return Result.NotFound
    }

    private fun tryAuth(prefs: Prefs, pc: SavedPc, host: String, port: Int): Result? {
        val (link, hello) = Link.handshake(host, port, prefs, if (host == Proto.USB_HOST) 600 else 2000) ?: return null
        if (hello.optString("pcId") != pc.pcId) { link.close(); return null }
        link.send(JSONObject().put("t", "auth").put("token", pc.token))
        val r = link.await(setOf("auth_ok", "auth_fail"), 4000L) ?: run { link.close(); return null }
        return when (r.optString("t")) {
            "auth_ok" -> {
                prefs.savePc(pc.copy(pcName = r.optString("pcName", pc.pcName), lastHost = host, port = port))
                Result.Ok(link, host)
            }
            "auth_fail" -> { link.close(); Result.Forgotten }
            else -> { link.close(); null }
        }
    }
}

/** USB instant connect: if the Quest is plugged into a Casnt PC (adb reverse), pair with no code. */
object UsbConnect {
    sealed class Result {
        data class NewlyPaired(val pc: SavedPc) : Result()
        data class AlreadyPaired(val pc: SavedPc) : Result()
        object NoUsb : Result()
        object TurnedOffOnPc : Result()
    }

    fun check(prefs: Prefs): Result {
        val (link, hello) = Link.handshake(Proto.USB_HOST, Proto.PORT, prefs, 500) ?: return Result.NoUsb
        try {
            val pcId = hello.optString("pcId")
            prefs.pcs().firstOrNull { it.pcId == pcId }?.let { return Result.AlreadyPaired(it) }
            link.send(JSONObject().put("t", "usb_pair"))
            val r = link.await(setOf("paired", "pair_fail"), 3000L) ?: return Result.NoUsb
            if (r.optString("t") != "paired") return Result.TurnedOffOnPc
            val pc = SavedPc(r.optString("pcId", pcId), r.optString("pcName", hello.optString("pcName")),
                r.getString("token"), Proto.USB_HOST, Proto.PORT)
            prefs.savePc(pc)
            prefs.lastPcId = pc.pcId
            return Result.NewlyPaired(pc)
        } finally {
            link.close()
        }
    }
}

/** A live connection for a Quest panel (TikTok LIVE, Cast Player) that subscribes to PC updates. */
class Panel(private val prefs: Prefs, private val onMsg: (JSONObject) -> Unit, private val onDown: () -> Unit) {
    @Volatile var link: Link? = null
        private set

    /** Blocking: connect to [pc] and authenticate. */
    fun open(pc: SavedPc): Connector.Result {
        val r = Connector.connect(prefs, pc)
        if (r is Connector.Result.Ok) {
            r.link.catchAll = true
            r.link.listener = onMsg
            r.link.onClosed = onDown
            link = r.link
        }
        return r
    }

    fun send(o: JSONObject) { link?.send(o) }

    fun close() {
        link?.let { it.onClosed = null; it.listener = null; it.close() }
        link = null
    }
}

/** The link that's currently casting (shared between the screen and the service). */
object Session {
    @Volatile var link: Link? = null
    @Volatile var pcName: String = ""
}
