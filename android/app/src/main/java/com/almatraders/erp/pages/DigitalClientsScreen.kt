//
//  DigitalClientsScreen.kt
//  ALMA ERP — the CDIT Client CRM, ported 1:1 from DigitalClientsSwiftUI.swift
//  (web /digital/clients list + /digital/clients/[id] detail parity).
//
//  Blocks — list: bento hero (client count + service-type split, CDIT-blue wash) ·
//  "+ Add Client" native form · debounced server-side search · contact-style rows
//  (avatar · name · company·service · phone·email · id · notes preview). Detail sheet:
//  billing summary (status badge + payment progress bar + value/paid/due rows) ·
//  native Record-payment · contact card · projects with per-project progress ·
//  payment history. Money is SENSITIVE — endpoints/bodies verbatim from iOS/web:
//    GET  /api/digital/clients?business_id=CREATIVE_DIGITAL_IT&search=…  → { clients }
//    GET  /api/digital/clients/{id}?business_id=CREATIVE_DIGITAL_IT      → { client,
//         summary, projects, invoices, payments, timeline }
//    POST /api/digital/clients  {name, company, phone, email, country, service_type,
//         lead_source, notes, tags, business_id}                         → { ok, error? }
//    POST /api/digital/payments {invoice_id?, project_id?, client_id, client_name,
//         amount, payment_method, payment_type:"income", business_id}    → { ok, error? }
//  Carried lessons: lenient row decoding, shimmer skeletons, no global overlays.
//

package com.almatraders.erp.pages

import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaSession
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.RememberSession
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URLEncoder

private const val CLIENTS_BIZ = "CREATIVE_DIGITAL_IT"

/** Web CDIT_SERVICES verbatim (src/types/cdit.ts). */
private val CDIT_SERVICES = listOf(
    "Website Development", "Facebook Marketing", "SEO",
    "Branding", "Video Editing", "Graphics", "Monthly Retainer",
)

/** Web CDIT_PAYMENT_METHODS verbatim. */
private val CDIT_PAYMENT_METHODS = listOf(
    "Bank Transfer", "bKash", "Nagad", "Cash", "PayPal", "Stripe", "Other",
)

// ── Web palette (exact hexes from tailwind tokens + CDIT accent) ─────────────────────

private object DigitalClientsPalette {
    val cditBlue = Color(0xFF6B8FE0)   // rgb(0.42, 0.56, 0.88)
    val blue400 = Color(0xFF60A5FA)
    val emerald600 = Color(0xFF059669)
    val emerald400 = Color(0xFF34D399)
    val amber600 = Color(0xFFD97706)
    val amber400 = Color(0xFFFBBF24)
    val red500 = Color(0xFFEF4444)
    val slate400 = Color(0xFF94A3B8)
    val zinc500 = Color(0xFF71717A)

    /** Accent text that stays readable on cream (light) and over the aurora (dark). */
    fun accent(dark: Boolean): Color = if (dark) blue400 else cditBlue

    /** Web PaymentProgress STATUS_COLOR: Unpaid zinc · Partial amber · Paid emerald. */
    fun payStatus(status: String?, dark: Boolean): Color = when (status) {
        "Paid" -> if (dark) emerald400 else emerald600
        "Partial Paid" -> if (dark) amber400 else amber600
        else -> if (dark) slate400 else zinc500   // Unpaid / unknown
    }

    /** FinanceSummaryRow highlights: gold→CDIT accent · green emerald · amber. */
    fun highlight(kind: String, dark: Boolean): Color = when (kind) {
        "green" -> if (dark) emerald400 else emerald600
        "amber" -> if (dark) amber400 else amber600
        "red" -> red500
        else -> accent(dark)     // "gold" on the web = brand accent here
    }
}

// ── Models (same snake_case wire fields the web CditClient types declare) ─────────────

/** Non-empty string reader — iOS flexString twin (empty → null). */
private fun JSONObject.strNE(key: String): String? = str(key)?.takeIf { it.isNotEmpty() }

private data class DigitalClient(
    val id: String,
    val name: String,
    val company: String?,
    val phone: String?,
    val email: String?,
    val country: String?,
    val serviceType: String?,
    val leadSource: String?,
    val notes: String?,
    val tags: String?,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject): DigitalClient {
            val name = o.strNE("name") ?: "—"
            val phone = o.strNE("phone")
            val rawId = o.strNE("id")
            return DigitalClient(
                id = rawId ?: "$name-${phone ?: ""}",
                name = name,
                company = o.strNE("company"),
                phone = phone,
                email = o.strNE("email"),
                country = o.strNE("country"),
                serviceType = o.strNE("service_type"),
                leadSource = o.strNE("lead_source"),
                notes = o.strNE("notes"),
                tags = o.strNE("tags"),
                createdAt = o.strNE("created_at"),
            )
        }
    }
}

/** Web CditFinanceFields — shared by the client summary and each project. */
private data class DigitalClientsFinance(
    val totalAmount: Int,
    val totalPaid: Int,
    val dueAmount: Int,
    val paymentPercentage: Double,
    val paymentStatus: String,
) {
    companion object {
        fun from(o: JSONObject): DigitalClientsFinance = DigitalClientsFinance(
            totalAmount = o.flexInt("total_amount") ?: 0,
            totalPaid = o.flexInt("total_paid") ?: 0,
            dueAmount = o.flexInt("due_amount") ?: 0,
            paymentPercentage = o.flexDouble("payment_percentage") ?: 0.0,
            paymentStatus = o.strNE("payment_status") ?: "Unpaid",
        )
    }
}

private data class DigitalClientsProject(
    val id: String,
    val projectName: String,
    val status: String?,
    val serviceType: String?,
    val deadline: String?,
    val totalAmount: Int,
    val totalPaid: Int,
    val dueAmount: Int,
    val paymentPercentage: Double,
    val paymentStatus: String,
) {
    companion object {
        fun from(o: JSONObject): DigitalClientsProject {
            // Web renders `project_name || title` — same fallback chain here.
            val name = o.strNE("project_name") ?: o.strNE("title") ?: "—"
            return DigitalClientsProject(
                id = o.strNE("id") ?: name,
                projectName = name,
                status = o.strNE("status"),
                serviceType = o.strNE("service_type"),
                deadline = o.strNE("deadline"),
                totalAmount = o.flexInt("total_amount") ?: 0,
                totalPaid = o.flexInt("total_paid") ?: 0,
                dueAmount = o.flexInt("due_amount") ?: 0,
                paymentPercentage = o.flexDouble("payment_percentage") ?: 0.0,
                paymentStatus = o.strNE("payment_status") ?: "Unpaid",
            )
        }
    }
}

private data class DigitalClientsPayment(
    val id: String,
    val amount: Int,
    val paymentMethod: String?,
    val transactionId: String?,
    val paymentDate: String?,
    val note: String?,
) {
    companion object {
        fun from(o: JSONObject): DigitalClientsPayment {
            val amount = o.flexInt("amount") ?: 0
            // Web renders `payment_date || date` and `transaction_id || note`.
            val paymentDate = o.strNE("payment_date") ?: o.strNE("date")
            return DigitalClientsPayment(
                id = o.strNE("id") ?: "${paymentDate ?: ""}-$amount",
                amount = amount,
                paymentMethod = o.strNE("payment_method"),
                transactionId = o.strNE("transaction_id"),
                paymentDate = paymentDate,
                note = o.strNE("note") ?: o.strNE("notes"),
            )
        }
    }
}

/** GET /api/digital/clients/{id} — CditClientDetail (timeline ?? payments for history). */
private data class DigitalClientsDetail(
    val client: DigitalClient?,
    val summary: DigitalClientsFinance?,
    val projects: List<DigitalClientsProject>,
    val history: List<DigitalClientsPayment>,
)

// ── State holder (iOS DigitalClientsVM twin) ─────────────────────────────────────────

private class DigitalClientsState {
    var clients by mutableStateOf(listOf<DigitalClient>())
    var search by mutableStateOf("")
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)

    /** Distinct service types across the loaded book — hero split stat. */
    val serviceCount: Int
        get() = clients.mapNotNull { it.serviceType }.toSet().size

    /** Flat `{ clients, total }` — tolerate an apiDataSuccess `{ ok, data:{…} }` wrap. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(
                AlmaApi.getObject(
                    "/api/digital/clients",
                    mapOf(
                        "business_id" to CLIENTS_BIZ,
                        "search" to search.ifEmpty { null },
                    ),
                )
            )
            clients = c.optJSONArray("clients")?.mapObjects { DigitalClient.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Detail sheet payload — one call, same shape the web detail page consumes. */
    suspend fun detail(id: String): DigitalClientsDetail? {
        return try {
            val enc = URLEncoder.encode(id, "UTF-8")
            val c = unwrap(AlmaApi.getObject("/api/digital/clients/$enc", mapOf("business_id" to CLIENTS_BIZ)))
            val timeline = c.optJSONArray("timeline")?.mapObjects { DigitalClientsPayment.from(it) } ?: emptyList()
            val history = timeline.ifEmpty {
                c.optJSONArray("payments")?.mapObjects { DigitalClientsPayment.from(it) } ?: emptyList()
            }
            DigitalClientsDetail(
                client = c.optJSONObject("client")?.let { DigitalClient.from(it) },
                summary = c.optJSONObject("summary")?.let { DigitalClientsFinance.from(it) },
                projects = c.optJSONArray("projects")?.mapObjects { DigitalClientsProject.from(it) } ?: emptyList(),
                history = history,
            )
        } catch (e: Exception) {
            null
        }
    }

    // ── Native writes (owner 2026-07-11) — web page payloads verbatim. ──

    suspend fun createClient(
        name: String, company: String, phone: String, email: String,
        country: String, serviceType: String, leadSource: String, notes: String, tags: String,
    ): Boolean {
        val body = JSONObject()
            .put("name", name).put("company", company).put("phone", phone).put("email", email)
            .put("country", country).put("service_type", serviceType).put("lead_source", leadSource)
            .put("notes", notes).put("tags", tags).put("business_id", CLIENTS_BIZ)
        return write("/api/digital/clients", body, "Client সেভ হয়েছে")
    }

    suspend fun recordPayment(
        clientId: String, clientName: String, amount: Int, method: String,
        invoiceId: String? = null, projectId: String? = null,
    ): Boolean {
        val body = JSONObject()
            .put("client_id", clientId).put("client_name", clientName)
            .put("amount", amount).put("payment_method", method)
            .put("payment_type", "income").put("business_id", CLIENTS_BIZ)
        invoiceId?.let { body.put("invoice_id", it) }
        projectId?.let { body.put("project_id", it) }
        return write("/api/digital/payments", body, "Payment রেকর্ড হয়েছে")
    }

    private suspend fun write(path: String, body: JSONObject, success: String): Boolean {
        return try {
            val res = AlmaApi.send("POST", path, body)
            if (res.flexBool("ok") == true) {
                toast = success
                load()
                true
            } else {
                toast = res.str("error") ?: "সেভ হয়নি — আবার চেষ্টা করুন"
                false
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            false
        } catch (e: Exception) {
            toast = e.message ?: "সেভ হয়নি — আবার চেষ্টা করুন"
            false
        }
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DigitalClientsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    RememberSession()
    val canManage = AlmaSession.canManageBusiness   // client-side role gate (fail-closed)
    val vm = remember { DigitalClientsState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<DigitalClient?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var searchJob by remember { mutableStateOf<Job?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    // Toast auto-dismiss (iOS 2.6s parity).
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) {
            delay(2_600)
            vm.toast = null
        }
    }

    Box(Modifier.fillMaxWidth()) {
        AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Spacer(Modifier.height(6.dp)) }

            item { ClientsHeroCard(vm.clients.size, vm.serviceCount) }

            if (canManage) {
                item {
                    // Web header "+ Add Client" — native form sheet (owner 2026-07-11).
                    // Admin-only write: hidden for non-admins (defense-in-depth).
                    Text(
                        "+ Add Client",
                        color = DigitalClientsPalette.accent(dark),
                        fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                DigitalClientsPalette.cditBlue.copy(alpha = 0.10f),
                                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                            )
                            .border(
                                1.dp, DigitalClientsPalette.cditBlue.copy(alpha = 0.3f),
                                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                            )
                            .plainClick { showCreate = true }
                            .padding(vertical = 11.dp),
                    )
                }
            }

            item {
                // Server-side search, debounced like the web deferred value.
                OutlinedTextField(
                    value = vm.search,
                    onValueChange = { newValue ->
                        vm.search = newValue
                        searchJob?.cancel()
                        searchJob = scope.launch {
                            delay(450)
                            vm.load()
                        }
                    },
                    placeholder = { Text("Search clients…") },
                    leadingIcon = { Text("🔍", fontSize = 13.sp) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (vm.authExpired) {
                item { ClientsAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { item { ClientsNoticeCard("⚠ $it", DigitalClientsPalette.red500, dark) } }

            if (vm.loading && vm.clients.isEmpty()) {
                items(6) {
                    Box(Modifier.fillMaxWidth().height(72.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
                }
            }

            items(vm.clients, key = { it.id }) { c ->
                DigitalClientRow(c, dark) { selected = c }
            }

            if (!vm.loading && vm.clients.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 50.dp, bottom = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("◫", color = AlmaTheme.inkSecondary(dark), fontSize = 34.sp)
                        Text("কোনো ক্লায়েন্ট পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
                        Text("ওয়েবে প্রথম এজেন্সি ক্লায়েন্ট যোগ করুন", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                    }
                }
            }

            item { Spacer(Modifier.height(8.dp)) }
        }
        }

        vm.toast?.let { t ->
            Text(
                t,
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, 20)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    if (showCreate && canManage) {
        ModalBottomSheet(onDismissRequest = { showCreate = false }, containerColor = AlmaTheme.rootBg(dark)) {
            DigitalClientCreateSheet(vm, dark) { showCreate = false }
        }
    }

    selected?.let { c ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            DigitalClientDetailSheet(
                c, vm, dark,
                openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) },
            )
        }
    }
}

// ── Hero anchor (dark in BOTH schemes — Dashboard hero recipe, CDIT-blue wash) ────────

@Composable
private fun ClientsHeroCard(clients: Int, services: Int) {
    Column(Modifier.fillMaxWidth().clientsHeroBg().padding(16.dp)) {
        Text(
            "ক্লায়েন্ট CRM · CDIT",
            color = DigitalClientsPalette.blue400, fontSize = 10.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(8.dp))
        ClientsCountUp(clients, 40.sp, Color.White, format = { "$it" })
        Spacer(Modifier.height(5.dp))
        Text("এজেন্সির মোট ক্লায়েন্ট", color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp)

        Spacer(Modifier.height(14.dp))
        Row {
            ClientsHeroStat("Clients", clients, Color.White, "মোট ক্লায়েন্ট")
            Box(
                Modifier.width(1.dp).height(48.dp).padding(vertical = 2.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            Spacer(Modifier.width(14.dp))
            ClientsHeroStat("Services", services, DigitalClientsPalette.blue400, "সার্ভিস টাইপ")
        }
    }
}

@Composable
private fun ClientsHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(Modifier.padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        ClientsCountUp(value, 20.sp, tint, format = { "$it" })
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** The dark hero backdrop — deep indigo base + CDIT-blue/violet washes. */
private fun Modifier.clientsHeroBg(): Modifier {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    return this
        .clip(shape)
        .background(Color(0xFF151828))   // rgb(0.082, 0.094, 0.157)
        .background(
            Brush.linearGradient(
                0f to DigitalClientsPalette.cditBlue.copy(alpha = 0.34f),
                0.5f to Color.Transparent,
            )
        )
        .background(
            Brush.linearGradient(
                0.5f to Color.Transparent,
                1f to AlmaTheme.violet.copy(alpha = 0.26f),
            )
        )
        .background(
            Brush.radialGradient(
                listOf(AlmaTheme.sage.copy(alpha = 0.12f), Color.Transparent),
                center = Offset(760f, 40f),
                radius = 440f,
            )
        )
        .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
}

/** Count-up number (0 → target on appear) — iOS Animatable count-up twin. */
@Composable
private fun ClientsCountUp(target: Int, fontSize: TextUnit, color: Color, format: (Int) -> String) {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val shown by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "clientsCountUp",
    )
    Text(format(shown), color = color, fontSize = fontSize, fontWeight = FontWeight.ExtraBold, maxLines = 1)
}

// ── Row (web list row: avatar · name · company·service · phone·email · id · notes) ────

@Composable
private fun DigitalClientRow(client: DigitalClient, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ClientsAvatar(client.name, 36.dp, 13.sp, dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    client.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${client.company ?: "—"} · ${client.serviceType ?: "—"}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    contactLine(client),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                client.id,
                color = DigitalClientsPalette.accent(dark), fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        client.notes?.let {
            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

private fun contactLine(c: DigitalClient): String {
    val bits = listOfNotNull(c.phone?.takeIf { it.isNotEmpty() }, c.email?.takeIf { it.isNotEmpty() })
    return if (bits.isEmpty()) "—" else bits.joinToString(" · ")
}

/** Initials circle in the CDIT blue tint. */
@Composable
private fun ClientsAvatar(name: String, diameter: androidx.compose.ui.unit.Dp, fontSize: TextUnit, dark: Boolean) {
    Box(
        Modifier.size(diameter).clip(CircleShape)
            .background(DigitalClientsPalette.cditBlue.copy(alpha = 0.14f))
            .border(1.dp, DigitalClientsPalette.cditBlue.copy(alpha = 0.32f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            initials(name), color = DigitalClientsPalette.accent(dark),
            fontSize = fontSize, fontWeight = FontWeight.Bold,
        )
    }
}

private fun initials(name: String): String {
    val parts = name.split(" ").filter { it.isNotEmpty() }.take(2)
    val letters = parts.mapNotNull { it.firstOrNull()?.toString() }
    return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
}

// ── Detail sheet (web /digital/clients/[id] parity) ──────────────────────────────────

@Composable
private fun DigitalClientDetailSheet(
    client: DigitalClient,
    vm: DigitalClientsState,
    dark: Boolean,
    openWeb: (String, String) -> Unit,
) {
    val canManage = AlmaSession.canManageBusiness   // client-side role gate (fail-closed)
    var detail by remember { mutableStateOf<DigitalClientsDetail?>(null) }
    var loading by remember { mutableStateOf(true) }
    var showPayment by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(client.id) {
        detail = vm.detail(client.id)
        loading = false
    }

    val live = detail?.client ?: client

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header — avatar + name + company·id.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ClientsAvatar(live.name, 44.dp, 15.sp, dark)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(live.name, color = AlmaTheme.ink(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text(
                    listOfNotNull(live.company, live.id).joinToString(" · "),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                )
            }
        }

        if (loading) {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 24.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(Modifier.size(18.dp), color = DigitalClientsPalette.cditBlue, strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        } else {
            ClientsBillingCard(detail?.summary, dark)

            if (canManage) {
                // Web client-detail "Record payment" — native sheet (owner 2026-07-11).
                // Admin-only money write: hidden for non-admins (defense-in-depth).
                Text(
                    "🏦 Record payment",
                    color = if (dark) DigitalClientsPalette.emerald400 else DigitalClientsPalette.emerald600,
                    fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            DigitalClientsPalette.emerald600.copy(alpha = 0.10f),
                            RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                        )
                        .border(1.dp, DigitalClientsPalette.emerald600.copy(alpha = 0.3f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .plainClick { showPayment = true }
                        .padding(vertical = 11.dp),
                )
            }

            ClientsContactCard(live, dark)
            ClientsProjectsCard(detail?.projects ?: emptyList(), dark)
            ClientsHistoryCard(detail?.history ?: emptyList(), dark)
        }

        // + Payment / + Project stay on the web page.
        Text(
            "🌐 পেমেন্ট/প্রজেক্ট যোগ — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick { openWeb("/digital/clients", "CDIT clients") }.padding(vertical = 4.dp),
        )
    }

    if (showPayment && canManage) {
        ModalBottomSheetSimple(dark, onDismiss = { showPayment = false }) {
            DigitalClientPaymentSheet(
                clientId = client.id, clientName = client.name, vm = vm, dark = dark,
                onDone = { showPayment = false; scope.launch { detail = vm.detail(client.id) } },
            )
        }
    }
}

/** Small ModalBottomSheet wrapper (keeps the nested payment sheet tidy). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModalBottomSheetSimple(dark: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = AlmaTheme.rootBg(dark)) { content() }
}

// ── Billing summary (status badge + progress bar + value/paid/due rows) ──────────────

@Composable
private fun ClientsBillingCard(summary: DigitalClientsFinance?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("BILLING SUMMARY", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Spacer(Modifier.weight(1f))
            summary?.let { ClientsStatusBadge(it.paymentStatus, dark) }
        }
        if (summary != null) {
            ClientsProgressBar(summary.paymentPercentage, summary.paymentStatus, dark)
            ClientsFinanceRow("Total project value", summary.totalAmount, "gold", dark)
            ClientsFinanceRow("Total paid", summary.totalPaid, "green", dark)
            ClientsFinanceRow("Due balance", summary.dueAmount, if (summary.dueAmount > 0) "amber" else "green", dark)
        } else {
            Text("কোনো বিলিং ডেটা নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

@Composable
private fun ClientsFinanceRow(label: String, value: Int, highlight: String, dark: Boolean) {
    Row(Modifier.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Spacer(Modifier.weight(1f))
        Text(
            AlmaTheme.taka(value),
            color = DigitalClientsPalette.highlight(highlight, dark),
            fontSize = 14.sp, fontWeight = FontWeight.Bold,
        )
    }
}

// ── Contact card ──────────────────────────────────────────────────────────────────────

@Composable
private fun ClientsContactCard(client: DigitalClient, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("CONTACT", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        ClientsInfoRow("Phone", client.phone ?: "—", dark)
        ClientsInfoRow("Email", client.email ?: "—", dark)
        ClientsInfoRow("Service", client.serviceType ?: "—", dark)
        ClientsInfoRow("Country", client.country ?: "—", dark)
        client.leadSource?.let { ClientsInfoRow("Lead source", it, dark) }
        client.notes?.let {
            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

@Composable
private fun ClientsInfoRow(label: String, value: String, dark: Boolean) {
    Row(verticalAlignment = Alignment.Top) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Spacer(Modifier.weight(1f))
        Text(
            value, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.End, modifier = Modifier.weight(2f),
        )
    }
}

// ── Projects (each: name, id·status, badge, progress, value/paid/due) ────────────────

@Composable
private fun ClientsProjectsCard(projects: List<DigitalClientsProject>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("PROJECTS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        if (projects.isEmpty()) {
            Text(
                "কোনো প্রজেক্ট নেই — ওয়েবে কন্ট্রাক্ট ভ্যালুসহ প্রজেক্ট যোগ করুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        } else {
            projects.forEach { ClientsProjectTile(it, dark) }
        }
    }
}

@Composable
private fun ClientsProjectTile(p: DigitalClientsProject, dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape)
            .background(if (dark) Color.White.copy(alpha = 0.05f) else Color.Black.copy(alpha = 0.03f))
            .border(0.8.dp, AlmaTheme.separator(dark), shape)
            .padding(11.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(p.projectName, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    "${p.id} · ${p.status ?: "—"}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontFamily = FontFamily.Monospace,
                )
            }
            Spacer(Modifier.width(6.dp))
            ClientsStatusBadge(p.paymentStatus, dark)
        }
        ClientsProgressBar(p.paymentPercentage, p.paymentStatus, dark)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ClientsProjectMoney("Value", p.totalAmount, AlmaTheme.inkSecondary(dark), dark)
            ClientsProjectMoney("Paid", p.totalPaid, DigitalClientsPalette.highlight("green", dark), dark)
            ClientsProjectMoney("Due", p.dueAmount, DigitalClientsPalette.highlight("amber", dark), dark)
        }
    }
}

@Composable
private fun ClientsProjectMoney(label: String, value: Int, tint: Color, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        Text(AlmaTheme.taka(value), color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Payment history (web table: ID / Date · Method / Reference / Amount) ─────────────

@Composable
private fun ClientsHistoryCard(history: List<DigitalClientsPayment>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("PAYMENT HISTORY", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        if (history.isEmpty()) {
            Text(
                "এখনো কোনো পেমেন্ট নেই — অ্যাডভান্স/মাইলস্টোন পেমেন্ট ওয়েবে রেকর্ড করুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        } else {
            history.forEach { pay ->
                Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(
                            pay.id, color = DigitalClientsPalette.accent(dark),
                            fontSize = 11.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            listOfNotNull(pay.paymentDate, pay.paymentMethod).joinToString(" · "),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        )
                        (pay.transactionId ?: pay.note)?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        AlmaTheme.taka(pay.amount),
                        color = DigitalClientsPalette.highlight("green", dark),
                        fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

// ── Payment progress bits (web PaymentProgress.tsx twins) ────────────────────────────

@Composable
private fun ClientsProgressBar(percentage: Double, status: String, dark: Boolean) {
    val pct = (percentage / 100.0).coerceIn(0.0, 1.0).toFloat()
    Box(
        Modifier.fillMaxWidth().height(8.dp).clip(CircleShape)
            .background(if (dark) Color.White.copy(alpha = 0.10f) else Color.Black.copy(alpha = 0.08f)),
    ) {
        if (pct > 0f) {
            Box(
                Modifier.fillMaxWidth(pct).height(8.dp).clip(CircleShape)
                    .background(DigitalClientsPalette.payStatus(status, dark)),
            )
        }
    }
}

@Composable
private fun ClientsStatusBadge(status: String, dark: Boolean) {
    val tint = DigitalClientsPalette.payStatus(status, dark)
    Text(
        status.uppercase(),
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp, maxLines = 1,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

// ── Create client (web "New Client" card — POST /api/digital/clients verbatim) ───────

@Composable
private fun DigitalClientCreateSheet(vm: DigitalClientsState, dark: Boolean, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var company by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var country by remember { mutableStateOf("Bangladesh") }
    var leadSource by remember { mutableStateOf("") }
    var tags by remember { mutableStateOf("") }
    var serviceType by remember { mutableStateOf(CDIT_SERVICES.first()) }
    var notes by remember { mutableStateOf("") }
    var serviceMenu by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    val canSubmit = name.trim().isNotEmpty()

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("New Client", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text("Agency client — CRM এ যোগ হবে।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }

        ClientsField(name, "Name *") { name = it }
        ClientsField(company, "Company") { company = it }
        ClientsField(phone, "Phone", KeyboardType.Phone) { phone = it }
        ClientsField(email, "Email", KeyboardType.Email) { email = it }
        ClientsField(country, "Country") { country = it }
        ClientsField(leadSource, "Lead source") { leadSource = it }
        ClientsField(tags, "Tags") { tags = it }

        // Service — dropdown (web CDIT_SERVICES Select).
        Box {
            Row(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick { serviceMenu = true }.padding(horizontal = 12.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(serviceType, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
            DropdownMenu(expanded = serviceMenu, onDismissRequest = { serviceMenu = false }) {
                CDIT_SERVICES.forEach { s ->
                    DropdownMenuItem(text = { Text(s) }, onClick = { serviceType = s; serviceMenu = false })
                }
            }
        }

        ClientsField(notes, "Notes") { notes = it }

        errorText?.let {
            Text(it, color = DigitalClientsPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }

        if (submitting) {
            Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = DigitalClientsPalette.cditBlue, strokeWidth = 2.dp)
            }
        } else {
            Text(
                "Save Client",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        if (canSubmit) DigitalClientsPalette.cditBlue else DigitalClientsPalette.cditBlue.copy(alpha = 0.4f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick {
                        if (canSubmit) {
                            scope.launch {
                                submitting = true
                                errorText = null
                                val ok = vm.createClient(
                                    name = name.trim(), company = company, phone = phone, email = email,
                                    country = country, serviceType = serviceType, leadSource = leadSource,
                                    notes = notes, tags = tags,
                                )
                                submitting = false
                                if (ok) onDone() else errorText = vm.toast
                            }
                        }
                    }
                    .padding(vertical = 14.dp),
            )
        }
    }
}

@Composable
private fun ClientsField(value: String, placeholder: String, keyboard: KeyboardType = KeyboardType.Text, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onValueChange,
        placeholder = { Text(placeholder) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        modifier = Modifier.fillMaxWidth(),
    )
}

// ── Record payment (web client-detail "Record payment" — POST /api/digital/payments) ─

@Composable
private fun DigitalClientPaymentSheet(
    clientId: String,
    clientName: String,
    vm: DigitalClientsState,
    dark: Boolean,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var amount by remember { mutableStateOf("") }
    var method by remember { mutableStateOf(CDIT_PAYMENT_METHODS.first()) }
    var methodMenu by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    val taka = amount.replace(",", "").trim().toDoubleOrNull()?.toInt() ?: 0
    val canSubmit = taka > 0

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Record payment", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 4.dp))
        Text(clientName, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)

        OutlinedTextField(
            value = amount, onValueChange = { amount = it },
            placeholder = { Text("Amount (BDT)") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        Box {
            Row(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick { methodMenu = true }.padding(horizontal = 12.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(method, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
            DropdownMenu(expanded = methodMenu, onDismissRequest = { methodMenu = false }) {
                CDIT_PAYMENT_METHODS.forEach { m ->
                    DropdownMenuItem(text = { Text(m) }, onClick = { method = m; methodMenu = false })
                }
            }
        }

        errorText?.let {
            Text(it, color = DigitalClientsPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }

        if (submitting) {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = DigitalClientsPalette.emerald600, strokeWidth = 2.dp)
            }
        } else {
            Text(
                "Record payment",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        if (canSubmit) DigitalClientsPalette.emerald600 else DigitalClientsPalette.emerald600.copy(alpha = 0.4f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick { if (canSubmit) confirming = true }
                    .padding(vertical = 13.dp),
            )
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("${AlmaTheme.taka(taka)} payment ($method) রেকর্ড করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch {
                        submitting = true
                        errorText = null
                        val ok = vm.recordPayment(clientId, clientName, taka, method)
                        submitting = false
                        if (ok) onDone() else errorText = vm.toast
                    }
                }) { Text("হ্যাঁ, রেকর্ড করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────

@Composable
private fun ClientsNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun ClientsAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(AlmaTheme.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}
