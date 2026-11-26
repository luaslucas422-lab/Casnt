package com.calmchasm.casnt

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** Colours + look. Cartoony gold with thick black outlines, or a clean dark/light look. */
class Look(val cartoon: Boolean, plainTheme: String) {
    private val light = !cartoon && plainTheme == "light"
    val bg = when { cartoon -> 0xFF1B1408.toInt(); light -> 0xFFF4F5F7.toInt(); else -> 0xFF121317.toInt() }
    val panel = when { cartoon -> 0xFF3A2A0E.toInt(); light -> Color.WHITE; else -> 0xFF22252B.toInt() }
    val text = when { cartoon -> 0xFFFFF7DC.toInt(); light -> 0xFF1B1D21.toInt(); else -> 0xFFECEDF0.toInt() }
    val muted = when { cartoon -> 0xFFD7C48F.toInt(); light -> 0xFF636A75.toInt(); else -> 0xFF9AA0AA.toInt() }
    val faint = when { cartoon -> 0xFFA99868.toInt(); light -> 0xFF8A919C.toInt(); else -> 0xFF7A808A.toInt() }
    val ink = when { cartoon -> Color.BLACK; light -> 0xFFD0D4DA.toInt(); else -> 0xFF3B3E45.toInt() }
    val gold = intArrayOf(0xFFFFE27A.toInt(), 0xFFF5B82E.toInt(), 0xFFD98E10.toInt())
    val darkBtn = when { cartoon -> intArrayOf(0xFF6A5220.toInt(), 0xFF5A4518.toInt()); light -> intArrayOf(0xFFE9ECF0.toInt(), 0xFFE1E5EA.toInt()); else -> intArrayOf(0xFF2E3138.toInt(), 0xFF2A2D33.toInt()) }
    val red = intArrayOf(0xFFFF8A7A.toInt(), 0xFFE0442E.toInt())
    val pink = intArrayOf(0xFFFF5C86.toInt(), 0xFFE0234F.toInt())
    val stroke = if (cartoon) 4 else 1
    val shadow = if (cartoon) 6 else 0
    val title: Typeface = Typeface.create("sans-serif-black", Typeface.BOLD)
    val body: Typeface = Typeface.create("sans-serif", Typeface.NORMAL)
}

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
fun Context.dpf(v: Float): Float = v * resources.displayMetrics.density

/** TextView that draws a thick outline behind the text (for the gold title look). */
class OutlineText(ctx: Context, private val outline: Int, private val outlineWidth: Float) : TextView(ctx) {
    private var drawing = false

    // setTextColor() inside onDraw would normally trigger another redraw; skip that while drawing.
    override fun invalidate() { if (!drawing) super.invalidate() }

    override fun onDraw(canvas: Canvas) {
        if (outlineWidth <= 0f) { super.onDraw(canvas); return }
        drawing = true
        val colors = textColors
        paint.style = Paint.Style.STROKE
        paint.strokeJoin = Paint.Join.ROUND
        paint.strokeWidth = outlineWidth
        setTextColor(outline)
        super.onDraw(canvas)
        paint.style = Paint.Style.FILL
        setTextColor(colors)
        super.onDraw(canvas)
        drawing = false
    }
}

class Kit(private val ctx: Context, val look: Look, val animations: Boolean = true, val sounds: Boolean = true) {

    fun rounded(colors: IntArray, radius: Int, strokeW: Int = look.stroke): GradientDrawable =
        GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, if (colors.size == 1) intArrayOf(colors[0], colors[0]) else colors).apply {
            cornerRadius = ctx.dpf(radius.toFloat())
            if (strokeW > 0) setStroke(ctx.dp(strokeW), look.ink)
        }

    /** Cartoony button background: black drop "shadow" + coloured face that sinks when pressed. */
    private fun buttonBg(colors: IntArray, radius: Int): Drawable {
        val s = ctx.dp(look.shadow)
        if (s == 0) return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), rounded(colors.reversedArray(), radius))
            addState(intArrayOf(), rounded(colors, radius))
        }
        fun layered(pressed: Boolean): Drawable {
            val shadow = rounded(intArrayOf(Color.BLACK), radius, 0)
            val face = rounded(colors, radius)
            return LayerDrawable(arrayOf<Drawable>(shadow, face)).apply {
                setLayerInset(0, 0, s, 0, 0)
                if (pressed) setLayerInset(1, 0, s, 0, 0) else setLayerInset(1, 0, 0, 0, s)
            }
        }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), layered(true))
            addState(intArrayOf(), layered(false))
        }
    }

    fun title(text: String, sizeSp: Float = 56f): OutlineText =
        OutlineText(ctx, look.ink, if (look.cartoon) ctx.dpf(9f) else 0f).apply {
            this.text = text
            textSize = sizeSp
            typeface = look.title
            setTextColor(if (look.cartoon) look.gold[1] else look.text)
            gravity = Gravity.CENTER
            letterSpacing = 0.03f
        }

    fun heading(text: String, sizeSp: Float = 30f): OutlineText =
        OutlineText(ctx, look.ink, if (look.cartoon) ctx.dpf(6f) else 0f).apply {
            this.text = text
            textSize = sizeSp
            typeface = look.title
            setTextColor(if (look.cartoon) look.gold[0] else look.text)
            gravity = Gravity.CENTER
        }

    fun label(text: String, sizeSp: Float = 20f, color: Int = look.text, bold: Boolean = false): TextView =
        TextView(ctx).apply {
            this.text = text
            textSize = sizeSp
            setTextColor(color)
            typeface = if (bold) Typeface.create("sans-serif", Typeface.BOLD) else look.body
            gravity = Gravity.CENTER
            setLineSpacing(0f, 1.15f)
        }

    enum class Kind { GOLD, DARK, RED, PINK }

    fun button(text: String, kind: Kind = Kind.GOLD, sizeSp: Float = 24f, padV: Int = 16, padH: Int = 34, onClick: () -> Unit): TextView =
        TextView(ctx).apply {
            this.text = text
            textSize = sizeSp
            typeface = look.title
            gravity = Gravity.CENTER
            val colors = when (kind) { Kind.GOLD -> look.gold; Kind.DARK -> look.darkBtn; Kind.RED -> look.red; Kind.PINK -> look.pink }
            setTextColor(when (kind) { Kind.GOLD -> if (look.cartoon) Color.BLACK else 0xFF1B1408.toInt(); Kind.DARK -> look.text; else -> Color.WHITE })
            background = buttonBg(colors, 26)
            val s = ctx.dp(look.shadow)
            setPadding(ctx.dp(padH), ctx.dp(padV), ctx.dp(padH), ctx.dp(padV) + s)
            isClickable = true
            isFocusable = true
            setOnClickListener { bounce(this); if (sounds) Sfx.blip(); onClick() }
        }

    fun card(vertical: Boolean = true, pad: Int = 28): LinearLayout = LinearLayout(ctx).apply {
        orientation = if (vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        background = if (look.shadow > 0) LayerDrawable(arrayOf<Drawable>(rounded(intArrayOf(Color.BLACK), 30, 0), rounded(intArrayOf(look.panel), 30))).apply {
            setLayerInset(0, 0, ctx.dp(look.shadow), 0, 0); setLayerInset(1, 0, 0, 0, ctx.dp(look.shadow))
        } else rounded(intArrayOf(look.panel), 18)
        setPadding(ctx.dp(pad), ctx.dp(pad), ctx.dp(pad), ctx.dp(pad) + ctx.dp(look.shadow))
    }

    fun column(): LinearLayout = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
    fun row(): LinearLayout = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }

    fun space(h: Int): View = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(1, ctx.dp(h)) }
    fun hspace(w: Int): View = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(ctx.dp(w), 1) }

    /** On/off switch in the Casnt style. */
    fun toggle(initial: Boolean, onChange: (Boolean) -> Unit): TextView {
        var on = initial
        return TextView(ctx).apply {
            textSize = 20f
            typeface = look.title
            gravity = Gravity.CENTER
            minWidth = ctx.dp(110)
            setPadding(ctx.dp(18), ctx.dp(10), ctx.dp(18), ctx.dp(10))
            fun paint() {
                text = if (on) "ON" else "OFF"
                background = rounded(if (on) look.gold else look.darkBtn, 22)
                setTextColor(if (on) Color.BLACK else look.muted)
            }
            paint()
            setOnClickListener { on = !on; paint(); bounce(this); if (sounds) Sfx.blip(if (on) 880 else 520); onChange(on) }
        }
    }

    fun bounce(v: View) {
        if (!look.cartoon || !animations) return
        v.animate().scaleX(0.94f).scaleY(0.94f).setDuration(70).withEndAction {
            v.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
        }.start()
    }

    fun pulse(v: View) {
        if (!animations) return
        ObjectAnimator.ofFloat(v, "alpha", 1f, 0.35f).apply {
            duration = 700; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; start()
        }
    }

    fun popIn(v: View) {
        if (!animations) return
        v.alpha = 0f; v.translationY = ctx.dpf(18f)
        v.animate().alpha(1f).translationY(0f).setDuration(220).start()
    }
}

fun LinearLayout.add(v: View, w: Int = LinearLayout.LayoutParams.WRAP_CONTENT, h: Int = LinearLayout.LayoutParams.WRAP_CONTENT,
                     weight: Float = 0f, top: Int = 0): View {
    val lp = LinearLayout.LayoutParams(w, h, weight)
    lp.topMargin = (top * resources.displayMetrics.density).toInt()
    addView(v, lp)
    return v
}

/**
 * Holds one screen and scales it down (never up) so it always fits the Quest panel.
 * This is what stops the code pad / settings going off the bottom of the screen.
 */
class FitFrame(ctx: Context) : android.widget.FrameLayout(ctx) {
    private val margin = ctx.dp(24)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = View.MeasureSpec.getSize(widthMeasureSpec)
        val h = View.MeasureSpec.getSize(heightMeasureSpec)
        val child = if (childCount > 0) getChildAt(0) else null
        child?.measure(
            View.MeasureSpec.makeMeasureSpec(maxOf(w - 2 * margin, 0), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        setMeasuredDimension(w, h)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val child = if (childCount > 0) getChildAt(0) else return
        val cw = child.measuredWidth
        val ch = child.measuredHeight
        val left = (width - cw) / 2
        val top = (height - ch) / 2
        child.layout(left, top, left + cw, top + ch)
        val s = minOf(1f, (width - 2f * margin) / maxOf(cw, 1), (height - 2f * margin) / maxOf(ch, 1))
        child.pivotX = cw / 2f
        child.pivotY = ch / 2f
        child.scaleX = s
        child.scaleY = s
    }
}

/** Tiny cartoony "blip" sounds, generated so there are no audio files. */
object Sfx {
    fun blip(freq: Int = 660) {
        Thread {
            try {
                val rate = 44_100
                val n = rate * 70 / 1000
                val pcm = ShortArray(n)
                var phase = 0.0
                for (i in 0 until n) {
                    val t = i.toDouble() / n
                    val f = freq * (1 + 0.6 * t)
                    phase += 2 * Math.PI * f / rate
                    val env = (1 - t) * (1 - t)
                    pcm[i] = (Math.sin(phase) * env * 6000).toInt().toShort()
                }
                val track = android.media.AudioTrack.Builder()
                    .setAudioAttributes(android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(android.media.AudioFormat.Builder()
                        .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate)
                        .setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO).build())
                    .setTransferMode(android.media.AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(n * 2)
                    .build()
                track.write(pcm, 0, n)
                track.play()
                Thread.sleep(120)
                track.release()
            } catch (_: Exception) { }
        }.start()
    }
}
