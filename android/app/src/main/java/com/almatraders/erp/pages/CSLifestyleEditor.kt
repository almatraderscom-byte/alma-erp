//
//  CSLifestyleEditor.kt
//  ALMA ERP — native Creative Studio lifestyle finishing EDITOR (Android twin of
//  iOS CSLifestyleEditorSwiftUI / web LifestyleEditor.tsx).
//
//  The owner edits THIS image's texts (eyebrow / headline / offer / code) + theme
//  and DRAGS the main blocks (logo, headline, offer, code ring) on a live 1:1
//  1080×1080 preview. Geometry is a port of computeAutoLayout in
//  src/lib/content-engine/lifestyle-layout.ts, and Apply sends the SAME `layout`
//  overrides to /api/assistant/creative-studio/finish — the server renders the
//  final crisp image, so what is dragged here is what ships. Fine blocks (rule,
//  est line, monogram) keep their auto positions, exactly like a quick reposition.
//

package com.almatraders.erp.pages

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.plainClick
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.roundToInt

/** Minimal reference to the source image (CsGalleryItem is private to CreativeStudioScreen). */
class CsGalleryItemRef(val imageUrl: String?)

/** Finish themes (id → Bangla label) — mirrors CsData.finishThemes. */
val CsLifestyleThemes = listOf(
    "default" to "সাধারণ", "eid" to "ঈদ", "puja" to "পূজা", "boishakh" to "বৈশাখ", "winter" to "শীত",
)

// ── Geometry port (lifestyle-layout.ts computeAutoLayout) ───────────────────────────

private object CSE {
    const val SIZE = 1080f
    const val PAD = 64f
    val cream = Color(0xFFF5EBDD)
    val charcoal = Color(0xFF2A2622)
    const val DEFAULT_OFFER = "অফার প্রাইস জানতে ইনবক্স করুন"
    const val EST = "EST. 2019 · DHAKA"

    val accents = mapOf(
        "default" to Color(0xFFC89B3C), "eid" to Color(0xFF6B2737), "puja" to Color(0xFFC97D5D),
        "boishakh" to Color(0xFF2D5F4F), "winter" to Color(0xFF2D5F4F),
    )
    val eyebrows = mapOf(
        "default" to "নতুন এসেছে", "eid" to "ঈদ স্পেশাল", "puja" to "উৎসব কালেকশন",
        "boishakh" to "বৈশাখী কালেকশন", "winter" to "শীত কালেকশন",
    )
    fun accent(theme: String) = accents[theme] ?: accents["default"]!!
    fun eyebrowDefault(theme: String) = eyebrows[theme] ?: "নতুন এসেছে"

    /** Greedy word-wrap — port of wrapText so line breaks match the server. */
    fun wrap(text: String, maxChars: Int, maxLines: Int): List<String> {
        val words = text.split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        val lines = ArrayList<String>()
        var cur = ""
        for (wd in words) {
            val tentative = if (cur.isEmpty()) wd else "$cur $wd"
            if (tentative.length > maxChars && cur.isNotEmpty() && lines.size < maxLines - 1) {
                lines.add(cur); cur = wd
            } else cur = tentative
        }
        if (cur.isNotEmpty()) lines.add(cur)
        return lines.take(maxLines)
    }

    fun codeSize(code: String): Float = if (code.length > 9) 14f else if (code.length > 6) 17f else 22f
}

/** A draggable block position in 1080-design space — snapshot state so drags recompose. */
private class Blk(x: Float, y: Float) {
    var x by mutableFloatStateOf(x)
    var y by mutableFloatStateOf(y)
}

private class CseLayout(
    val eyebrowLines: List<String>, val headlineLines: List<String>, val offerLines: List<String>,
    val eyebrow: Blk, val headline: Blk, val offer: Blk,
    val codeBadge: Blk, val codeR: Float, val codeSize: Float,
    val logo: Blk, val logoW: Float,
    val ruleX: Float, val ruleY: Float, val ruleW: Float, val estY: Float,
) {
    companion object {
        fun auto(eyebrow: String, headline: String, offer: String, code: String): CseLayout {
            val s = CSE.SIZE; val pad = CSE.PAD
            val hlLines = CSE.wrap(headline, 15, 2)
            val ofLines = CSE.wrap(offer, 18, 2)
            val codeTrim = code.take(16)
            val circleR = 46f
            val ruleY = 1018f
            val hlLeading = 62f
            val nHl = maxOf(1, hlLines.size)
            val firstHlBaseline = (ruleY - 16f) - (nHl - 1) * hlLeading
            val eyebrowBaseline = firstHlBaseline - 46f
            val nOf = maxOf(1, ofLines.size)
            val offerFirstBaseline = 998f - (nOf - 1) * 40f
            return CseLayout(
                eyebrowLines = if (eyebrow.isEmpty()) emptyList() else listOf(eyebrow),
                headlineLines = hlLines, offerLines = ofLines,
                eyebrow = Blk(pad, eyebrowBaseline), headline = Blk(pad, firstHlBaseline),
                offer = Blk(s - pad, offerFirstBaseline),
                codeBadge = Blk(s - pad - circleR, 124f), codeR = circleR, codeSize = CSE.codeSize(codeTrim),
                logo = Blk(60f, 54f), logoW = 280f,
                ruleX = pad, ruleY = ruleY, ruleW = 74f, estY = 1048f,
            )
        }
    }

    /** Encode the moved blocks into the finish `layout` override JSON. */
    fun toOverrideJson(): JSONObject {
        fun tv(b: Blk) = JSONObject().put("x", b.x.roundToInt()).put("y", b.y.roundToInt())
        return JSONObject()
            .put("eyebrow", tv(eyebrow))
            .put("headline", tv(headline))
            .put("offer", tv(offer))
            .put("codeBadge", JSONObject().put("cx", codeBadge.x.roundToInt()).put("cy", codeBadge.y.roundToInt()).put("r", codeR.roundToInt()).put("size", codeSize.roundToInt()))
            .put("logo", JSONObject().put("x", logo.x.roundToInt()).put("y", logo.y.roundToInt()).put("w", logoW.roundToInt()))
    }
}

// ── Editor sheet ────────────────────────────────────────────────────────────────────

@Composable
fun CSLifestyleEditorSheet(
    item: CsGalleryItemRef,
    dark: Boolean,
    scope: CoroutineScope,
    seedHook: String,
    seedEyebrow: String,
    seedOffer: String,
    seedCode: String,
    seedThemeIdx: Int,
    onApply: suspend (hook: String, eyebrow: String, offer: String, code: String, theme: String, layout: JSONObject) -> Boolean,
    onClose: () -> Unit,
) {
    var hook by remember { mutableStateOf(seedHook) }
    var eyebrow by remember { mutableStateOf(seedEyebrow) }
    var offer by remember { mutableStateOf(seedOffer) }
    var code by remember { mutableStateOf(seedCode) }
    var themeIdx by remember { mutableStateOf(seedThemeIdx.coerceIn(0, CsLifestyleThemes.lastIndex)) }
    var busy by remember { mutableStateOf(false) }
    val theme = CsLifestyleThemes[themeIdx].first
    val accent = CSE.accent(theme)

    // Recompute the auto layout when the text/theme changes; dragging mutates it in place.
    val layout = remember(hook, eyebrow, offer, code, theme) {
        CseLayout.auto(
            eyebrow.ifBlank { CSE.eyebrowDefault(theme) },
            hook.ifBlank { "নতুন কালেকশন" },
            offer.ifBlank { CSE.DEFAULT_OFFER },
            code,
        )
    }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("🎨 ব্লক সাজান (ড্র্যাগ করুন)", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("বন্ধ", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, modifier = Modifier.plainClick(onClose).padding(6.dp))
        }

        val ctx = LocalContext.current
        BoxWithConstraints(
            Modifier.fillMaxWidth().aspectRatio(1f).clipToBounds().background(CSE.cream),
        ) {
            val sidePx = with(LocalDensity.current) { maxWidth.toPx() }
            val scale = sidePx / CSE.SIZE

            AsyncImage(
                model = ImageRequest.Builder(ctx).data(item.imageUrl).crossfade(true).build(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxWidth().aspectRatio(1f),
            )

            // static blocks (auto) — accent rule + EST line
            Canvas(Modifier.fillMaxWidth().aspectRatio(1f)) {
                drawRect(accent, topLeft = Offset(layout.ruleX * scale, layout.ruleY * scale), size = Size(layout.ruleW * scale, 3f * scale))
            }
            StaticText(CSE.EST, (CSE.SIZE / 2f - 60f) * scale, (layout.estY - 16f) * scale, 16f * scale, accent)

            // draggable blocks
            DraggableBlock(layout.logo, scale) {
                Text("ALMA LIFESTYLE", color = CSE.charcoal, fontSize = (30 * scale).sp, fontWeight = FontWeight.Black)
            }
            DraggableBlock(layout.eyebrow, scale) {
                Text(eyebrow.ifBlank { CSE.eyebrowDefault(theme) }, color = accent, fontSize = (27 * scale).sp, fontWeight = FontWeight.Medium)
            }
            DraggableBlock(layout.headline, scale) {
                Text(layout.headlineLines.joinToString("\n").ifBlank { "নতুন কালেকশন" }, color = CSE.charcoal, fontSize = (54 * scale).sp, fontWeight = FontWeight.Bold, lineHeight = (62 * scale).sp)
            }
            DraggableBlock(layout.offer, scale, anchorEndOffset = 300f) {
                Text(layout.offerLines.joinToString("\n").ifBlank { CSE.DEFAULT_OFFER }, color = CSE.charcoal, fontSize = (30 * scale).sp, textAlign = TextAlign.End, lineHeight = (40 * scale).sp)
            }
            if (code.isNotBlank()) {
                DraggableRing(layout.codeBadge, layout.codeR, scale) {
                    Text(code.take(16), color = CSE.charcoal, fontSize = (layout.codeSize * scale).sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                }
            }
        }

        Text("ব্লকে ধরে টেনে সরান। লেখা/থিম বদলালে অটো-লেআউট আবার বসে।", color = AlmaTheme.inkSecondary(dark), fontSize = 10.5.sp)

        CsLifestyleField("ছোট লাইন (eyebrow)", eyebrow) { eyebrow = it }
        CsLifestyleField("মূল লেখা (headline)", hook) { hook = it }
        CsLifestyleField("অফার লাইন", offer) { offer = it }
        CsLifestyleField("Product code — ঐচ্ছিক", code) { code = it }

        Text("থিম", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CsLifestyleThemes.forEachIndexed { i, (id, label) ->
                Text(
                    label, color = if (themeIdx == i) Color.White else AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(if (themeIdx == i) CSE.accent(id) else AlmaTheme.inkTertiary(dark).copy(alpha = 0.15f), CircleShape)
                        .plainClick { themeIdx = i }.padding(horizontal = 14.dp, vertical = 7.dp),
                )
            }
        }

        Box(
            Modifier.fillMaxWidth()
                .background(if (busy) AlmaTheme.inkTertiary(dark).copy(alpha = 0.2f) else accent, CircleShape)
                .plainClick {
                    if (busy) return@plainClick
                    busy = true
                    scope.launch {
                        val ok = onApply(hook.trim(), eyebrow.trim(), offer.trim(), code.trim(), theme, layout.toOverrideJson())
                        busy = false
                        if (ok) onClose()
                    }
                }
                .padding(vertical = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (busy) CircularProgressIndicator(Modifier.padding(2.dp), color = Color.White, strokeWidth = 2.dp)
            else Text("✨ এই সাজানো লেআউট বসাও", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun DraggableBlock(blk: Blk, scale: Float, anchorEndOffset: Float = 0f, content: @Composable () -> Unit) {
    Box(
        Modifier
            .offset { IntOffset(((blk.x - anchorEndOffset) * scale).roundToInt(), ((blk.y - 40f) * scale).roundToInt()) }
            .pointerInput(Unit) {
                detectDragGestures { _, drag ->
                    blk.x = (blk.x + drag.x / scale).coerceIn(0f, CSE.SIZE)
                    blk.y = (blk.y + drag.y / scale).coerceIn(0f, CSE.SIZE)
                }
            },
        contentAlignment = if (anchorEndOffset > 0f) Alignment.TopEnd else Alignment.TopStart,
    ) { content() }
}

@Composable
private fun DraggableRing(blk: Blk, r: Float, scale: Float, content: @Composable () -> Unit) {
    Box(
        Modifier
            .offset { IntOffset(((blk.x - r) * scale).roundToInt(), ((blk.y - r) * scale).roundToInt()) }
            .pointerInput(Unit) {
                detectDragGestures { _, drag ->
                    blk.x = (blk.x + drag.x / scale).coerceIn(0f, CSE.SIZE)
                    blk.y = (blk.y + drag.y / scale).coerceIn(0f, CSE.SIZE)
                }
            },
    ) {
        Box(
            Modifier.background(CSE.cream, CircleShape).border(2.dp, CSE.charcoal, CircleShape).padding((r * scale * 0.3f).coerceAtLeast(4f).dp),
            contentAlignment = Alignment.Center,
        ) { content() }
    }
}

@Composable
private fun StaticText(text: String, xPx: Float, yPx: Float, sizePx: Float, color: Color) {
    Box(Modifier.offset { IntOffset(xPx.roundToInt(), yPx.roundToInt()) }) {
        Text(text, color = color, fontSize = sizePx.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun CsLifestyleField(placeholder: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange,
        placeholder = { Text(placeholder, fontSize = 12.sp) },
        singleLine = true, modifier = Modifier.fillMaxWidth(),
    )
}
