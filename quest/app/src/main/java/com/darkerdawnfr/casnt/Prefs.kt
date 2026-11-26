package com.darkerdawnfr.casnt

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A PC this Quest has paired with. */
data class SavedPc(val pcId: String, val pcName: String, val token: String, val lastHost: String, val port: Int) {
    fun toJson(): JSONObject = JSONObject()
        .put("pcId", pcId).put("pcName", pcName).put("token", token).put("lastHost", lastHost).put("port", port)

    companion object {
        fun fromJson(o: JSONObject) = SavedPc(
            o.getString("pcId"), o.getString("pcName"), o.getString("token"),
            o.optString("lastHost", ""), o.optInt("port", Proto.PORT),
        )
    }
}

/** Everything Casnt remembers on the headset. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("casnt", Context.MODE_PRIVATE)

    val deviceId: String
        get() = sp.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            sp.edit().putString("deviceId", it).apply()
        }

    /** The name shown in "Welcome back, ___" and on the PC's cast popup. */
    var userName: String
        get() = sp.getString("userName", "") ?: ""
        set(v) = sp.edit().putString("userName", v.trim().take(32)).apply()

    var showGreeting: Boolean
        get() = sp.getBoolean("showGreeting", true)
        set(v) = sp.edit().putBoolean("showGreeting", v).apply()

    var cartoonUi: Boolean
        get() = sp.getBoolean("cartoonUi", true)
        set(v) = sp.edit().putBoolean("cartoonUi", v).apply()

    /** "dark" or "light" — used when the cartoony look is off. */
    var plainTheme: String
        get() = sp.getString("plainTheme", "dark") ?: "dark"
        set(v) = sp.edit().putString("plainTheme", v).apply()

    var lastPcId: String
        get() = sp.getString("lastPcId", "") ?: ""
        set(v) = sp.edit().putString("lastPcId", v).apply()

    fun pcs(): List<SavedPc> {
        val arr = JSONArray(sp.getString("pcs", "[]"))
        return (0 until arr.length()).map { SavedPc.fromJson(arr.getJSONObject(it)) }
    }

    fun savePc(pc: SavedPc) {
        val list = pcs().filter { it.pcId != pc.pcId } + pc
        sp.edit().putString("pcs", JSONArray(list.map { it.toJson() }).toString()).apply()
    }

    fun removePc(pcId: String) {
        val list = pcs().filter { it.pcId != pcId }
        sp.edit().putString("pcs", JSONArray(list.map { it.toJson() }).toString()).apply()
        if (lastPcId == pcId) lastPcId = ""
    }
}
