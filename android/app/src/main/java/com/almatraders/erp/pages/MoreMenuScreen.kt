//
//  MoreMenuScreen.kt
//  ALMA ERP — the More tab, ported 1:1 from MoreMenuSwiftUI.swift: premium grouped
//  "inset cards" on the aurora — rounded-26 frosted sections, tinted icon squares,
//  Dark Mode + "Native স্ক্রিন" switches, business switcher, module groups.
//
//  Navigation stays in the host: rows call ctx.openSmart(path, title) — migrated
//  pages open native (AlmaNativeRouter), the rest open the proven web screens.
//

package com.almatraders.erp.pages

import android.app.Activity
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Analytics
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Brush
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Dataset
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Newspaper
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.PersonSearch
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.QueryStats
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Rule
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material.icons.outlined.TrackChanges
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.Wallet
import androidx.compose.material.icons.outlined.Work
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.NativeShell
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.plainClick

// ── Menu data — EXACT copy of the iOS MoreMenuScreen sections/paths ────────────────

private class MenuItem(val title: String, val icon: ImageVector, val path: String)
private class MenuGroup(val header: String, val items: List<MenuItem>)

private val GROUPS = listOf(
    MenuGroup(
        "Agent",
        listOf(
            MenuItem("Live Watch", Icons.Outlined.Visibility, "/agent/live-watch"),
            MenuItem("Credit Usage", Icons.Outlined.QueryStats, "/agent/credit-usage"),
            MenuItem("Subscriptions", Icons.Outlined.Repeat, "/agent/subscriptions"),
        ),
    ),
    MenuGroup(
        "Workspace",
        listOf(
            MenuItem("My Desk", Icons.Outlined.Work, "/portal"),
            MenuItem("Office", Icons.Outlined.Groups, "/portal/office"),
            MenuItem("Product Images", Icons.Outlined.PhotoLibrary, "/agent/catalog-images"),
            MenuItem("Creative Studio", Icons.Outlined.AutoAwesome, "/agent/creative-studio"),
        ),
    ),
    MenuGroup(
        "Money",
        listOf(
            MenuItem("Finance", Icons.Outlined.Wallet, "/finance"),
            MenuItem("Expenses", Icons.Outlined.CreditCard, "/expenses"),
            MenuItem("Payroll", Icons.Outlined.Payments, "/payroll"),
            MenuItem("Invoices", Icons.AutoMirrored.Outlined.ReceiptLong, "/invoice"),
        ),
    ),
    MenuGroup(
        "Operations",
        listOf(
            MenuItem("Inventory", Icons.Outlined.Inventory2, "/inventory"),
            MenuItem("Activity", Icons.Outlined.Bolt, "/activity"),
            MenuItem("Task Spotlight", Icons.Outlined.TrackChanges, "/operations/task-spotlight"),
            MenuItem("Archive", Icons.Outlined.Archive, "/operations/business-archive"),
        ),
    ),
    MenuGroup(
        "People",
        listOf(
            MenuItem("Employees", Icons.Outlined.Group, "/employees"),
            MenuItem("Attendance", Icons.Outlined.CalendarMonth, "/attendance"),
            MenuItem("CRM", Icons.Outlined.HowToReg, "/crm"),
        ),
    ),
    MenuGroup(
        "Insights",
        listOf(
            MenuItem("Analytics", Icons.Outlined.Analytics, "/analytics"),
            MenuItem("Insights", Icons.Outlined.Lightbulb, "/insights"),
            MenuItem("Briefing", Icons.Outlined.Newspaper, "/briefing"),
            MenuItem("Audit", Icons.Outlined.Rule, "/audit"),
        ),
    ),
    MenuGroup(
        "Settings",
        listOf(
            MenuItem("Users", Icons.Outlined.PersonSearch, "/settings/users"),
            MenuItem("Notifications", Icons.Outlined.NotificationsActive, "/settings/notifications"),
            MenuItem("Branding", Icons.Outlined.Brush, "/settings/branding"),
            MenuItem("SMS", Icons.Outlined.Sms, "/settings/sms"),
            MenuItem("Telegram Ops", Icons.AutoMirrored.Outlined.Send, "/settings/telegram-ops"),
            MenuItem("Database", Icons.Outlined.Dataset, "/settings/database"),
            MenuItem("Session", Icons.Outlined.Key, "/settings/session"),
        ),
    ),
)

private class Biz(val name: String, val tagline: String, val letter: String, val color: Color, val path: String)

private val BUSINESSES = listOf(
    Biz("Alma Lifestyle", "Lifestyle", "A", Color(0xFFC9A84C), "/"),
    Biz("Alma Trading", "P2P Operations", "T", Color(0xFF82B299), "/trading"),
    Biz("Creative Digital IT", "Digital Agency", "C", Color(0xFF6B8FE0), "/digital"),
)

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun MoreMenuScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val context = LocalContext.current

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 8.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        Section("Appearance", dark) {
            SwitchRow(
                icon = if (dark) Icons.Outlined.DarkMode else Icons.Outlined.LightMode,
                tint = if (dark) AlmaTheme.violet else Color(0xFFFF9500),
                title = "Dark Mode",
                subtitle = null,
                checked = dark,
                dark = dark,
                accent = AlmaTheme.violet,
            ) {
                AlmaTheme.setDark(context, it)
                NativeShell.applyThemeToWebViews()
            }
            RowDivider()
            SwitchRow(
                icon = Icons.Outlined.Badge,
                tint = AlmaTheme.coral,
                title = "Native স্ক্রিন",
                subtitle = "বন্ধ করলে আগের ওয়েব স্ক্রিন ফিরবে",
                checked = AlmaTheme.nativeScreensOn,
                dark = dark,
                accent = AlmaTheme.coral,
            ) { on ->
                AlmaTheme.setNativeScreens(context, on)
                (context as? Activity)?.recreate()
            }
        }

        Section("Switch business", dark) {
            BUSINESSES.forEachIndexed { i, biz ->
                if (i > 0) RowDivider()
                MenuRow(dark, onClick = { ctx.openSmart(biz.path, biz.name) }) {
                    Box(
                        Modifier.size(32.dp).background(biz.color, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(biz.letter, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(biz.name, color = AlmaTheme.ink(dark), fontSize = 16.sp)
                        Text(biz.tagline, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                    }
                }
            }
        }

        GROUPS.forEach { group ->
            Section(group.header, dark) {
                group.items.forEachIndexed { i, item ->
                    if (i > 0) RowDivider()
                    MenuRow(dark, onClick = { ctx.openSmart(item.path, item.title) }) {
                        Box(
                            Modifier
                                .size(32.dp)
                                .background(
                                    AlmaTheme.violet.copy(alpha = if (dark) 0.18f else 0.12f),
                                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(item.icon, contentDescription = null, tint = AlmaTheme.violet, modifier = Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(12.dp))
                        Text(item.title, color = AlmaTheme.ink(dark), fontSize = 16.sp)
                    }
                }
            }
        }
    }
}

// ── Section / row scaffolding (inset-grouped cards on the aurora) ──────────────────

@Composable
private fun Section(header: String, dark: Boolean, rows: @Composable () -> Unit) {
    Column {
        Text(
            header.uppercase(),
            color = if (dark) Color.White.copy(alpha = 0.72f) else Color.Black.copy(alpha = 0.55f),
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp,
            modifier = Modifier.padding(start = 14.dp, bottom = 7.dp),
        )
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) { rows() }
    }
}

@Composable
private fun RowDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = 58.dp),
        thickness = 0.7.dp,
        color = AlmaTheme.separator(AlmaTheme.isDark),
    )
}

@Composable
private fun MenuRow(dark: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .plainClick(onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) { content() }
        Icon(
            Icons.Outlined.ChevronRight,
            contentDescription = null,
            tint = AlmaTheme.inkTertiary(dark),
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun SwitchRow(
    icon: ImageVector,
    tint: Color,
    title: String,
    subtitle: String?,
    checked: Boolean,
    dark: Boolean,
    accent: Color,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(32.dp)
                .background(tint.copy(alpha = if (dark) 0.18f else 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 16.sp)
            if (subtitle != null) {
                Text(subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedTrackColor = accent,
                checkedThumbColor = Color.White,
            ),
        )
    }
}
