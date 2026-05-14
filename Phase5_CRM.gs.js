/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ALMA LIFESTYLE ERP — PHASE 5                                          ║
 * ║   CUSTOMER CRM & RISK ENGINE AUTOMATION                                 ║
 * ║   Version 1.0                                                           ║
 * ║                                                                         ║
 * ║   DEPLOY: Add as new file "Phase5_CRM" in Apps Script project.         ║
 * ║   Do NOT replace Phase 2, 3, or 4 files.                               ║
 * ║                                                                         ║
 * ║   ACTIVATION (one-time):                                                ║
 * ║   1. Open Extensions → Apps Script                                      ║
 * ║   2. Click + next to Files → name it "Phase5_CRM"                       ║
 * ║   3. Paste this entire script                                            ║
 * ║   4. Run installPhase5Triggers() once                                   ║
 * ║   5. Done — CRM auto-updates on every order event                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT THIS MODULE DOES:
 *   ✅ Auto-creates customer profile in CUSTOMERS sheet on new order
 *   ✅ Detects duplicate phone numbers — merges, never creates duplicates
 *   ✅ Auto-updates stats (orders, revenue, risk) on every status change
 *   ✅ Auto-segments customers: VIP / Regular / New / Risky / Blacklist / Cold
 *   ✅ Tracks COD fail rate and flags fraudulent patterns
 *   ✅ Calculates CLV score and lifetime value
 *   ✅ Writes risk flags to AUTOMATION LOG for team review
 *   ✅ Daily refresh of all customer metrics at 6 AM
 *   ✅ Weekly risk audit — identifies newly risky customers
 *
 * INTEGRATION:
 *   Reads from:  📦 ORDERS (source of truth for all stats)
 *   Writes to:   👥 CUSTOMERS (profile sheet)
 *   Logs to:     🤖 AUTOMATION LOG
 *   Hooks into:  Phase 2 onOrderDelivered_ / onOrderReturned_ (optional)
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CRM_CONFIG = {
  sheets: {
    ORDERS:    '📦 ORDERS',
    CUSTOMERS: '👥 CUSTOMERS',
    LOG:       '🤖 AUTOMATION LOG',
  },

  // CUSTOMERS sheet: headers start at row 5, data from row 6
  custDataStart: 6,

  // Column indices in CUSTOMERS sheet (1-based)
  cc: {
    CUST_NUM:    1,  // A — auto formula, never write
    NAME:        2,  // B — key identifier
    PHONE:       3,  // C — formula pulls from ORDERS
    DISTRICT:    4,  // D — manual or auto
    ADDRESS:     5,  // E — manual
    WHATSAPP:    6,  // F — formula
    TOTAL_ORDERS:7,  // G — formula
    DELIVERED:   8,  // H — formula
    RETURNED:    9,  // I — formula
    CANCELLED:   10, // J — formula
    PENDING:     11, // K — formula
    TOTAL_SPENT: 12, // L — formula
    AVG_ORDER:   13, // M — formula
    PROFIT:      14, // N — formula
    COD_ORDERS:  15, // O — formula
    COD_FAILS:   16, // P — formula
    COD_FAIL_PCT:17, // Q — formula
    RETURN_RATE: 18, // R — formula
    LAST_ORDER:  19, // S — formula (date)
    DAYS_INACT:  20, // T — formula
    FAV_CAT:     21, // U — formula
    CLV_SCORE:   22, // V — formula
    RISK_SCORE:  23, // W — formula
    RISK_LEVEL:  24, // X — formula
    SEGMENT:     25, // Y — formula
    LOYALTY:     26, // Z — formula
    SOURCE:      27, // AA — formula
    WA_OPTIN:    28, // AB — manual dropdown
    NOTES:       29, // AC — manual
  },

  // ORDERS column map (1-based, matching ERP exactly)
  oc: {
    ORDER_ID:   1,  STATUS:    8,  CUSTOMER: 3,
    PHONE:      4,  ADDRESS:   5,  PAYMENT:  6,
    SOURCE:     7,  PRODUCT:   9,  CATEGORY: 10,
    QTY:        12, UNIT_PRICE:13, SELL:     18,
    PROFIT:     23, DATE:      2,
  },

  // Segmentation thresholds
  thresholds: {
    VIP_SPEND:       10000,  // min lifetime spend for VIP
    VIP_ORDERS:      3,      // min orders for VIP
    VIP_RETURN_MAX:  0.20,   // max return rate for VIP
    REGULAR_SPEND:   3000,   // min spend for Regular
    REGULAR_ORDERS:  2,      // min orders for Regular
    REGULAR_RET_MAX: 0.30,   // max return rate for Regular
    RISKY_SCORE:     40,     // risk score threshold
    BLACKLIST_SCORE: 70,     // auto-blacklist threshold
    COD_FAIL_HIGH:   0.50,   // COD fail rate = high risk
    RETURN_HIGH:     0.30,   // return rate = high
    DORMANT_DAYS:    90,     // days inactive = cold
    NEW_DAYS:        30,     // first order within N days = NEW
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER INSTALLATION
// ═══════════════════════════════════════════════════════════════════════════

function installPhase5Triggers() {
  const existing = ScriptApp.getProjectTriggers();
  const has6am   = existing.some(t => t.getHandlerFunction() === 'runDailyCrmRefresh');
  const hasWeekly= existing.some(t => t.getHandlerFunction() === 'runWeeklyRiskAudit');

  if (!has6am) {
    ScriptApp.newTrigger('runDailyCrmRefresh')
      .timeBased().atHour(6).everyDays(1).create();
  }
  if (!hasWeekly) {
    ScriptApp.newTrigger('runWeeklyRiskAudit')
      .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  }

  crmLog_('SETUP', 'installPhase5Triggers',
    `Triggers: 6am daily=${!has6am?'INSTALLED':'already active'}, Weekly audit=${!hasWeekly?'INSTALLED':'already active'}`, '');

  SpreadsheetApp.getUi().alert(
    '✅ Phase 5 CRM Automation Active\n\n' +
    '• Daily CRM Refresh (6 AM): ' + (!has6am ? 'INSTALLED' : 'already active') + '\n' +
    '• Weekly Risk Audit (Monday 7 AM): ' + (!hasWeekly ? 'INSTALLED' : 'already active') + '\n\n' +
    'The CUSTOMERS sheet auto-updates via ORDERS formulas.\n' +
    'Use menu: ⚡ → CRM → actions for manual operations.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: AUTO-CREATE / UPDATE CUSTOMER PROFILE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a new customer profile row in CUSTOMERS if one doesn't exist.
 * Called automatically when a new order comes in, or can be called manually.
 *
 * SAFE: Phone-based deduplication. If a profile already exists for this
 * customer (matched by name OR phone), nothing is created — it's updated.
 *
 * @param {string} customerName
 * @param {string} phone
 * @param {string} address
 * @param {string} district
 * @param {string} source
 * @returns {number} row number of the profile (existing or new)
 */
function ensureCustomerProfile_(customerName, phone, address, district, source) {
  if (!customerName) return -1;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const custSh= ss.getSheetByName(CRM_CONFIG.sheets.CUSTOMERS);
  if (!custSh) return -1;

  const start = CRM_CONFIG.custDataStart;
  const lastRow = Math.max(custSh.getLastRow(), start - 1);

  // ── Check for existing profile by name (primary) and phone (secondary) ──
  if (lastRow >= start) {
    const nameCol  = custSh.getRange(start, CRM_CONFIG.cc.NAME, lastRow - start + 1, 1).getValues();
    const phoneCol = custSh.getRange(start, CRM_CONFIG.cc.PHONE, lastRow - start + 1, 1).getValues();

    for (let i = 0; i < nameCol.length; i++) {
      const existName  = (nameCol[i][0] || '').toString().trim().toLowerCase();
      const existPhone = (phoneCol[i][0] || '').toString().trim().replace(/\D/g,'');
      const cleanPhone = (phone || '').toString().trim().replace(/\D/g,'');

      if (existName === customerName.toLowerCase().trim() ||
          (cleanPhone && existPhone && existPhone === cleanPhone)) {
        // Profile found — log the match and return its row
        const existRow = start + i;
        // Update address and district if they were empty
        if (!nameCol[i][0]) custSh.getRange(existRow, CRM_CONFIG.cc.NAME).setValue(customerName);
        if (address && !custSh.getRange(existRow, CRM_CONFIG.cc.ADDRESS).getValue()) {
          custSh.getRange(existRow, CRM_CONFIG.cc.ADDRESS).setValue(address);
        }
        if (district && !custSh.getRange(existRow, CRM_CONFIG.cc.DISTRICT).getValue()) {
          custSh.getRange(existRow, CRM_CONFIG.cc.DISTRICT).setValue(district);
        }
        return existRow;
      }
    }
  }

  // ── No existing profile — create one in the next empty row ───────────────
  let newRow = start;
  for (let r = start; r <= lastRow + 1; r++) {
    if (!custSh.getRange(r, CRM_CONFIG.cc.NAME).getValue()) {
      newRow = r;
      break;
    }
  }

  custSh.getRange(newRow, CRM_CONFIG.cc.NAME).setValue(customerName);
  if (address)  custSh.getRange(newRow, CRM_CONFIG.cc.ADDRESS).setValue(address);
  if (district) custSh.getRange(newRow, CRM_CONFIG.cc.DISTRICT).setValue(district);
  custSh.getRange(newRow, CRM_CONFIG.cc.WA_OPTIN).setValue('Pending');

  // All stat columns are formula-driven — no need to write them.
  // The formulas auto-calculate from ORDERS as soon as the name is in column B.

  crmLog_('PROFILE_CREATED', customerName,
    `New profile at row ${newRow}`, `Phone: ${phone} | Source: ${source}`);
  return newRow;
}

/**
 * Hook called from Phase 2 onOrderDelivered_() and onOrderConfirmed_().
 * Ensures the customer has a profile and logs the event.
 *
 * ADD THIS CALL to onOrderConfirmed_() in Code.gs:
 *   onOrderCrmUpdate(rowData[2], rowData[3], rowData[4], '', rowData[6]);
 *
 * @param {string} name
 * @param {string} phone
 * @param {string} address
 * @param {string} district  — can be '' (derived from address)
 * @param {string} source    — Facebook, WhatsApp, etc.
 */
function onOrderCrmUpdate(name, phone, address, district, source) {
  if (!name) return;
  try {
    const profileRow = ensureCustomerProfile_(name, phone, address, district, source);
    if (profileRow > 0) {
      checkAndFlagRisk_(name, profileRow);
    }
  } catch (e) {
    crmLog_('ERROR', name, e.message, 'onOrderCrmUpdate');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RISK DETECTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluates risk factors for a customer and writes flags.
 * Called after each order event and during daily refresh.
 *
 * Risk is computed from ORDERS formulas — this function reads the
 * computed values from CUSTOMERS sheet and adds notes/alerts.
 *
 * @param {string} customerName
 * @param {number} profileRow
 */
function checkAndFlagRisk_(customerName, profileRow) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const custSh = ss.getSheetByName(CRM_CONFIG.sheets.CUSTOMERS);
  if (!custSh || profileRow < CRM_CONFIG.custDataStart) return;

  // Read computed values (formula results)
  const cc  = CRM_CONFIG.cc;
  const row = custSh.getRange(profileRow, 1, 1, 29).getValues()[0];

  const riskScore  = parseFloat(row[cc.RISK_SCORE  - 1]) || 0;
  const segment    = (row[cc.SEGMENT    - 1] || '').toString();
  const codFailPct = parseFloat(row[cc.COD_FAIL_PCT- 1]) || 0;
  const returnRate = parseFloat(row[cc.RETURN_RATE - 1]) || 0;
  const daysInact  = parseFloat(row[cc.DAYS_INACT  - 1]) || 0;

  const flags = [];
  if (codFailPct > CRM_CONFIG.thresholds.COD_FAIL_HIGH)  flags.push('HIGH COD FAIL');
  if (returnRate > CRM_CONFIG.thresholds.RETURN_HIGH)    flags.push('RETURN ABUSER');
  if (daysInact  > CRM_CONFIG.thresholds.DORMANT_DAYS)   flags.push('DORMANT');
  if (riskScore  >= CRM_CONFIG.thresholds.BLACKLIST_SCORE) flags.push('AUTO-BLACKLIST');

  if (flags.length > 0) {
    crmLog_('RISK_FLAG', customerName,
      `Flags: ${flags.join(' | ')} | Score: ${riskScore} | Segment: ${segment}`,
      `Row ${profileRow}`);
  }

  // If auto-blacklisted, write a note to the NOTES column
  if (flags.includes('AUTO-BLACKLIST')) {
    const existNotes = custSh.getRange(profileRow, cc.NOTES).getValue() || '';
    if (!existNotes.includes('AUTO-BLACKLIST')) {
      const note = `AUTO-BLACKLIST ${crmFormatDate_(new Date())} | Score: ${riskScore}`;
      custSh.getRange(profileRow, cc.NOTES).setValue(
        existNotes ? existNotes + ' | ' + note : note
      );
    }
  }
}

/**
 * Detects duplicate phone numbers in the CUSTOMERS sheet.
 * Returns an array of {phone, rows} objects where rows.length > 1.
 * Safe to call anytime — read-only operation.
 */
function detectDuplicatePhones() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const custSh = ss.getSheetByName(CRM_CONFIG.sheets.CUSTOMERS);
  if (!custSh) return [];

  const start   = CRM_CONFIG.custDataStart;
  const lastRow = custSh.getLastRow();
  if (lastRow < start) return [];

  const data  = custSh.getRange(start, CRM_CONFIG.cc.NAME, lastRow - start + 1, 2).getValues();
  const phoneMap = {};

  data.forEach((row, i) => {
    const name  = row[0];
    const phone = (row[1] || '').toString().replace(/\D/g, '');
    if (!name || !phone) return;
    if (!phoneMap[phone]) phoneMap[phone] = [];
    phoneMap[phone].push({ row: start + i, name });
  });

  const dupes = Object.entries(phoneMap)
    .filter(([, entries]) => entries.length > 1)
    .map(([phone, entries]) => ({ phone, entries }));

  return dupes;
}

/**
 * PUBLIC: Show duplicate phone report.
 */
function showDuplicatePhones() {
  const dupes = detectDuplicatePhones();
  if (dupes.length === 0) {
    SpreadsheetApp.getUi().alert('✅ No duplicate phone numbers found in CUSTOMERS sheet.');
    return;
  }
  const lines = dupes.map(d =>
    `Phone ${d.phone}:\n  ${d.entries.map(e => `Row ${e.row}: ${e.name}`).join('\n  ')}`
  );
  SpreadsheetApp.getUi().alert(
    `⚠️ ${dupes.length} duplicate phone(s) found:\n\n${lines.slice(0, 5).join('\n\n')}` +
    (dupes.length > 5 ? `\n\n...and ${dupes.length - 5} more. Check CUSTOMERS sheet.` : '')
  );
  crmLog_('DUPLICATE_CHECK', 'PHONE', `${dupes.length} duplicates found`, dupes.map(d=>d.phone).join(', '));
}

// ═══════════════════════════════════════════════════════════════════════════
// DAILY REFRESH (6 AM trigger)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Runs at 6 AM daily.
 * - Ensures all order customers have profiles
 * - Runs risk check on all customers
 * - Logs segment summary
 */
function runDailyCrmRefresh() {
  crmLog_('DAILY', 'runDailyCrmRefresh', 'Daily CRM refresh started', new Date().toString());

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(CRM_CONFIG.sheets.ORDERS);
  if (!ordSh) return;

  const oc      = CRM_CONFIG.oc;
  const lastRow = ordSh.getLastRow();
  if (lastRow < 3) return;

  // Read all orders at once
  const ordData = ordSh.getRange(3, 1, lastRow - 2, 35).getValues();

  // Build unique customer set from orders
  const seen = new Set();
  let profiled = 0;

  ordData.forEach(row => {
    const name    = row[oc.CUSTOMER - 1];
    const phone   = row[oc.PHONE - 1];
    const address = row[oc.ADDRESS - 1];
    const source  = row[oc.SOURCE - 1];
    if (!name || seen.has(name)) return;
    seen.add(name);

    const profileRow = ensureCustomerProfile_(name, phone, address, '', source);
    if (profileRow > 0) {
      checkAndFlagRisk_(name, profileRow);
      profiled++;
    }
    Utilities.sleep(50); // light rate limiting
  });

  // Segment summary
  const custSh = ss.getSheetByName(CRM_CONFIG.sheets.CUSTOMERS);
  const segCounts = { VIP:0, REGULAR:0, NEW:0, RISKY:0, BLACKLIST:0, COLD:0 };
  if (custSh && custSh.getLastRow() >= CRM_CONFIG.custDataStart) {
    const segs = custSh.getRange(
      CRM_CONFIG.custDataStart, CRM_CONFIG.cc.SEGMENT,
      custSh.getLastRow() - CRM_CONFIG.custDataStart + 1, 1
    ).getValues();
    segs.forEach(([s]) => { if (s && segCounts[s] !== undefined) segCounts[s]++; });
  }

  crmLog_('DAILY', 'runDailyCrmRefresh',
    `Complete. Profiled: ${profiled} | ${Object.entries(segCounts).map(([k,v])=>`${k}:${v}`).join(' ')}`,
    new Date().toString());
}

// ═══════════════════════════════════════════════════════════════════════════
// WEEKLY RISK AUDIT (Monday 7 AM)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Deep risk scan every Monday.
 * Identifies customers who crossed risk thresholds this week.
 * Sends summary to owner email.
 */
function runWeeklyRiskAudit() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const custSh = ss.getSheetByName(CRM_CONFIG.sheets.CUSTOMERS);
  if (!custSh) return;

  const start   = CRM_CONFIG.custDataStart;
  const lastRow = custSh.getLastRow();
  if (lastRow < start) return;

  const cc    = CRM_CONFIG.cc;
  const data  = custSh.getRange(start, 1, lastRow - start + 1, 29).getValues();

  const highRisk   = [];
  const newBlacklist = [];
  const dormant    = [];

  data.forEach(row => {
    const name       = row[cc.NAME      - 1];
    const riskScore  = parseFloat(row[cc.RISK_SCORE - 1]) || 0;
    const segment    = (row[cc.SEGMENT  - 1] || '').toString();
    const daysInact  = parseFloat(row[cc.DAYS_INACT - 1]) || 0;
    const codFail    = parseFloat(row[cc.COD_FAIL_PCT- 1]) || 0;
    if (!name) return;

    if (riskScore >= CRM_CONFIG.thresholds.BLACKLIST_SCORE) newBlacklist.push({ name, riskScore });
    else if (riskScore >= CRM_CONFIG.thresholds.RISKY_SCORE) highRisk.push({ name, riskScore, codFail });
    if (daysInact > CRM_CONFIG.thresholds.DORMANT_DAYS) dormant.push({ name, daysInact });
  });

  // Log summary
  crmLog_('WEEKLY_RISK', 'AUDIT',
    `Blacklist candidates: ${newBlacklist.length} | High risk: ${highRisk.length} | Dormant: ${dormant.length}`,
    `Top blacklist: ${newBlacklist.slice(0,3).map(c=>c.name).join(', ')}`);

  // Email owner
  const ownerEmail = Session.getActiveUser().getEmail();
  if (!ownerEmail) return;

  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMMM yyyy');
  const subject = `Alma Lifestyle CRM — Weekly Risk Report | ${dateStr}`;
  const body = [
    `ALMA LIFESTYLE CRM — WEEKLY RISK AUDIT`,
    `${dateStr}`,
    '',
    `BLACKLIST CANDIDATES (${newBlacklist.length}):`,
    ...newBlacklist.slice(0, 10).map(c => `  ${c.name} — Risk Score: ${c.riskScore}`),
    '',
    `HIGH RISK CUSTOMERS (${highRisk.length}):`,
    ...highRisk.slice(0, 10).map(c => `  ${c.name} — Score: ${c.riskScore} | COD Fail: ${Math.round(c.codFail*100)}%`),
    '',
    `DORMANT CUSTOMERS — 90+ days (${dormant.length}):`,
    ...dormant.slice(0, 8).map(c => `  ${c.name} — ${Math.round(c.daysInact)} days inactive`),
    '',
    `Full details: ${ss.getUrl()}`,
    `— Alma Lifestyle ERP Phase 5 CRM Engine`,
  ].join('\n');

  try {
    GmailApp.sendEmail(ownerEmail, subject, body);
    crmLog_('EMAIL', 'WEEKLY_RISK', `Risk report sent to ${ownerEmail}`, dateStr);
  } catch (e) {
    crmLog_('EMAIL_ERROR', 'WEEKLY_RISK', e.message, ownerEmail);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bulk-creates profiles for all customers found in ORDERS.
 * Safe to run multiple times — existing profiles are never duplicated.
 */
function backfillCustomerProfiles() {
  const ui = SpreadsheetApp.getUi();
  const conf = ui.alert('Backfill Customer Profiles',
    'This will create a profile for every unique customer name in ORDERS.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (conf !== ui.Button.YES) return;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(CRM_CONFIG.sheets.ORDERS);
  if (!ordSh) { ui.alert('ORDERS sheet not found.'); return; }

  const oc      = CRM_CONFIG.oc;
  const lastRow = ordSh.getLastRow();
  const data    = ordSh.getRange(3, 1, lastRow - 2, 10).getValues();

  const seen    = new Set();
  let created = 0, existing = 0;

  data.forEach(row => {
    const name    = row[oc.CUSTOMER - 1];
    const phone   = row[oc.PHONE    - 1];
    const address = row[oc.ADDRESS  - 1];
    const source  = row[oc.SOURCE   - 1];
    if (!name || seen.has(name.toLowerCase())) { if (name) existing++; return; }
    seen.add(name.toLowerCase());

    const result = ensureCustomerProfile_(name, phone, address, '', source);
    if (result > 0) created++;
    Utilities.sleep(100);
  });

  crmLog_('BACKFILL', 'backfillCustomerProfiles',
    `Created: ${created} | Already existed: ${existing}`, '');
  ui.alert(`✅ Customer profile backfill complete.\n\nNew profiles: ${created}\nAlready existed: ${existing}`);
}

/**
 * Manually trigger the risk check for a specific customer.
 */
function runRiskCheckManual() {
  const ui = SpreadsheetApp.getUi();
  const r  = ui.prompt('Risk Check', 'Enter customer name:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const name = r.getResponseText().trim();
  if (!name) return;

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const custSh = ss.getSheetByName(CRM_CONFIG.sheets.CUSTOMERS);
  const start  = CRM_CONFIG.custDataStart;
  const lastRow= custSh.getLastRow();
  let   foundRow = -1;

  const names = custSh.getRange(start, CRM_CONFIG.cc.NAME, lastRow - start + 1, 1).getValues();
  for (let i = 0; i < names.length; i++) {
    if ((names[i][0] || '').toString().toLowerCase() === name.toLowerCase()) {
      foundRow = start + i; break;
    }
  }

  if (foundRow === -1) {
    ui.alert(`❌ Customer "${name}" not found in CUSTOMERS sheet.`);
    return;
  }

  checkAndFlagRisk_(name, foundRow);

  // Read and display segment and risk
  const row       = custSh.getRange(foundRow, 1, 1, 29).getValues()[0];
  const riskScore = row[CRM_CONFIG.cc.RISK_SCORE - 1];
  const riskLevel = row[CRM_CONFIG.cc.RISK_LEVEL - 1];
  const segment   = row[CRM_CONFIG.cc.SEGMENT    - 1];
  const clv       = row[CRM_CONFIG.cc.CLV_SCORE  - 1];
  const totalSpent= row[CRM_CONFIG.cc.TOTAL_SPENT- 1];

  ui.alert(
    `Risk Report: ${name}\n\n` +
    `Segment:    ${segment}\n` +
    `Risk Score: ${riskScore}/100\n` +
    `Risk Level: ${riskLevel}\n` +
    `CLV Score:  ${clv}/100\n` +
    `Total Spent: ৳${totalSpent}\n\n` +
    `Full profile at row ${foundRow} in CUSTOMERS sheet.`
  );
}

/**
 * Show CRM summary statistics.
 */
function showCrmSummary() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const custSh = ss.getSheetByName(CRM_CONFIG.sheets.CUSTOMERS);
  if (!custSh) {
    SpreadsheetApp.getUi().alert('CUSTOMERS sheet not found.');
    return;
  }

  const start   = CRM_CONFIG.custDataStart;
  const lastRow = custSh.getLastRow();
  const total   = Math.max(0, lastRow - start + 1);

  if (total === 0) {
    SpreadsheetApp.getUi().alert('No customer profiles yet. Run Backfill Profiles first.');
    return;
  }

  const segs   = custSh.getRange(start, CRM_CONFIG.cc.SEGMENT, total, 1).getValues();
  const counts = { VIP:0, REGULAR:0, NEW:0, RISKY:0, BLACKLIST:0, COLD:0, other:0 };
  segs.forEach(([s]) => {
    const k = (s||'').toString();
    if (counts[k] !== undefined) counts[k]++;
    else if (k) counts.other++;
  });

  const dupes = detectDuplicatePhones();

  SpreadsheetApp.getUi().alert(
    `CRM SUMMARY — ALMA LIFESTYLE\n\n` +
    `Total customers:   ${total}\n` +
    `VIP:               ${counts.VIP}\n` +
    `Regular:           ${counts.REGULAR}\n` +
    `New:               ${counts.NEW}\n` +
    `Risky:             ${counts.RISKY}\n` +
    `Blacklist:         ${counts.BLACKLIST}\n` +
    `Cold / Dormant:    ${counts.COLD}\n\n` +
    `Duplicate phones:  ${dupes.length > 0 ? dupes.length + ' found!' : 'None'}\n\n` +
    `Open 📊 CRM ANALYTICS for full intelligence view.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════

function crmFormatDate_(date) {
  if (!(date instanceof Date)) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MMM-yyyy');
}

function crmLog_(eventType, reference, message, detail) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const logSh = ss.getSheetByName(CRM_CONFIG.sheets.LOG);
    if (!logSh) return;
    const row = logSh.getLastRow() + 1;
    logSh.getRange(row, 1, 1, 5).setValues([[
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      '[CRM] ' + eventType,
      reference ? reference.toString() : '',
      message   ? message.toString()   : '',
      detail    ? detail.toString().substring(0, 400) : '',
    ]]);
    if (eventType === 'RISK_FLAG' || eventType === 'DUPLICATE_CHECK') {
      logSh.getRange(row, 1, 1, 5).setBackground('#FFF9C4');
    } else if (eventType === 'PROFILE_CREATED') {
      logSh.getRange(row, 1, 1, 5).setBackground('#E8F5E9');
    } else if (eventType.includes('ERROR')) {
      logSh.getRange(row, 1, 1, 5).setBackground('#FFEBEE');
    }
  } catch (e) {
    console.error('crmLog_ failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MENU EXTENSION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Adds CRM sub-menu. Call from the combined onOpen() in Code.gs:
 *   onOpenCrmMenu_(menu);
 */
function onOpenCrmMenu_(existingMenu) {
  return existingMenu
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('👥 CRM Engine')
      .addItem('📋 Backfill Customer Profiles',  'backfillCustomerProfiles')
      .addItem('🔍 Risk Check for Customer',      'runRiskCheckManual')
      .addItem('📞 Show Duplicate Phones',        'showDuplicatePhones')
      .addItem('📊 CRM Summary',                 'showCrmSummary')
      .addSeparator()
      .addItem('🔄 Run Daily CRM Refresh Now',    'runDailyCrmRefresh')
      .addItem('🛡️ Run Weekly Risk Audit Now',   'runWeeklyRiskAudit')
      .addSeparator()
      .addItem('⚡ Install Phase 5 Triggers',     'installPhase5Triggers'));
}

/**
 * REFERENCE ONLY — not registered as onOpen (duplicate onOpen breaks GAS).
 * Merge into your single Code.gs / WebApp_API onOpen, or use WebApp_API.gs.js.
 */
function onOpenTemplate_Phase2345_() {
  const ui   = SpreadsheetApp.getUi();
  const menu = ui.createMenu('⚡ Alma ERP Automation')
    .addItem('🔄 Refresh SLA Status',       'runManualSLARefresh')
    .addItem('📧 Send Test Daily Email',     'testDailySummaryEmail')
    .addItem('📊 View Log Summary',          'viewLogSummary')
    .addSeparator()
    .addItem('⬇️ Backfill Orders (SLA)',     'backfillAllOrders')
    .addSeparator();

  if (typeof onOpenPhase3Menu_ === 'function') onOpenPhase3Menu_(menu);
  if (typeof onOpenInvoiceMenu_ === 'function') onOpenInvoiceMenu_(menu);
  if (typeof onOpenCrmMenu_ === 'function') onOpenCrmMenu_(menu);
  if (typeof onOpenProductionCleanupMenu_ === 'function') {
    onOpenProductionCleanupMenu_(menu);
  }

  menu.addSeparator()
      .addItem('✅ Install All Triggers',    'installTriggers')
      .addItem('⛔ Emergency Stop',          'emergencyStop')
      .addToUi();
}