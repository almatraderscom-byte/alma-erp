//
//  KnownPeopleScreen.kt
//  ALMA ERP — the agent's "চেনা মুখ" page (camera face registry + entrance watch),
//  ported 1:1 from KnownPeopleSwiftUI.swift. Blocks: header · entrance-watch settings
//  card (enabled toggle · camera picker · start/end · cooldown stepper · live test) ·
//  search · role chips (সব/মালিক/স্টাফ/পরিবার/অন্যান্য) · Contacts-style people rows
//  (Coil avatar + role capsule + active state) · person detail sheet (toggle active,
//  delete). Add-new-face needs a photo upload → web escape (/agent/known-people).
//
//  Endpoints (same as web/iOS):
//    GET   /api/assistant/known-people          → { people, thumbs, settings }
//    GET   /api/assistant/known-people/cameras   → { cameras, workRoomDeviceId }
//    POST  /api/assistant/known-people/settings  ← merge patch
//    PATCH /api/assistant/known-people/{id}      ← { active }
//    DELETE/api/assistant/known-people/{id}
//    POST  /api/assistant/known-people/test      → live camera check
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Palette (exact hexes from the iOS KnownPeoplePalette) ──────────────────────────

private object KpPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** One tint per registry role — owner coral, staff emerald, family violet. */
    fun role(role: String, dark: Boolean): Color = when (role) {
        "owner" -> coral
        "staff" -> emerald600
        "family" -> AlmaTheme.violet
        else -> AlmaTheme.inkSecondary(dark)
    }
}

// ── Models ─────────────────────────────────────────────────────────────────────────

private data class KnownPerson(
    val id: String,
    val name: String,
    val role: String,
    val photoPaths: List<String>,
    val active: Boolean,
    val note: String?,
    val createdAt: String?,
) {
    val roleLabelBn: String
        get() = when (role) {
            "owner" -> "মালিক"; "staff" -> "স্টাফ"; "family" -> "পরিবার"; "other" -> "অন্যান্য"; else -> role
        }

    companion object {
        fun from(o: JSONObject): KnownPerson? {
            val id = o.str("id") ?: return null
            val photos = o.optJSONArray("photoPaths")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it, null) }
            } ?: emptyList()
            return KnownPerson(
                id = id,
                name = o.str("name") ?: "—",
                role = o.str("role") ?: "staff",
                photoPaths = photos,
                active = o.flexBool("active") ?: true,
                note = o.str("note"),
                createdAt = o.str("createdAt"),
            )
        }
    }
}

private data class KpSettings(
    val enabled: Boolean,
    val deviceId: String,
    val startHm: String,
    val endHm: String,
    val cooldownMin: Int?,
) {
    companion object {
        fun from(o: JSONObject): KpSettings = KpSettings(
            enabled = o.flexBool("enabled") ?: false,
            deviceId = o.str("deviceId") ?: "",
            startHm = o.str("startHm") ?: "00:00",
            endHm = o.str("endHm") ?: "23:59",
            cooldownMin = o.flexInt("cooldownMin"),
        )
    }
}

private data class KpCamera(val deviceId: String, val channelName: String?)

// ── State holder (iOS KnownPeopleVM twin) ──────────────────────────────────────────

private class KnownPeopleState {
    var people by mutableStateOf(listOf<KnownPerson>())
    var thumbs by mutableStateOf(mapOf<String, String>())
    var settings by mutableStateOf<KpSettings?>(null)
    var cameras by mutableStateOf(listOf<KpCamera>())
    var workRoomDeviceId by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var search by mutableStateOf("")
    var roleFilter by mutableStateOf("all")
    var toast by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    val filtered: List<KnownPerson>
        get() = people.filter { p ->
            (roleFilter == "all" || p.role == roleFilter) &&
                (search.isEmpty() ||
                    p.name.contains(search, true) ||
                    p.roleLabelBn.contains(search) ||
                    p.role.contains(search, true))
        }

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/assistant/known-people"))
            people = c.optJSONArray("people")?.mapObjects { KnownPerson.from(it) } ?: emptyList()
            thumbs = c.optJSONObject("thumbs")?.let { t ->
                buildMap { t.keys().forEach { k -> t.str(k)?.let { put(k, it) } } }
            } ?: emptyMap()
            settings = c.optJSONObject("settings")?.let { KpSettings.from(it) }
            // Cameras are best-effort (web .catch(() => {})) — a failure never fails the screen.
            try {
                val cc = unwrap(AlmaApi.getObject("/api/assistant/known-people/cameras"))
                cameras = cc.optJSONArray("cameras")?.mapObjects { cam ->
                    cam.str("deviceId")?.let { KpCamera(it, cam.str("channelName")) }
                } ?: emptyList()
                workRoomDeviceId = cc.str("workRoomDeviceId")
            } catch (_: Exception) { }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "লোড করা যায়নি — নেটওয়ার্ক সমস্যা"
        } finally {
            loading = false
        }
    }

    /** Camera dropdown text: channelName || deviceId, plus the work-room suffix. */
    fun cameraLabel(deviceId: String): String {
        if (deviceId.isEmpty()) return "— বাছাই করুন —"
        val cam = cameras.firstOrNull { it.deviceId == deviceId }
        var label = cam?.channelName?.takeIf { it.isNotEmpty() } ?: deviceId
        if (deviceId == workRoomDeviceId) label += " (Work Room — বর্তমান)"
        return label
    }

    /** Web saveSettings — POST merges over current settings. */
    suspend fun saveSettings(
        deviceId: String? = null, enabled: Boolean? = null,
        startHm: String? = null, endHm: String? = null, cooldownMin: Int? = null,
    ) {
        val s = settings ?: return
        busy = true
        try {
            val body = JSONObject()
                .put("deviceId", deviceId ?: s.deviceId)
                .put("enabled", enabled ?: s.enabled)
                .put("startHm", startHm ?: s.startHm)
                .put("endHm", endHm ?: s.endHm)
                .put("cooldownMin", cooldownMin ?: s.cooldownMin ?: 30)
            AlmaApi.send("POST", "/api/assistant/known-people/settings", body)
            toast = "✅ সেটিংস সেভ হয়েছে"
            load()
        } catch (e: Exception) {
            toast = "সেভ হয়নি — নেটওয়ার্ক সমস্যা"
        } finally {
            busy = false
        }
    }

    suspend fun toggleActive(p: KnownPerson) {
        busy = true
        try {
            AlmaApi.send("PATCH", "/api/assistant/known-people/${p.id}", JSONObject().put("active", !p.active))
        } catch (_: Exception) { }
        busy = false
        load()
    }

    suspend fun removePerson(p: KnownPerson) {
        busy = true
        try {
            AlmaApi.send("DELETE", "/api/assistant/known-people/${p.id}")
            toast = "${p.name} মুছে ফেলা হয়েছে"
        } catch (_: Exception) { }
        busy = false
        load()
    }

    /** Web runTest — live camera check, result rendered as a toast digest. */
    suspend fun runTest() {
        busy = true
        try {
            val res = AlmaApi.send("POST", "/api/assistant/known-people/test", JSONObject())
            val err = res.str("error")
            toast = when {
                err != null -> "🧪 টেস্ট ব্যর্থ: $err"
                res.flexBool("matched") == true -> "🧪 চিনেছে: ${res.str("name") ?: "কেউ একজন"}"
                res.flexBool("ran") == true -> "🧪 টেস্ট চলল — কাউকে চেনেনি"
                else -> "🧪 টেস্ট চালানো যায়নি"
            }
        } catch (e: Exception) {
            toast = "🧪 টেস্ট ব্যর্থ — নেটওয়ার্ক সমস্যা"
        } finally {
            busy = false
        }
    }
}

// ── Formatting ─────────────────────────────────────────────────────────────────────

private object KpFormat {
    fun dateTime(iso: String?): String? {
        if (iso.isNullOrEmpty()) return null
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    private fun parse(iso: String): Date? {
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ssXXX",
        )
        for (p in patterns) {
            try {
                val f = SimpleDateFormat(p, Locale.US); f.timeZone = TimeZone.getTimeZone("UTC")
                return f.parse(iso)
            } catch (_: Exception) { }
        }
        return null
    }

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KnownPeopleScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { KnownPeopleState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<KnownPerson?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = com.almatraders.erp.shell.LocalHeaderInset.current),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Header(dark) }
        if (vm.authExpired) item { AuthCard(dark) { ctx.openSmart("/login", "Login") } }
        vm.error?.let { item { ErrorCard(it, dark) } }
        vm.toast?.let { item { NoticeCard(it, dark) } }
        item { SettingsCard(vm, dark, scope) { ctx.openWebForced("/agent/known-people", "Known people") } }
        item { SearchBar(vm, dark) }
        item { RoleChips(vm, dark) }
        if (vm.loading && vm.people.isEmpty()) {
            items(5) { Box(Modifier.fillMaxWidth().height(68.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }
        item {
            Text(
                "👥 চেনা মানুষের তালিকা (${vm.filtered.size})",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        items(vm.filtered, key = { it.id }) { p ->
            PersonRow(p, vm.thumbs[p.id], dark) { selected = p }
        }
        if (!vm.loading && vm.people.isEmpty() && vm.error == null && !vm.authExpired) {
            item { EmptyState(dark) }
        } else if (!vm.loading && vm.people.isNotEmpty() && vm.filtered.isEmpty()) {
            item {
                Text(
                    "কিছু পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().padding(top = 24.dp), textAlign = TextAlign.Center,
                )
            }
        }
        item {
            Text(
                "🌐 যোগ/এডিট/টেস্ট — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().plainClick { ctx.openWebForced("/agent/known-people", "Known people") }.padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { p ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            PersonDetailSheet(
                p, vm.thumbs[p.id], dark,
                onToggle = { selected = null; scope.launch { vm.toggleActive(p) } },
                onDelete = { selected = null; scope.launch { vm.removePerson(p) } },
                openWeb = { path, title -> selected = null; ctx.openWebForced(path, title) },
            )
        }
    }
}

// ── Header + settings ──────────────────────────────────────────────────────────────

@Composable
private fun Header(dark: Boolean) {
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row {
            Text("চেনা ", color = AlmaTheme.ink(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text("মুখ", color = KpPalette.accentText(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Text(
            "এন্ট্রান্স ক্যামেরা • কে ঢুকলো-বের হলো • অপরিচিত অ্যালার্ট",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsCard(
    vm: KnownPeopleState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    openAddWeb: () -> Unit,
) {
    val s = vm.settings
    if (s == null) {
        if (!vm.loading && !vm.authExpired && vm.error == null) {
            Text(
                "সেটিংস লোড হয়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
            )
        }
        return
    }
    var camMenu by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("🚪 এন্ট্রান্স ক্যামেরা", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Switch(
                checked = s.enabled,
                onCheckedChange = { on -> scope.launch { vm.saveSettings(enabled = on) } },
                colors = SwitchDefaults.colors(checkedTrackColor = KpPalette.emerald600),
            )
        }
        // Camera picker (web dropdown parity).
        Box {
            Row(
                Modifier.fillMaxWidth().plainClick { camMenu = true },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text("ক্যামেরা", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                    Text(vm.cameraLabel(s.deviceId), color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
                Spacer(Modifier.weight(1f))
                Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
            }
            DropdownMenu(expanded = camMenu, onDismissRequest = { camMenu = false }) {
                vm.cameras.forEach { cam ->
                    DropdownMenuItem(
                        text = { Text(vm.cameraLabel(cam.deviceId)) },
                        onClick = { camMenu = false; scope.launch { vm.saveSettings(deviceId = cam.deviceId) } },
                    )
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            SettingsField("শুরু", s.startHm, dark)
            SettingsField("শেষ", s.endHm, dark)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("কুলডাউন (মিনিট)", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StepBtn("−", dark) {
                        scope.launch { vm.saveSettings(cooldownMin = maxOf(1, (s.cooldownMin ?: 30) - 5)) }
                    }
                    Text("${s.cooldownMin ?: "—"}", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    StepBtn("+", dark) {
                        scope.launch { vm.saveSettings(cooldownMin = minOf(240, (s.cooldownMin ?: 30) + 5)) }
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                    .plainClick { if (!vm.busy) scope.launch { vm.runTest() } }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (vm.busy) CircularProgressIndicator(Modifier.size(12.dp), color = KpPalette.coral, strokeWidth = 2.dp)
                Text("🧪 লাইভ টেস্ট", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Text(
                "+ নতুন মুখ",
                color = KpPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(KpPalette.coral.copy(alpha = 0.12f), CircleShape)
                    .border(1.dp, KpPalette.coral.copy(alpha = 0.3f), CircleShape)
                    .plainClick(openAddWeb)
                    .padding(horizontal = 12.dp, vertical = 7.dp),
            )
        }
    }
}

@Composable
private fun SettingsField(label: String, value: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun StepBtn(label: String, dark: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(24.dp).almaGlass(dark, 8).plainClick(onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold) }
}

// ── Search + role chips ────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchBar(vm: KnownPeopleState, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("🔍", fontSize = 13.sp)
        androidx.compose.foundation.text.BasicTextField(
            value = vm.search,
            onValueChange = { vm.search = it },
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(KpPalette.coral),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (vm.search.isEmpty()) Text("নাম খুঁজুন", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
                    inner()
                }
            },
        )
        if (vm.search.isNotEmpty()) {
            Text("✕", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, modifier = Modifier.plainClick { vm.search = "" })
        }
    }
}

@Composable
private fun RoleChips(vm: KnownPeopleState, dark: Boolean) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        listOf("সব" to "all", "মালিক" to "owner", "স্টাফ" to "staff", "পরিবার" to "family", "অন্যান্য" to "other")
            .forEach { (label, key) ->
                KpChip(label, vm.roleFilter == key, dark) { vm.roleFilter = key }
            }
    }
}

@Composable
private fun KpChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) KpPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) KpPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f) else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) KpPalette.coral.copy(alpha = 0.55f) else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

// ── Person row + avatar ────────────────────────────────────────────────────────────

@Composable
private fun PersonRow(p: KnownPerson, thumbUrl: String?, dark: Boolean, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .alpha(if (p.active) 1f else 0.6f)
            .plainClick(onTap)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PersonAvatar(p, thumbUrl, 46.dp, dark)
        Column(Modifier.weight(1f)) {
            Text(p.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            Text("${p.roleLabelBn} • ${p.photoPaths.size}টা ছবি", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        RoleCapsule(p, dark)
        if (!p.active) {
            Text(
                "OFF", color = KpPalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.background(KpPalette.red500.copy(alpha = 0.12f), CircleShape).padding(horizontal = 7.dp, vertical = 3.dp),
            )
        }
        Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 15.sp)
    }
}

@Composable
private fun RoleCapsule(p: KnownPerson, dark: Boolean) {
    val tint = KpPalette.role(p.role, dark)
    Text(
        p.roleLabelBn, color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
private fun PersonAvatar(p: KnownPerson, thumbUrl: String?, size: androidx.compose.ui.unit.Dp, dark: Boolean) {
    Box(
        Modifier.size(size).clip(CircleShape).border(1.dp, KpPalette.coral.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (!thumbUrl.isNullOrEmpty()) {
            AsyncImage(
                model = thumbUrl,
                contentDescription = p.name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(CircleShape),
            )
        } else {
            Box(Modifier.size(size).background(KpPalette.coral.copy(alpha = 0.16f), CircleShape), contentAlignment = Alignment.Center) {
                Text(KpFormat.initials(p.name), color = KpPalette.accentText(dark), fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

// ── Detail sheet (read-only card + native toggle/delete; add/edit stay on the web) ──

@Composable
private fun PersonDetailSheet(
    p: KnownPerson,
    thumbUrl: String?,
    dark: Boolean,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
    openWeb: (String, String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(18.dp).padding(bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            PersonAvatar(p, thumbUrl, 64.dp, dark)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(p.name, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    RoleCapsule(p, dark)
                    Text(
                        if (p.active) "ON" else "OFF",
                        color = if (p.active) KpPalette.green400 else KpPalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background((if (p.active) KpPalette.emerald600 else KpPalette.red500).copy(alpha = 0.12f), CircleShape)
                            .padding(horizontal = 7.dp, vertical = 3.dp),
                    )
                }
            }
        }
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            InfoRow("রেফারেন্স ছবি", "${p.photoPaths.size}টা ছবি", dark)
            p.note?.takeIf { it.isNotEmpty() }?.let { InfoRow("নোট", it, dark) }
            KpFormat.dateTime(p.createdAt)?.let { InfoRow("যোগ হয়েছে", it, dark) }
            Text(
                if (p.active) "এন্ট্রান্স ওয়াচ এই মুখটা চেনে — দেখা গেলে অ্যালার্টে নাম আসবে।"
                else "এই মুখটা এখন OFF — ম্যাচিংয়ে ধরা হবে না।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                if (p.active) "⏸ Inactive করুন" else "▶ Active করুন",
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f).almaGlass(dark, AlmaTheme.R_CONTROL).plainClick(onToggle).padding(vertical = 11.dp),
            )
            Text(
                "🗑 মুছুন",
                color = KpPalette.red500, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier
                    .weight(1f)
                    .background(KpPalette.red500.copy(alpha = 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .border(1.dp, KpPalette.red500.copy(alpha = 0.3f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick(onDelete)
                    .padding(vertical = 11.dp),
            )
        }
        Text(
            "এডিট/ছবি বদল — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick { openWeb("/agent/known-people", "Known people") }.padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun AuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(KpPalette.coral, CircleShape).plainClick(onLogin).padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun ErrorCard(msg: String, dark: Boolean) {
    Text(
        "⚠️ $msg", color = KpPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun NoticeCard(msg: String, dark: Boolean) {
    Text(
        msg, color = AlmaTheme.ink(dark), fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun EmptyState(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(top = 30.dp, start = 10.dp, end = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("👤", fontSize = 34.sp)
        Text(
            "এখনো কেউ যোগ হয়নি। আপনার আর স্টাফদের ছবি যোগ করুন — তাহলে ক্যামেরা চেনা মুখ আলাদা করতে পারবে।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
        )
    }
}
