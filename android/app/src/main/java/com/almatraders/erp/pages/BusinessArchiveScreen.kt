//
//  BusinessArchiveScreen.kt
//  ALMA ERP — Business Archive Control, ported 1:1 from BusinessArchiveSwiftUI.swift.
//  STRICTLY READ-ONLY: preview / execute / restore are destructive-adjacent Super-Admin
//  flows (typed confirmation phrase on web) — every mutation escapes to the web page.
//
//  Endpoints (same as web/iOS):
//    GET /api/business-archive/modules?business_id=…  → module registry + active/archived
//        stats (+ schemaReady, migrationHint, warning) — wrapped {ok, data:{…}} or flat
//    GET /api/business-archive/batches?business_id=…  → archive batch history (flat)
//  Blocks: business picker chips · safety-mode card · schema-migration card · "Active vs
//  archived stats" as a Files-app grouped list · Archive history list · module + batch
//  detail sheets. Carried lessons: lenient decoding, no global spinner.
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object ArchivePalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Batch status → web tone: COMPLETED emerald · RESTORED muted · FAILED red · else amber. */
    fun batchStatus(s: String?, dark: Boolean): Color = when (s) {
        "COMPLETED" -> emerald600
        "RESTORED" -> AlmaTheme.inkSecondary(dark)
        "FAILED" -> red500
        else -> amber600
    }
}

/** The web page's business picker options (BUSINESS_LIST parity). */
private val archiveBusinesses: List<Pair<String, String>>
    get() = listOf(
        "ALMA_LIFESTYLE" to "Alma Lifestyle",
        "CREATIVE_DIGITAL_IT" to "Creative Digital IT",
        "ALMA_TRADING" to "Alma Trading",
    )

// ── Models (same field names the web page types declare) ───────────────────────────

private data class ArchiveModule(
    val key: String,
    val label: String?,
    val detail: String?,          // web "description"
    val storage: String?,
    val integrationNote: String?,
) {
    /** Files-app feel: one doc glyph per module (iOS SF Symbol map, emoji twin). */
    val icon: String
        get() = when (key) {
            "approvals" -> "✅"
            "attendance" -> "⏰"
            "attendance_waivers" -> "⏳"
            "wallet_requests" -> "👛"
            "expenses" -> "💳"
            "invoices" -> "📄"
            "trading_trades" -> "📈"
            "trading_expenses" -> "💵"
            "telegram_drafts" -> "✈️"
            "orders" -> "📦"
            "inventory" -> "🗂️"
            "crm" -> "👥"
            else -> "📄"
        }

    companion object {
        fun from(o: JSONObject): ArchiveModule? {
            val key = o.str("key") ?: return null
            return ArchiveModule(
                key = key,
                label = o.str("label"),
                detail = o.str("description"),
                storage = o.str("storage"),
                integrationNote = o.str("integrationNote"),
            )
        }
    }
}

private data class ArchiveStat(
    val moduleKey: String,
    val activeCount: Int,
    val archivedCount: Int,
    val available: Boolean?,
    val warning: String?,
) {
    companion object {
        fun from(o: JSONObject): ArchiveStat? {
            val key = o.str("moduleKey") ?: return null
            return ArchiveStat(
                moduleKey = key,
                activeCount = o.flexInt("activeCount") ?: 0,
                archivedCount = o.flexInt("archivedCount") ?: 0,
                available = o.flexBool("available"),
                warning = o.str("warning"),
            )
        }
    }
}

private data class ArchiveBatch(
    val id: String,
    val name: String?,
    val businessId: String?,
    val moduleKeys: List<String>,
    val status: String?,
    val recordCount: Int?,
    val entityCount: Int?,
    val createdAt: String?,
    val completedAt: String?,
    val restoredAt: String?,
) {
    companion object {
        fun from(o: JSONObject): ArchiveBatch {
            val keys = o.optJSONArray("moduleKeys")?.let { arr ->
                (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotEmpty() } }
            } ?: o.str("moduleKeys")?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }
                ?: emptyList()
            return ArchiveBatch(
                id = o.str("id") ?: UUID.randomUUID().toString(),
                name = o.str("name"),
                businessId = o.str("businessId"),
                moduleKeys = keys,
                status = o.str("status"),
                recordCount = o.flexInt("recordCount"),
                entityCount = o.flexInt("entityCount"),
                createdAt = o.str("createdAt"),
                completedAt = o.str("completedAt"),
                restoredAt = o.str("restoredAt"),
            )
        }
    }
}

// ── State holder (iOS BusinessArchiveVM twin) ──────────────────────────────────────

private class BusinessArchiveState {
    var businessId by mutableStateOf("ALMA_LIFESTYLE")     // web DEFAULT_BUSINESS_ID
    var modules by mutableStateOf(listOf<ArchiveModule>())
    var stats by mutableStateOf(listOf<ArchiveStat>())
    var batches by mutableStateOf(listOf<ArchiveBatch>())
    var schemaReady by mutableStateOf(true)
    var migrationHint by mutableStateOf<String?>(null)
    var loadWarning by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    fun stat(key: String): ArchiveStat? = stats.firstOrNull { it.moduleKey == key }
    val totalArchived: Int get() = stats.sumOf { it.archivedCount }

    /** modules wraps via apiDataSuccess → {ok, data:{…}}; batches answers flat — take both. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            coroutineScope {
                val modulesCall = async {
                    AlmaApi.getObject("/api/business-archive/modules", mapOf("business_id" to businessId))
                }
                val batchesCall = async {
                    AlmaApi.getObject("/api/business-archive/batches", mapOf("business_id" to businessId))
                }
                val m = unwrap(modulesCall.await())
                val b = unwrap(batchesCall.await())
                modules = m.optJSONArray("modules")?.mapObjects { ArchiveModule.from(it) } ?: emptyList()
                stats = m.optJSONArray("stats")?.mapObjects { ArchiveStat.from(it) } ?: emptyList()
                schemaReady = m.flexBool("schemaReady") ?: true
                migrationHint = m.str("migrationHint")
                loadWarning = m.str("warning") ?: b.str("warning")
                batches = b.optJSONArray("batches")?.mapObjects { ArchiveBatch.from(it) } ?: emptyList()
            }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    // ── Archive / restore (SUPER_ADMIN, reversible) — native replacement for the web
    //    escape. Archive is guarded by a typed confirmation phrase, exactly like web. ──

    /** POST preview → (confirmationPhrase, human summary), or null on failure. */
    suspend fun preview(moduleKeys: List<String>): Pair<String, String>? {
        return try {
            val resp = AlmaApi.send(
                "POST", "/api/business-archive/preview",
                JSONObject().put("business_id", businessId).put("module_keys", org.json.JSONArray(moduleKeys)),
            )
            val d = resp.optJSONObject("data") ?: resp
            val phrase = d.str("confirmationPhrase") ?: d.str("confirmation_phrase") ?: return null
            val prev = d.optJSONObject("preview") ?: d
            val total = prev.flexInt("totalRows") ?: prev.flexInt("total") ?: prev.flexInt("count") ?: 0
            Pair(phrase, "মোট ~$total রেকর্ড আর্কাইভ হবে")
        } catch (_: Exception) {
            null
        }
    }

    /** POST execute with the typed confirmation. null = archived, else error string. */
    suspend fun execute(moduleKeys: List<String>, batchName: String, confirmation: String): String? {
        return try {
            AlmaApi.send(
                "POST", "/api/business-archive/execute",
                JSONObject().put("business_id", businessId).put("module_keys", org.json.JSONArray(moduleKeys))
                    .put("batch_name", batchName).put("confirmation", confirmation),
            )
            load()
            null
        } catch (e: AlmaApiException.Http) {
            e.message?.substringAfter(": ")?.takeIf { it.isNotBlank() } ?: "আর্কাইভ হয়নি"
        } catch (_: Exception) {
            "আর্কাইভ হয়নি — আবার চেষ্টা করুন"
        }
    }

    /** POST restore {batch_id}. null = restored, else error string. */
    suspend fun restore(batchId: String): String? {
        return try {
            AlmaApi.send("POST", "/api/business-archive/restore", JSONObject().put("batch_id", batchId))
            load()
            null
        } catch (e: AlmaApiException.Http) {
            e.message?.substringAfter(": ")?.takeIf { it.isNotBlank() } ?: "রিস্টোর হয়নি"
        } catch (_: Exception) {
            "রিস্টোর হয়নি — আবার চেষ্টা করুন"
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BusinessArchiveScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { BusinessArchiveState() }
    val scope = rememberCoroutineScope()
    var selectedModule by remember { mutableStateOf<ArchiveModule?>(null) }
    var selectedBatch by remember { mutableStateOf<ArchiveBatch?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Business picker (web Step 1) + total-archived badge.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    archiveBusinesses.forEach { (id, name) ->
                        ArchiveChip(name, vm.businessId == id, dark) {
                            vm.businessId = id
                            scope.launch { vm.load() }
                        }
                    }
                }
                if (vm.totalArchived > 0) {
                    Text(
                        "${vm.totalArchived}",
                        color = ArchivePalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(ArchivePalette.coral.copy(alpha = 0.18f), CircleShape)
                            .border(1.dp, ArchivePalette.coral.copy(alpha = 0.4f), CircleShape)
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }
        }

        if (vm.authExpired) {
            item { ArchiveAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { ArchiveNotice(it, ArchivePalette.red500, dark) } }
        vm.loadWarning?.let { item { ArchiveNotice(it, ArchivePalette.amber600, dark) } }

        if (!vm.schemaReady) {
            item {
                ArchiveToneCard(
                    "⛔ Database migration required",
                    "${vm.migrationHint ?: "Business Archive tables are not on this database yet."} " +
                        "ERP continues normally; run migrations on production to enable archive features.",
                    ArchivePalette.red500, dark,
                )
            }
        }

        item {
            // Web "Safety mode" card, same copy.
            ArchiveToneCard(
                "🛡 Safety mode",
                "This never permanently deletes records. Archived items are hidden from default views. " +
                    "Use archive_visibility=archived on APIs or Show Archived in UI.",
                ArchivePalette.amber500, dark,
                titleTint = ArchivePalette.amber600,
            )
        }

        if (vm.loading && vm.modules.isEmpty()) {
            items(3) { Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        if (vm.modules.isNotEmpty()) {
            item {
                // Web "Active vs archived stats" as a Files-style grouped list.
                Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
                    Text(
                        "ACTIVE VS ARCHIVED STATS",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 6.dp),
                    )
                    vm.modules.forEachIndexed { index, m ->
                        ArchiveModuleRow(m, vm.stat(m.key), dark) { selectedModule = m }
                        if (index < vm.modules.size - 1) {
                            Box(
                                Modifier.fillMaxWidth().padding(start = 58.dp).height(1.dp)
                                    .background(AlmaTheme.separator(dark)),
                            )
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
        }

        item {
            // Archive history (web batch list).
            Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
                Text(
                    "ARCHIVE HISTORY",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 6.dp),
                )
                if (vm.batches.isEmpty()) {
                    Column(
                        Modifier.fillMaxWidth().padding(vertical = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("🗄", fontSize = 24.sp)
                        Text(
                            if (vm.loading) "লোড হচ্ছে…" else "No archive batches yet.",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        )
                    }
                } else {
                    vm.batches.forEachIndexed { index, b ->
                        ArchiveBatchRow(b, dark) { selectedBatch = b }
                        if (index < vm.batches.size - 1) {
                            Box(
                                Modifier.fillMaxWidth().padding(start = 58.dp).height(1.dp)
                                    .background(AlmaTheme.separator(dark)),
                            )
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    // Archive confirm (typed phrase) + restore confirm state.
    var archiveTarget by remember { mutableStateOf<Triple<List<String>, String, String>?>(null) } // keys, phrase, summary
    var archiveName by remember { mutableStateOf("") }
    var typed by remember { mutableStateOf("") }
    var restoreBatch by remember { mutableStateOf<ArchiveBatch?>(null) }
    var busy by remember { mutableStateOf(false) }
    var actionMsg by remember { mutableStateOf<String?>(null) }

    selectedModule?.let { m ->
        ModalBottomSheet(onDismissRequest = { selectedModule = null }, containerColor = AlmaTheme.rootBg(dark)) {
            ArchiveModuleSheet(m, vm.stat(m.key), dark) {
                selectedModule = null
                scope.launch {
                    busy = true
                    val p = vm.preview(listOf(m.key))
                    busy = false
                    if (p != null) { archiveName = m.label ?: m.key; typed = ""; archiveTarget = Triple(listOf(m.key), p.first, p.second) }
                    else actionMsg = "প্রিভিউ পাওয়া যায়নি"
                }
            }
        }
    }

    selectedBatch?.let { b ->
        ModalBottomSheet(onDismissRequest = { selectedBatch = null }, containerColor = AlmaTheme.rootBg(dark)) {
            ArchiveBatchSheet(b, dark) {
                selectedBatch = null
                restoreBatch = b
            }
        }
    }

    // ── Archive confirm dialog — user must type the exact confirmation phrase ──
    archiveTarget?.let { (keys, phrase, summary) ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { if (!busy) archiveTarget = null },
            title = { Text("আর্কাইভ: $archiveName") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("$summary\n\nনিশ্চিত করতে নিচের ফ্রেজ হুবহু টাইপ করুন:", fontSize = 13.sp)
                    Text(phrase, color = ArchivePalette.coral, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    androidx.compose.material3.OutlinedTextField(
                        value = typed, onValueChange = { typed = it }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    enabled = !busy && typed.trim() == phrase.trim(),
                    onClick = {
                        scope.launch {
                            busy = true
                            val err = vm.execute(keys, "Native archive", phrase)
                            busy = false; archiveTarget = null
                            actionMsg = err ?: "✅ আর্কাইভ সম্পন্ন হয়েছে"
                        }
                    },
                ) { Text(if (busy) "চলছে…" else "আর্কাইভ করুন") }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { if (!busy) archiveTarget = null }) { Text("বাতিল") } },
        )
    }

    // ── Restore confirm ──
    restoreBatch?.let { b ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { if (!busy) restoreBatch = null },
            title = { Text("রিস্টোর: ${b.name ?: "ব্যাচ"}") },
            text = { Text("এই ব্যাচের রেকর্ড আবার সক্রিয় স্টোরেজে ফিরিয়ে আনা হবে।", fontSize = 13.sp) },
            confirmButton = {
                androidx.compose.material3.TextButton(enabled = !busy, onClick = {
                    scope.launch {
                        busy = true
                        val err = vm.restore(b.id)
                        busy = false; restoreBatch = null
                        actionMsg = err ?: "✅ রিস্টোর সম্পন্ন হয়েছে"
                    }
                }) { Text(if (busy) "চলছে…" else "রিস্টোর করুন") }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { if (!busy) restoreBatch = null }) { Text("বাতিল") } },
        )
    }

    actionMsg?.let { msg ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { actionMsg = null },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { actionMsg = null }) { Text("ঠিক আছে") } },
            text = { Text(msg) },
        )
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun ArchiveChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) ArchivePalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) ArchivePalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) ArchivePalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun ArchiveNotice(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun ArchiveAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(ArchivePalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

/** Web tone-amber / tone-red info card (safety mode + migration). */
@Composable
private fun ArchiveToneCard(
    title: String,
    body: String,
    tint: Color,
    dark: Boolean,
    titleTint: Color = tint,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = 0.07f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, tint.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(title, color = titleTint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Text(body, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

/** Files-app icon square shared by module + batch rows and sheets. */
@Composable
private fun ArchiveIconSquare(glyph: String, size: Int, dark: Boolean) {
    Box(
        Modifier
            .size(size.dp)
            .background(ArchivePalette.coral.copy(alpha = 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, ArchivePalette.coral.copy(alpha = 0.28f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
        contentAlignment = Alignment.Center,
    ) { Text(glyph, fontSize = (size * 0.45f).sp) }
}

// ── Module row (Files-app style: icon square + name + counts + chevron) ────────────

@Composable
private fun ArchiveModuleRow(
    module: ArchiveModule,
    stat: ArchiveStat?,
    dark: Boolean,
    onTap: () -> Unit,
) {
    val unavailable = stat?.available == false
    Row(
        Modifier
            .fillMaxWidth()
            .plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ArchiveIconSquare(module.icon, 34, dark)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                module.label ?: module.key,
                color = AlmaTheme.ink(dark).copy(alpha = if (unavailable) 0.7f else 1f),
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
            // Web row: Active <emerald> · Archived <amber>
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Active", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                Text(
                    ArchiveFormat.grouped(stat?.activeCount ?: 0),
                    color = ArchivePalette.emerald600, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                )
                Text("· Archived", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                Text(
                    ArchiveFormat.grouped(stat?.archivedCount ?: 0),
                    color = ArchivePalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                )
            }
            (stat?.warning ?: module.integrationNote)?.takeIf { it.isNotEmpty() }?.let {
                Text(
                    it, color = ArchivePalette.amber600, fontSize = 10.sp,
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (unavailable) {
            Text(
                "N/A",
                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                    .padding(horizontal = 5.dp, vertical = 1.5.dp),
            )
        }
        Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Batch row (archive history entry) ──────────────────────────────────────────────

@Composable
private fun ArchiveBatchRow(batch: ArchiveBatch, dark: Boolean, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ArchiveIconSquare(if (batch.restoredAt != null) "↩️" else "🗄", 34, dark)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                batch.name ?: "—",
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            // Web line: moduleKeys.join(', ') · recordCount records
            Text(
                "${batch.moduleKeys.joinToString(", ")} · ${ArchiveFormat.grouped(batch.recordCount ?: 0)} records",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            ArchiveFormat.dateTime(batch.createdAt)?.let {
                Text(it, color = AlmaTheme.inkTertiary(dark), fontSize = 10.sp)
            }
        }
        val tint = ArchivePalette.batchStatus(batch.status, dark)
        Text(
            batch.status ?: "—",
            color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier
                .background(tint.copy(alpha = 0.10f), CircleShape)
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
        Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Module detail sheet (read-only; archive actions escape to web) ─────────────────

@Composable
private fun ArchiveModuleSheet(
    module: ArchiveModule,
    stat: ArchiveStat?,
    dark: Boolean,
    onArchive: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ArchiveIconSquare(module.icon, 46, dark)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(module.label ?: module.key, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                module.detail?.let {
                    Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ArchiveCountCard("ACTIVE", stat?.activeCount ?: 0, ArchivePalette.emerald600, dark, Modifier.weight(1f))
            ArchiveCountCard("ARCHIVED", stat?.archivedCount ?: 0, ArchivePalette.amber600, dark, Modifier.weight(1f))
        }

        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ArchiveInfoRow("Module key", module.key, dark)
            ArchiveInfoRow("Storage", module.storage ?: "—", dark)
            ArchiveInfoRow(
                "Available", if (stat?.available == false) "No" else "Yes", dark,
                tint = if (stat?.available == false) ArchivePalette.amber600 else ArchivePalette.emerald600,
            )
            (stat?.warning ?: module.integrationNote)?.takeIf { it.isNotEmpty() }?.let {
                ArchiveInfoRow("Warning", it, dark, tint = ArchivePalette.amber600)
            }
        }

        Text(
            "আর্কাইভ করলে পুরনো রেকর্ড আলাদা স্টোরেজে সরে যাবে — পরে ব্যাচ থেকে রিস্টোর করা যায়। কনফার্মেশন ফ্রেজ টাইপ করতে হবে।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )

        if (stat?.available != false && (stat?.activeCount ?: 0) > 0) {
            Text(
                "🗄 এই মডিউল আর্কাইভ করুন",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(ArchivePalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick(onArchive)
                    .padding(vertical = 11.dp),
            )
        }
    }
}

// ── Batch detail sheet (read-only; restore escapes to web) ─────────────────────────

@Composable
private fun ArchiveBatchSheet(
    batch: ArchiveBatch,
    dark: Boolean,
    onRestore: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(batch.name ?: "—", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    batch.status ?: "—",
                    color = ArchivePalette.batchStatus(batch.status, dark),
                    fontSize = 11.sp, fontWeight = FontWeight.Black,
                )
                Text(
                    ArchiveFormat.dateTime(batch.createdAt) ?: "—",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            }
        }

        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ArchiveInfoRow("Business", batch.businessId ?: "—", dark)
            ArchiveInfoRow(
                "Modules",
                if (batch.moduleKeys.isEmpty()) "—" else batch.moduleKeys.joinToString(", "),
                dark,
            )
            ArchiveInfoRow("Records", ArchiveFormat.grouped(batch.recordCount ?: 0), dark)
            batch.entityCount?.let { ArchiveInfoRow("Archived entities", ArchiveFormat.grouped(it), dark) }
            ArchiveInfoRow("Created", ArchiveFormat.dateTime(batch.createdAt) ?: "—", dark)
            ArchiveFormat.dateTime(batch.completedAt)?.let { ArchiveInfoRow("Completed", it, dark) }
            ArchiveFormat.dateTime(batch.restoredAt)?.let {
                ArchiveInfoRow("Restored", it, dark, tint = ArchivePalette.emerald600)
            }
        }

        if (batch.status == "COMPLETED" && batch.restoredAt == null) {
            Text(
                "রিস্টোর করলে এই ব্যাচের রেকর্ড আবার সক্রিয় স্টোরেজে ফিরে আসবে।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
            Text(
                "♻️ এই ব্যাচ রিস্টোর করুন",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(ArchivePalette.emerald600, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick(onRestore)
                    .padding(vertical = 11.dp),
            )
        }
    }
}

@Composable
private fun ArchiveCountCard(label: String, value: Int, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text(ArchiveFormat.grouped(value), color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun ArchiveInfoRow(label: String, value: String, dark: Boolean, tint: Color? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = tint ?: AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object ArchiveFormat {
    /** createdAt → "5/7/2026, 8:50 PM" style (web toLocaleString), Asia/Dhaka. */
    fun dateTime(iso: String?): String? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        )
        for (p in patterns) {
            try {
                val parser = SimpleDateFormat(p, Locale.US)
                parser.timeZone = TimeZone.getTimeZone("UTC")
                val date = parser.parse(iso) ?: continue
                val f = SimpleDateFormat("M/d/yyyy, h:mm a", Locale.US)
                f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
                return f.format(date)
            } catch (_: Exception) { }
        }
        return null
    }

    /** 12,345 with thousands separators (Int.formatted() twin). */
    fun grouped(v: Int): String = String.format(Locale.US, "%,d", v)
}
