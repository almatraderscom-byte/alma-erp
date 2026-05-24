/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ALMA LIFESTYLE ERP — WEB APP API  (Code.gs)                          ║
 * ║                                                                          ║
 * ║   PASTE THIS AS THE ENTIRE CONTENT OF Code.gs, THEN:                   ║
 * ║   Production: use npm run gas:deploy — redeploys ONE fixed web app URL ║
 * ║   (see config/gas-production-deployment.txt). Never create ad-hoc URLs. ║
 * ║   First-time only: Deploy → New deployment → Web App → Anyone → Deploy ║
 * ║   2. Project Settings → Script Properties → add:                        ║
 * ║        API_SECRET = <same strong secret as Next.js API_SECRET>          ║
 * ║        SPREADSHEET_ID = <optional; Sheet ID if script is not bound>     ║
 * ║   3. Run testCreateOrder() from the editor to verify before going live  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

// ── Sheet names ──────────────────────────────────────────────────────────────
// When the script is container-bound to the Alma workbook, leave SPREADSHEET_ID unset.
// Optional: set Script Property SPREADSHEET_ID for standalone copies (never commit real IDs).
var HARDCODED_SS_ID = '';

var SHEETS = {
  ORDERS:   '📦 ORDERS',
  STOCK:    '📦 STOCK CONTROL',
  COURIER:  '🚚 COURIER TRACKER',
  RETURNS:  '↩️ RETURNS',
  CUSTOMERS:'👥 CUSTOMERS',
  ORDER_ITEMS:'🧾 ORDER ITEMS',
  EXPENSE:  '💸 EXPENSE LEDGER',
  CASH_FLOW:'💰 CASH FLOW',
  LOG:      '🤖 AUTOMATION LOG',
  SETTINGS: '⚙️ SETTINGS',
  EMPLOYEES:'👥 HR EMPLOYEES',
  HR_PAYROLL:'💼 HR PAYROLL',
  AUDIT:'📜 ERP AUDIT LOG',
};

/** PRODUCT MASTER tab aliases — add this sheet to the workbook if missing. */
var PRODUCT_MASTER_ALIASES = ['PRODUCT MASTER', '📋 PRODUCT MASTER', 'Product Master'];

/** First data row on PRODUCT MASTER (row 1 banner, row 2 headers). */
var PM_DATA_START = 3;

// ── ORDERS column numbers (1-based, verified against real sheet) ──────────────
var OC = {
  ORDER_ID:1, DATE:2, CUSTOMER:3, PHONE:4, ADDRESS:5, PAYMENT:6,
  SOURCE:7, STATUS:8, PRODUCT:9, CATEGORY:10, SIZE:11, QTY:12,
  UNIT_PRICE:13, DISCOUNT:14, ADD_DISCOUNT:15, ADV_COST:16,
  ADV_PLATFORM:17,
  SELL_PRICE:18,    // FORMULA — col R  =IF(C="", "", (M*L)-N-O)
  SHIP_COLLECTED:19, COGS:20, COURIER_CHARGE:21, OTHER_COSTS:22,
  PROFIT:23,         // FORMULA — col W  =IF(C="", "", R+S-T-U-V-P)
  COURIER:24, TRACKING_ID:25, TRACKING_STATUS:26,
  EST_DELIVERY:27, ACTUAL_DELIVERY:28, RETURN_REASON:29, RETURN_DATE:30,
  RETURN_STATUS:31, NOTES:32,
  SKU:33,            // FORMULA — col AG =IFERROR(VLOOKUP(I, PRODUCT MASTER, 1, 0), "")
  HANDLED_BY:34,
  CUST_ORDER_NUM:35, // FORMULA — col AI =COUNTIF(C$3:C, C)
  // Automation columns (36-43) written by Phase 2 triggers, not by the API
  INVOICE_NUM:44,
  BUSINESS_ID:45,
};

// Columns that contain formulas — never written by setValues / setFormula on new rows
// Writing to these would overwrite the formula that already propagates from the template row.
// Exception: ORDER_ID (1), SELL_PRICE (18), PROFIT (23) — we write these as explicit formulas.
var FORMULA_SKIP = { 33: true, 35: true }; // SKU VLOOKUP, CUST ORDER #

// Row layout
var ORDERS_DATA_START = 3;   // row 1 = brand header, row 2 = column headers, row 3+ = data
var TOTAL_COLS        = 45;  // columns A through AS (incl. BUSINESS_ID)

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════════════

function doGet(e) {
  try {
    var route  = (e && e.parameter && e.parameter.route) ? e.parameter.route : '';
    var params = (e && e.parameter) ? e.parameter : {};
    if (route !== 'api_health' && !checkSecret_(params.secret)) {
      return respond_({ error: 'Unauthorized' });
    }
    return respond_(routeGet_(route, params));
  } catch (err) {
    return respond_({ error: err.message });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) ? e.postData.contents : '{}');
    Logger.log('doPost route=' + body.route + ' id=' + (body.id || '') + ' keys=' + Object.keys(body).join(','));
    if (!checkSecret_(body.secret)) {
      Logger.log('doPost: UNAUTHORIZED');
      return respond_({ error: 'Unauthorized' });
    }
    var result = routePost_(body);
    Logger.log('doPost result=' + JSON.stringify(result));
    return respond_(result);
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + (err.stack || ''));
    apiLog_('ERROR', 'doPost', err.message, err.stack || '');
    return respond_({ error: err.message });
  }
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTERS
// ═══════════════════════════════════════════════════════════════════════════════

function routeGet_(route, p) {
  switch (route) {
    case 'dashboard':        return getDashboard_(p);
    case 'orders':           return getOrders_(p);
    case 'order':            return getOrder_(p.id);
    case 'customers':        return getCustomers_(p);
    case 'customer':         return getCustomer_(p.name);
    case 'analytics':        return getAnalytics_(p);
    case 'inventory':
    case 'stock':            return getInventory_();
    case 'products':         return getProducts_();
    case 'finance':          return getFinance_(p);
    case 'courier':          return getCourier_();
    case 'log':              return getLog_(parseInt(p.limit || '50', 10));
    case 'sla_alerts':       return getSlaAlerts_();
    case 'next_invoice_num': return getNextInvoiceNum_();
    case 'cdit_dashboard':     return getCditDashboard_(p);
    case 'cdit_clients':       return getCditClients_(p);
    case 'cdit_projects':      return getCditProjects_(p);
    case 'cdit_invoices':      return getCditInvoices_(p);
    case 'cdit_payments':      return getCditPayments_(p);
    case 'cdit_client':        return getCditClientDetail_(p);
    case 'branding':           return getBranding_(p);
    case 'branding_all':       return getAllBranding_();
    case 'financial_report':   return getFinancialReport_(p);
    case 'hr_employees':       return hrListEmployees_(p);
    case 'hr_payroll':         return hrPayrollList_(p);
    case 'hr_dashboard':       return hrDashboard_(p);
    case 'audit_log':          return listAuditLogs_(p);
    case 'api_health':         return apiHealth_();
    default:
      return {
        error: 'Unknown GET route: "' + route + '"',
        available: 'api_health, dashboard, orders, order, finance, hr_employees, hr_payroll, hr_dashboard, audit_log, financial_report, courier, analytics, cdit_*',
      };
  }
}

/** Lightweight probe for uptime/version — no secret required on GET. */
function apiHealth_() {
  var sid = '';
  try {
    sid = ScriptApp.getScriptId();
  } catch (e) {
    sid = '';
  }
  var stamp = typeof GAS_RELEASE_STAMP !== 'undefined' ? GAS_RELEASE_STAMP : null;
  return {
    ok: true,
    route: 'api_health',
    script_id: sid,
    gas_release_stamp: stamp,
    gas_time: new Date().toISOString(),
  };
}

function ensureAuditSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.AUDIT);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.AUDIT);
    sh.getRange(1, 1, 1, 10).setValues([[
      'timestamp_iso', 'route', 'actor', 'actor_role', 'business_id', 'entity_type', 'entity_id', 'summary', 'detail_json', 'status_flag',
    ]]).setFontWeight('bold');
  }
  return sh;
}

function auditAppend_(body, result) {
  try {
    if (!body || !body.route) return;
    var route = String(body.route);
    var bid = resolveBusinessId_(body.business_id || '');
    var actor = String(body.actor || 'Unknown').slice(0, 120);
    var actorRole = String(body.actor_role || '').slice(0, 48);
    var entityType = '';
    var entityId = '';
    var summary = route;
    var ok = !(result && result.error);

    if (route === 'create_order' && result && result.order_id) {
      entityType = 'order';
      entityId = String(result.order_id);
      summary = 'Order created ' + entityId;
    } else if (route === 'update_status') {
      entityType = 'order';
      entityId = String(body.id || '');
      summary = 'Status → ' + String(body.status || '');
    } else if (route === 'update_tracking') {
      entityType = 'order';
      entityId = String(body.id || '');
      summary = 'Tracking updated';
    } else if (route === 'update_field') {
      entityType = 'order';
      entityId = String(body.id || '');
      summary = 'Field ' + String(body.field || '');
    } else if (route === 'add_expense') {
      entityType = 'expense';
      entityId = String(result.expense_id || result.exp_id || '');
      summary = 'Expense ' + String(body.category || '') + ' ৳' + String(body.amount || '');
    } else if (route === 'hr_employee_save') {
      entityType = 'employee';
      entityId = String(result.emp_id || body.emp_id || '');
      summary = 'Employee saved ' + String(body.name || entityId);
    } else if (route === 'hr_patch_employee_salary') {
      entityType = 'employee';
      entityId = String(result.emp_id || body.emp_id || '');
      var prevSal = result.prev_salary != null ? Number(result.prev_salary) : Number(body.prev_salary || 0);
      var newSal = result.new_salary != null ? Number(result.new_salary) : Number(body.monthly_salary || 0);
      summary = 'Salary ৳' + prevSal + ' → ৳' + newSal + ' · ' + entityId;
    } else if (route === 'hr_payroll_add') {
      entityType = 'payroll';
      entityId = String(result.tx_id || '');
      summary = String(body.tx_type || '') + ' ৳' + String(body.amount || '') + ' emp ' + String(body.emp_id || '');
    } else if (route === 'generate_invoice') {
      entityType = 'invoice';
      entityId = String(body.id || '');
      summary = 'Invoice PDF ' + String(result.invoice_number || '');
    } else if (route.indexOf('cdit_') === 0 || route === 'create_client') {
      entityType = 'cdit';
      entityId = String(result.client_id || result.invoice_id || result.payment_id || result.project_id || body.id || '');
      summary = route;
    } else if (route === 'create_product' || route === 'batch_import_product_master' || route.indexOf('inventory_') === 0) {
      entityType = 'inventory';
      entityId = String(result.product_id || result.sku || body.sku || 'batch');
      summary = route;
    } else if (route === 'create_customer') {
      entityType = 'customer';
      entityId = String(body.phone || body.name || '');
      summary = 'Customer ' + String(body.name || '');
    } else if (route === 'save_branding' || route === 'upload_brand_asset') {
      entityType = 'branding';
      entityId = bid;
      summary = route;
    } else if (route.indexOf('trading_') === 0) {
      entityType = 'trading';
      entityId = String(result.drive_file_id || body.account_id || '');
      summary = route;
    }

    var detail = { route: route, keys: Object.keys(body).filter(function (k) { return k !== 'secret'; }) };
    if (route === 'update_status') {
      detail.order_id = String(body.id || '');
      detail.previous_status = String(body.previous_status || '');
      detail.new_status = String(body.status || '');
      detail.reason = String(body.reason || '').slice(0, 500);
      detail.actor_user_id = String(body.actor_user_id || '');
    } else if (route.indexOf('inventory_') === 0) {
      detail.sku = String(body.sku || '');
      detail.reason = String(body.reason || '').slice(0, 500);
      detail.note = String(body.note || '').slice(0, 1000);
      if (route === 'inventory_adjust' && result) {
        detail.before = { stock: result.previous_stock };
        detail.after = { stock: result.new_stock };
        detail.adjustment = result.adjustment;
      }
      if (route === 'inventory_edit') {
        detail.changed_fields = Object.keys(body.data || {});
      }
    } else if (route === 'hr_patch_employee_salary') {
      detail.emp_id = String(body.emp_id || '');
      detail.prev_salary = result && result.prev_salary != null ? Number(result.prev_salary) : null;
      detail.new_salary = result && result.new_salary != null ? Number(result.new_salary) : Number(body.monthly_salary || 0);
      detail.effective_date = String(body.effective_date || '').slice(0, 32);
      detail.reason = String(body.reason || '').slice(0, 500);
      detail.actor_user_id = String(body.actor_user_id || '');
    }
    var sh = ensureAuditSheet_();
    var ts = new Date();
    var iso = Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'");
    sh.appendRow([
      iso, route, actor, actorRole, bid, entityType, entityId, summary.slice(0, 480),
      JSON.stringify(detail).slice(0, 12000), ok ? 'OK' : 'FAIL',
    ]);
    SpreadsheetApp.flush();
  } catch (ignore) { /* never block mutations */ }
}

function listAuditLogs_(p) {
  p = p || {};
  var biz = resolveBusinessId_(p.business_id || '');
  var limit = Math.min(parseInt(p.limit || '100', 10), 400);
  var sh = ensureAuditSheet_();
  var last = sh.getLastRow();
  var rows = [];
  if (last >= 2) {
    var takeFrom = Math.max(2, last - limit + 1);
    var vals = sh.getRange(takeFrom, 1, last - takeFrom + 1, 10).getValues();
    var i;
    for (i = vals.length - 1; i >= 0; i--) {
      var r = vals[i];
      var rowBiz = String(r[4] || '');
      if (biz && rowBiz && rowBiz !== biz) continue;
      rows.push({
        timestamp: String(r[0] || ''),
        route: String(r[1] || ''),
        actor: String(r[2] || ''),
        actor_role: String(r[3] || ''),
        business_id: rowBiz || 'ALMA_LIFESTYLE',
        entity_type: String(r[5] || ''),
        entity_id: String(r[6] || ''),
        summary: String(r[7] || ''),
        detail_json: String(r[8] || ''),
        status_flag: String(r[9] || ''),
      });
    }
  }
  return { audit: rows, total: rows.length };
}

function dispatchRoutePost_(body) {
  switch (body.route) {
    case 'create_order':        return createOrder_(body);
    case 'update_status':       return updateStatus_(body);
    case 'update_tracking':     return updateTracking_(body);
    case 'update_field':        return updateField_(body);
    case 'add_expense':         return addExpense_(body);
    case 'hr_employee_save':    return hrUpsertEmployee_(body);
    case 'hr_patch_employee_salary': return hrPatchEmployeeSalary_(body);
    case 'hr_payroll_add':      return hrPayrollAppend_(body);
    case 'generate_invoice':    return triggerInvoice_(body);
    case 'save_invoice_pdf':    return triggerSaveInvoicePdf_(body);
    case 'create_order_folder': return triggerOrderFolder_(body);
    case 'create_customer':
      if (body.business_id === 'CREATIVE_DIGITAL_IT') return createCditClient_(body);
      return triggerCreateCustomer_(body);
    case 'create_client':
      return createCditClient_(body);
    case 'create_product':      return createProduct_(body);
    case 'batch_import_product_master':
      return batchImportProductMaster_(body);
    case 'inventory_edit':      return inventoryEdit_(body);
    case 'inventory_archive':   return inventoryArchive_(body);
    case 'inventory_restore':   return inventoryRestore_(body);
    case 'inventory_adjust':    return inventoryAdjust_(body);
    case 'inventory_bulk_update': return inventoryBulkUpdate_(body);
    case 'inventory_consolidate_lifestyle': return consolidateLifestyleInventory_(body);
    case 'backfill_sla':
      if (typeof runManualSLARefresh === 'function') runManualSLARefresh();
      return { ok: true };
    case 'cdit_create_client':   return createCditClient_(body);
    case 'cdit_create_project':  return createCditProject_(body);
    case 'cdit_update_project':  return updateCditProject_(body);
    case 'cdit_create_invoice':  return createCditInvoice_(body);
    case 'cdit_update_invoice':  return updateCditInvoiceStatus_(body);
    case 'cdit_create_payment':  return createCditPayment_(body);
    case 'cdit_generate_invoice_pdf': return generateCditInvoicePdf_(body);
    case 'save_branding':        return saveBranding_(body);
    case 'upload_brand_asset':   return uploadBrandAsset_(body);
    case 'trading_upload_screenshot': return tradingUploadScreenshot_(body);
    case 'trading_get_screenshot':    return tradingGetScreenshot_(body);
    case 'trading_delete_screenshots': return tradingDeleteScreenshots_(body);
    case 'trading_cleanup_configure': return configureTradingScreenshotCleanup(body.cleanup_secret, body.cleanup_url);
    case 'trading_cleanup_status': return getTradingScreenshotCleanupStatus(body.expected_secret, body.expected_url);
    case 'trading_cleanup_install_trigger': return installTradingScreenshotCleanupTrigger();
    case 'backup_upload': return backupUpload_(body);
    case 'backup_retention_cleanup': return backupRetentionCleanup_(body);
    default:
      return { error: 'Unknown POST route: "' + body.route + '"' };
  }
}

function routePost_(body) {
  var result = dispatchRoutePost_(body);
  if (body.route !== 'backfill_sla') {
    auditAppend_(body, result);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALMA ERP — GOOGLE DRIVE BACKUPS
// ═══════════════════════════════════════════════════════════════════════════════

var BACKUP_DRIVE_ROOT_NAME = 'ALMA ERP Backups';
var BACKUP_KIND_FOLDER_MAP = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  manual: 'Manual'
};

function backupUpload_(body) {
  body = body || {};
  var kind = String(body.kind || 'daily').toLowerCase();
  var folderName = BACKUP_KIND_FOLDER_MAP[kind] || BACKUP_KIND_FOLDER_MAP.daily;
  var fileName = sanitizeBackupDriveName_(String(body.file_name || 'alma-erp-backup.bin'));
  var mimeType = String(body.mime_type || 'application/octet-stream');
  var data = String(body.data || '');
  var expectedSha = String(body.sha256 || '').toLowerCase();
  var expectedSize = Number(body.size_bytes || 0);
  if (!data) return { ok: false, error: 'backup data required' };
  if (data.length > 45 * 1024 * 1024) return { ok: false, error: 'backup payload too large for Apps Script upload route' };

  var bytes = Utilities.base64Decode(data);
  if (expectedSize && bytes.length !== expectedSize) {
    return { ok: false, error: 'backup size mismatch: expected ' + expectedSize + ', got ' + bytes.length };
  }
  if (expectedSha) {
    var actualSha = sha256Hex_(bytes);
    if (actualSha !== expectedSha) return { ok: false, error: 'backup sha256 mismatch' };
  }

  var root = getOrCreateBackupDriveRoot_();
  var folder = getOrCreateBackupSubfolder_(root, folderName);
  var dateFolder = getOrCreateBackupSubfolder_(folder, Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var file = dateFolder.createFile(blob);
  file.setDescription(JSON.stringify({
    app: 'ALMA ERP',
    backup_kind: kind,
    sha256: expectedSha || '',
    size_bytes: bytes.length,
    created_at: new Date().toISOString()
  }));
  return {
    ok: true,
    drive_file_id: file.getId(),
    drive_folder_id: dateFolder.getId(),
    file_name: fileName,
    size_bytes: bytes.length,
    url: file.getUrl()
  };
}

function backupRetentionCleanup_(body) {
  body = body || {};
  var dailyDays = Number(body.daily_days || 14);
  var weeklyDays = Number(body.weekly_days || 56);
  var monthlyDays = Number(body.monthly_days || 395);
  var root = getOrCreateBackupDriveRoot_();
  var deleted = 0;
  deleted += deleteOldBackupFolders_(getOrCreateBackupSubfolder_(root, 'Daily'), dailyDays);
  deleted += deleteOldBackupFolders_(getOrCreateBackupSubfolder_(root, 'Weekly'), weeklyDays);
  deleted += deleteOldBackupFolders_(getOrCreateBackupSubfolder_(root, 'Monthly'), monthlyDays);
  return { ok: true, deleted: deleted };
}

function deleteOldBackupFolders_(parent, retentionDays) {
  var cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000);
  var folders = parent.getFolders();
  var deleted = 0;
  while (folders.hasNext()) {
    var folder = folders.next();
    if (folder.getDateCreated() < cutoff) {
      folder.setTrashed(true);
      deleted++;
    }
  }
  return deleted;
}

function getOrCreateBackupDriveRoot_() {
  var folders = DriveApp.getFoldersByName(BACKUP_DRIVE_ROOT_NAME);
  var root = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_DRIVE_ROOT_NAME);
  Object.keys(BACKUP_KIND_FOLDER_MAP).forEach(function(kind) {
    getOrCreateBackupSubfolder_(root, BACKUP_KIND_FOLDER_MAP[kind]);
  });
  return root;
}

function getOrCreateBackupSubfolder_(parent, name) {
  var folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function sanitizeBackupDriveName_(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 180) || 'alma-erp-backup.bin';
}

function sha256Hex_(bytes) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return digest.map(function(byte) {
    var v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALMA TRADING — GOOGLE DRIVE SCREENSHOT STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

var TRADING_DRIVE_ROOT_NAME = 'ALMA Trading';

function tradingUploadScreenshot_(body) {
  body = body || {};
  var accountId = String(body.account_id || '').trim();
  var accountName = String(body.account_name || accountId || 'Trading Account').trim();
  var employeeId = String(body.employee_id || '').trim();
  var uploadDate = String(body.upload_date || '').trim();
  var fileName = sanitizeTradingDriveName_(String(body.file_name || 'performance-screenshot.webp'));
  var mimeType = String(body.mime_type || 'image/webp');
  var b64 = String(body.data || body.base64 || '');
  if (b64.indexOf('base64,') >= 0) b64 = b64.split('base64,')[1];
  if (!accountId) return { ok: false, error: 'account_id required' };
  if (!b64) return { ok: false, error: 'data required' };
  if (!/^image\/(jpeg|png|webp)$/i.test(mimeType)) return { ok: false, error: 'Only JPEG, PNG, and WebP are allowed' };

  var date = parseTradingUploadDate_(uploadDate);
  var dateKey = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var root = getOrCreateTradingDriveRoot_();
  var accountFolder = getOrCreateTradingSubfolder_(root, sanitizeTradingDriveName_(accountName));
  var dateFolder = getOrCreateTradingSubfolder_(accountFolder, dateKey);
  var bytes = Utilities.base64Decode(b64);
  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var existing = dateFolder.getFilesByName(fileName);
  while (existing.hasNext()) existing.next().setTrashed(true);
  var file = dateFolder.createFile(blob);
  var expiry = new Date(date.getTime());
  expiry.setDate(expiry.getDate() + 30);
  file.setDescription(JSON.stringify({
    system: 'ALMA_TRADING',
    account_id: accountId,
    employee_id: employeeId,
    upload_date: dateKey,
    expiry_date: Utilities.formatDate(expiry, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'")
  }));
  return {
    ok: true,
    drive_file_id: file.getId(),
    drive_folder_id: dateFolder.getId(),
    preview_url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    file_name: file.getName(),
    size_bytes: bytes.length,
    expiry_date: Utilities.formatDate(expiry, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'")
  };
}

function tradingGetScreenshot_(body) {
  body = body || {};
  var fileId = String(body.drive_file_id || '').trim();
  if (!fileId) return { ok: false, error: 'drive_file_id required' };
  var file = DriveApp.getFileById(fileId);
  if (file.isTrashed()) return { ok: false, error: 'Screenshot file is deleted' };
  var blob = file.getBlob();
  return {
    ok: true,
    file_name: file.getName(),
    mime_type: blob.getContentType(),
    base64: Utilities.base64Encode(blob.getBytes())
  };
}

function tradingDeleteScreenshots_(body) {
  body = body || {};
  var ids = body.drive_file_ids || [];
  if (!Array.isArray(ids)) ids = String(ids || '').split(',');
  var deleted = 0;
  var missing = 0;
  var errors = [];
  ids.forEach(function(raw) {
    var id = String(raw || '').trim();
    if (!id) return;
    try {
      var file = DriveApp.getFileById(id);
      if (file.isTrashed()) {
        missing++;
      } else {
        file.setTrashed(true);
        deleted++;
      }
    } catch (e) {
      missing++;
      errors.push(id + ': ' + e.message);
    }
  });
  return { ok: true, deleted: deleted, missing: missing, errors: errors.slice(0, 20) };
}

function installTradingScreenshotCleanupTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  var hasCleanup = existing.some(function(t) { return t.getHandlerFunction() === 'runTradingScreenshotCleanup'; });
  if (!hasCleanup) {
    ScriptApp.newTrigger('runTradingScreenshotCleanup').timeBased().atHour(3).everyDays(1).create();
  }
  return { ok: true, installed: !hasCleanup };
}

function configureTradingScreenshotCleanup(secret, url) {
  if (!secret) throw new Error('secret required');
  if (!url) throw new Error('url required');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('TRADING_SCREENSHOT_CLEANUP_SECRET', String(secret));
  props.setProperty('TRADING_SCREENSHOT_CLEANUP_URL', String(url).replace(/\/$/, ''));
  return getTradingScreenshotCleanupStatus(String(secret), String(url).replace(/\/$/, ''));
}

function getTradingScreenshotCleanupStatus(expectedSecret, expectedUrl) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('TRADING_SCREENSHOT_CLEANUP_SECRET') || '';
  var url = props.getProperty('TRADING_SCREENSHOT_CLEANUP_URL') || '';
  var triggers = ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'runTradingScreenshotCleanup'; })
    .map(function(t) {
      return {
        handler: t.getHandlerFunction(),
        event_type: String(t.getEventType()),
        trigger_source: String(t.getTriggerSource())
      };
    });
  return {
    ok: true,
    has_secret: !!secret,
    secret_matches_expected: expectedSecret ? secret === String(expectedSecret) : null,
    cleanup_url: url,
    url_matches_expected: expectedUrl ? url === String(expectedUrl).replace(/\/$/, '') : null,
    trigger_count: triggers.length,
    triggers: triggers
  };
}

function runTradingScreenshotCleanup() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('TRADING_SCREENSHOT_CLEANUP_URL') || props.getProperty('NEXT_PUBLIC_APP_URL') || '';
  var secret = props.getProperty('TRADING_SCREENSHOT_CLEANUP_SECRET') || props.getProperty('CRON_SECRET') || '';
  if (!url || !secret) throw new Error('Set TRADING_SCREENSHOT_CLEANUP_URL and TRADING_SCREENSHOT_CLEANUP_SECRET script properties.');
  var endpoint = url.replace(/\/$/, '') + '/api/trading/screenshots/cleanup';
  var res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    muteHttpExceptions: true,
    headers: { 'x-cron-secret': secret },
    contentType: 'application/json',
    payload: JSON.stringify({ source: 'gas_daily_trigger' })
  });
  var text = res.getContentText();
  if (res.getResponseCode() >= 300) throw new Error('Trading screenshot cleanup failed: ' + text);
  return JSON.parse(text);
}

function getOrCreateTradingDriveRoot_() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('TRADING_DRIVE_ROOT_ID');
  if (cached) {
    try { return DriveApp.getFolderById(cached); } catch (e) {}
  }
  var folders = DriveApp.getFoldersByName(TRADING_DRIVE_ROOT_NAME);
  var root = folders.hasNext() ? folders.next() : DriveApp.createFolder(TRADING_DRIVE_ROOT_NAME);
  props.setProperty('TRADING_DRIVE_ROOT_ID', root.getId());
  return root;
}

function getOrCreateTradingSubfolder_(parent, name) {
  var clean = sanitizeTradingDriveName_(name || 'Unassigned');
  var existing = parent.getFoldersByName(clean);
  return existing.hasNext() ? existing.next() : parent.createFolder(clean);
}

function sanitizeTradingDriveName_(name) {
  return String(name || 'Trading').replace(/[\\/:*?"<>|#%\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Trading';
}

function parseTradingUploadDate_(value) {
  var d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE ORDER  ← the primary fix
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Appends a new row to the ORDERS sheet.
 *
 * Key fixes vs previous version:
 *  1. Uses a plain loop instead of Array(44).fill('') — fill() is unreliable
 *     in Apps Script and caused the silent crash.
 *  2. Skips formula columns 33 (SKU VLOOKUP) and 35 (CUST ORDER #) — writing
 *     values there overwrites the formulas that auto-populate from the template.
 *  3. Writes ORDER_ID, SELL_PRICE, PROFIT as explicit cell formulas AFTER the
 *     row is appended, not as part of setValues.
 *  4. Returns a meaningful error string if the sheet is missing.
 */
function createOrder_(body) {
  // ── Validate required fields ─────────────────────────────────────────────
  var items = normalizeOrderItems_(body);
  var required = ['customer', 'phone', 'payment', 'source'];
  for (var i = 0; i < required.length; i++) {
    if (!body[required[i]] && body[required[i]] !== 0) {
      return { error: 'Missing required field: ' + required[i] };
    }
  }
  if (!items.length && !body.product) return { error: 'Missing required field: product' };
  var stock = items.length ? getStockRowsBySku_() : null;
  if (items.length) validateOrderInventory_(items, stock);

  // ── Get sheet ─────────────────────────────────────────────────────────────
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.ORDERS);
  if (!sh) return { error: 'ORDERS sheet not found. Check sheet name: "' + SHEETS.ORDERS + '"' };

  // ── Find the next empty data row ──────────────────────────────────────────
  // getLastRow() returns the last row with ANY content, including formula rows.
  // We want the row after the last row that has a customer name.
  var lastRow = sh.getLastRow();
  var newRow  = lastRow + 1;

  // Safety: if the sheet has pre-filled formula rows beyond the data,
  // find the actual last row with customer data.
  if (lastRow >= ORDERS_DATA_START) {
    var customerCol = sh.getRange(ORDERS_DATA_START, OC.CUSTOMER, lastRow - ORDERS_DATA_START + 1, 1).getValues();
    var actualLast  = ORDERS_DATA_START - 1;
    for (var r = 0; r < customerCol.length; r++) {
      if (customerCol[r][0] !== '') actualLast = ORDERS_DATA_START + r;
    }
    newRow = actualLast + 1;
  }

  // ── Build the row array ───────────────────────────────────────────────────
  // IMPORTANT: use a plain loop — Array(n).fill() crashes in some GAS runtimes.
  var row = [];
  for (var c = 0; c < TOTAL_COLS; c++) row.push('');

  var today = new Date();
  var totalQty = items.length ? items.reduce(function(a, it){ return a + it.qty; }, 0) : Number(body.qty) || 1;
  var subtotal = items.length ? items.reduce(function(a, it){ return a + it.subtotal; }, 0) : (Number(body.unit_price) || 0) * totalQty;
  var discount = Number(body.discount || 0);
  var inventoryCost = items.length ? items.reduce(function(a, it){ return a + (Number(it.cogs || 0) * Number(it.qty || 0)); }, 0) : Number(body.cogs || 0);
  var courierCost = Number(body.courier_charge || 0);
  var estimatedProfit = Number(body.estimated_profit != null ? body.estimated_profit : (Math.max(0, subtotal - discount - Number(body.add_discount || 0)) - inventoryCost - courierCost - Number(body.other_costs || 0) - Number(body.adv_cost || 0)));
  var firstItem = items[0] || null;
  var productSummary = firstItem
    ? firstItem.product + (items.length > 1 ? ' + ' + (items.length - 1) + ' more' : '')
    : String(body.product || '').trim();

  // Columns written as values (0-indexed in the array):
  row[OC.DATE          - 1] = today;
  row[OC.CUSTOMER      - 1] = String(body.customer  || '').trim();
  row[OC.PHONE         - 1] = String(body.phone     || '').trim();
  row[OC.ADDRESS       - 1] = String(body.address   || '').trim();
  row[OC.PAYMENT       - 1] = String(body.payment   || '');
  row[OC.SOURCE        - 1] = String(body.source    || '');
  row[OC.STATUS        - 1] = String(body.status    || 'Pending');
  row[OC.PRODUCT       - 1] = productSummary;
  row[OC.CATEGORY      - 1] = firstItem ? firstItem.category : String(body.category  || '');
  row[OC.SIZE          - 1] = firstItem ? (firstItem.size || firstItem.variant) : String(body.size      || '');
  row[OC.QTY           - 1] = totalQty;
  row[OC.UNIT_PRICE    - 1] = totalQty > 0 ? subtotal / totalQty : subtotal;
  row[OC.DISCOUNT      - 1] = discount;
  row[OC.ADD_DISCOUNT  - 1] = Number(body.add_discount || 0);
  row[OC.ADV_COST      - 1] = Number(body.adv_cost  || 0);
  row[OC.ADV_PLATFORM  - 1] = String(body.adv_platform || '');
  // OC.SELL_PRICE (18) — written as formula below, leave blank here
  row[OC.SHIP_COLLECTED - 1]= Number(body.shipping_fee   || 0);
  row[OC.COGS          - 1] = inventoryCost;
  row[OC.COURIER_CHARGE - 1]= Number(body.courier_charge || 0);
  row[OC.OTHER_COSTS   - 1] = Number(body.other_costs    || 0);
  // OC.PROFIT (23) — written as formula below, leave blank here
  row[OC.COURIER       - 1] = String(body.courier   || '');
  row[OC.TRACKING_ID   - 1] = '';
  row[OC.TRACKING_STATUS-1] = 'Pending';
  row[OC.NOTES         - 1] = buildOrderNotes_(body, items);
  // OC.SKU (33) — formula column, leave blank (VLOOKUP fills it)
  row[OC.HANDLED_BY    - 1] = String(body.handled_by || '');
  row[OC.BUSINESS_ID   - 1] = resolveBusinessId_(body.business_id || '');
  // OC.CUST_ORDER_NUM (35) — formula column, leave blank

  // ── Write the row ─────────────────────────────────────────────────────────
  sh.getRange(newRow, 1, 1, TOTAL_COLS).setValues([row]);

  // ── Apply date format ─────────────────────────────────────────────────────
  sh.getRange(newRow, OC.DATE).setNumberFormat('DD-MMM-YYYY');

  // ── Write formula columns as formulas ─────────────────────────────────────
  // ORDER_ID  — col A: =IF(C{n}="", "", TEXT(ROW()-2, "AL-0000"))
  sh.getRange(newRow, OC.ORDER_ID).setFormula(
    '=IF(C' + newRow + '="","",TEXT(ROW()-2,"AL-0000"))'
  );

  // SELL_PRICE — col R: =(unit_price × qty) - discount - add_discount
  sh.getRange(newRow, OC.SELL_PRICE).setFormula(
    '=IF(C' + newRow + '="","",IFERROR((M' + newRow + '*L' + newRow + ')-N' + newRow + '-O' + newRow + ',0))'
  );

  // PROFIT — col W: seller price after discounts - inventory cost - courier/other/advance costs.
  sh.getRange(newRow, OC.PROFIT).setFormula(
    '=IF(C' + newRow + '="","",IFERROR(ROUND(R' + newRow + '-T' + newRow + '-U' + newRow + '-V' + newRow + '-P' + newRow + ',0),0))'
  );

  // ── Flush and read back the generated Order ID ────────────────────────────
  SpreadsheetApp.flush();
  var orderId = sh.getRange(newRow, OC.ORDER_ID).getValue();

  // Fallback: if the formula hasn't resolved yet (cold evaluation), derive it
  if (!orderId) {
    orderId = 'AL-' + String(newRow - 2).padStart(4, '0');
  }

  if (items.length) {
    appendOrderItems_(orderId, items);
    applyOrderInventoryDeductions_(items, stock);
  }

  enqueueDeferredOrderCrmHook_({
    customer: String(body.customer || '').trim(),
    phone: String(body.phone || '').trim(),
    address: String(body.address || '').trim(),
    source: String(body.source || '').trim(),
    order_id: orderId,
  });

  // ── Compute profit for response (formula in sheet may not resolve yet) ───────
  var sellPrice   = items.length ? Math.max(0, subtotal - discount - Number(body.add_discount || 0)) : Number(body.sell_price) || (Number(body.unit_price) * Number(body.qty));
  var profit      = Number(body.estimated_profit != null ? body.estimated_profit : (sellPrice
                  - Number(body.cogs            || 0)
                  - Number(body.courier_charge  || 0)
                  - Number(body.other_costs     || 0)
                  - Number(body.adv_cost        || 0)));

  // ── Log the event ─────────────────────────────────────────────────────────
  apiLog_('CREATE_ORDER', orderId, productSummary + ' × ' + totalQty + ' | profit=' + Math.round(profit), 'Row ' + newRow);

  return { ok: true, order_id: orderId, profit: Math.round(profit), row: newRow, items_count: items.length || 1 };
}

function normalizeOrderItems_(body) {
  var raw = body && body.items;
  if (!raw || !raw.length) return [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i] || {};
    var qty = Number(item.qty || 0);
    var unit = Number(item.sell_price != null ? item.sell_price : item.unit_price || 0);
    var sku = String(item.stock_sku || item.sku || item.product_code || '').trim();
    var product = String(item.product || item.product_name || '').trim();
    if (!product) throw new Error('Item ' + (i + 1) + ': product is required');
    if (!sku) throw new Error('Item ' + (i + 1) + ': inventory SKU is required');
    if (!qty || qty < 1) throw new Error('Item ' + (i + 1) + ': qty must be at least 1');
    if (!unit || unit <= 0) throw new Error('Item ' + (i + 1) + ': selling price must be greater than 0');
    out.push({
      line_no: Number(item.line_no || (i + 1)),
      product_code: String(item.product_code || sku),
      product: product,
      category: String(item.category || ''),
      size: String(item.size || ''),
      variant: String(item.variant || ''),
      qty: qty,
      unit_price: unit,
      sell_price: unit,
      subtotal: Number(item.subtotal || (unit * qty)),
      sku: sku,
      stock_sku: sku,
      cogs: Number(item.cogs || 0),
      collection_code: String(item.collection_code || ''),
      collection_type: String(item.collection_type || ''),
      size_group: String(item.size_group || ''),
      variant_group: String(item.variant_group || ''),
    });
  }
  return remapOrderItemsToLifestylePools_(out);
}

function buildOrderNotes_(body, items) {
  var notes = String(body.notes || '');
  var inventoryCost = items.length ? items.reduce(function(a, it){ return a + (Number(it.cogs || 0) * Number(it.qty || 0)); }, 0) : Number(body.inventory_cost || body.cogs || 0);
  var courierCost = Number(body.courier_cost != null ? body.courier_cost : body.courier_charge || 0);
  var estimatedProfit = Number(body.estimated_profit != null ? body.estimated_profit : 0);
  if (!items.length && !estimatedProfit && !inventoryCost && !courierCost) return notes;
  var meta = {
    items_count: items.length,
    paid_amount: Number(body.paid_amount || 0),
    due_amount: Number(body.due_amount || 0),
    estimatedProfit: estimatedProfit,
    realizedProfit: 0,
    reversedProfit: 0,
    courierCost: courierCost,
    inventoryCost: inventoryCost,
    accountingStatus: 'ESTIMATED',
    stockRestored: false,
    items: items,
  };
  return (notes ? notes + '\n' : '') + 'ORDER_ITEMS_JSON:' + JSON.stringify(meta);
}

function getStockRowsBySku_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.STOCK);
  if (!sh) throw new Error('STOCK sheet not found');
  var SSTART = 3;
  var last = sh.getLastRow();
  var map = {};
  if (last >= SSTART) {
    var rows = sh.getRange(SSTART, 1, last - SSTART + 1, 20).getValues();
    for (var i = 0; i < rows.length; i++) {
      var sku = String(rows[i][0] || '').trim().toLowerCase();
      if (sku) map[sku] = { sh: sh, row: SSTART + i, data: rows[i] };
    }
  }
  return map;
}

function stockItemFromRow_(row) {
  return {
    sku: String(row[0] || ''),
    product: String(row[1] || ''),
    category: String(row[2] || ''),
    color: String(row[3] || ''),
    size: String(row[4] || ''),
    opening: Number(row[5] || 0),
    purchased: Number(row[6] || 0),
    sold: Number(row[7] || 0),
    returned: Number(row[8] || 0),
    damaged: Number(row[9] || 0),
    reserved: Number(row[10] || 0),
    current_stock: Number(row[11] || 0),
    available: Number(row[12] || 0),
    reorder_level: Number(row[13] || 0),
    status: String(row[14] || ''),
    stock_value: Number(row[15] || 0),
    sell_value: Number(row[16] || 0),
    potential_profit: Number(row[17] || 0),
  };
}

function rowIsArchived_(row) {
  var meta = parseStockMeta_(row[19]);
  return !!meta.archived || meta.active === false || String(row[14] || '').toUpperCase().indexOf('ARCHIVED') !== -1;
}

function resolveLifestyleCollectionStock_(item, stockMap) {
  var type = String(item.collection_type || '').trim().toUpperCase();
  var code = String(item.collection_code || item.product_code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code || (type !== 'MEN' && type !== 'WOMEN')) return null;

  var matches = [];
  Object.keys(stockMap).forEach(function(key) {
    var ref = stockMap[key];
    var rowItem = stockItemFromRow_(ref.data);
    var meta = mergeStockMeta_(inferCollectionStockMeta_(rowItem), parseStockMeta_(ref.data[19]));
    if (String(meta.collectionCode || '').toUpperCase() === code && String(meta.collectionType || '').toUpperCase() === type) {
      matches.push({ ref: ref, item: rowItem, meta: meta, archived: rowIsArchived_(ref.data) });
    }
  });

  function pick(predicate, includeArchived) {
    for (var i = 0; i < matches.length; i++) {
      if (!includeArchived && matches[i].archived) continue;
      if (predicate(matches[i])) return matches[i].ref;
    }
    return null;
  }

  if (type === 'MEN') {
    var group = String(item.size_group || sizeGroupForOrderSize_(item.size || '') || '').toUpperCase();
    if (!group) return null;
    return pick(function(m) {
      return String(m.meta.sizeGroup || m.meta.sizeCategory || m.item.size || '').toUpperCase() === group
        || String(m.item.sku || '').toUpperCase() === smartFashionSku_(code, group, '');
    }, false) || pick(function(m) {
      return String(m.item.size || '').trim() === String(item.size || '').trim();
    }, false) || pick(function(m) {
      return String(m.meta.sizeGroup || m.meta.sizeCategory || m.item.size || '').toUpperCase() === group;
    }, true);
  }

  var variant = normalizeWomenVariantGroup_(item.variant_group || item.variant || item.size || '');
  if (!variant) return null;
  return pick(function(m) {
    return String(m.meta.variantGroup || m.item.size || m.item.color || '').toUpperCase() === variant
      || String(m.item.sku || '').toUpperCase() === smartFashionSku_(code, '', variant);
  }, false) || pick(function(m) {
    return String(m.meta.variantGroup || '').toUpperCase() === variant;
  }, true);
}

function remapOrderItemsToLifestylePools_(items) {
  if (!items || !items.length) return items;
  var stock = getStockRowsBySku_();
  items.forEach(function(item) {
    var ref = resolveLifestyleCollectionStock_(item, stock);
    if (!ref) return;
    var sku = String(ref.data[0] || '').trim();
    if (!sku) return;
    item.sku = sku;
    item.stock_sku = sku;
    if (!item.product) item.product = String(ref.data[1] || '');
    if (!item.category) item.category = String(ref.data[2] || '');
    if (!item.cogs) item.cogs = stockBuyingPrice_(stockItemFromRow_(ref.data));
    if (String(item.collection_type || '').toUpperCase() === 'MEN') {
      item.size_group = item.size_group || sizeGroupForOrderSize_(item.size || '');
    }
    if (String(item.collection_type || '').toUpperCase() === 'WOMEN') {
      item.variant_group = normalizeWomenVariantGroup_(item.variant_group || item.variant || '');
    }
  });
  return items;
}

function orderInventoryDemand_(items) {
  var demand = {};
  for (var i = 0; i < items.length; i++) {
    var sku = String(items[i].stock_sku || items[i].sku || '').trim().toLowerCase();
    if (!sku) continue;
    demand[sku] = (demand[sku] || 0) + Number(items[i].qty || 0);
  }
  return demand;
}

function validateOrderInventory_(items, stock) {
  if (!items.length) return;
  var map = stock || getStockRowsBySku_();
  var demand = orderInventoryDemand_(items);
  Object.keys(demand).forEach(function(sku) {
    if (!map[sku]) throw new Error('Inventory SKU not found: ' + sku);
    var available = Number(map[sku].data[12] || 0);
    if (demand[sku] > available) {
      throw new Error('Insufficient stock for ' + map[sku].data[0] + ': requested ' + demand[sku] + ', available ' + available);
    }
  });
}

/** Deduct stock for order items; skips missing SKUs with a warning (revert / edge cases). */
function applyOrderInventoryDeductionsLenient_(items, stock, warnings) {
  if (!items.length) return;
  var map = stock || getStockRowsBySku_();
  var demand = orderInventoryDemand_(items);
  var touched = {};
  Object.keys(demand).forEach(function(sku) {
    var ref = map[sku];
    if (!ref) {
      if (warnings) warnings.push('SKU not found: ' + sku);
      return;
    }
    var qty = demand[sku];
    var sold = Number(ref.data[7] || 0) + qty;
    var current = Math.max(0, Number(ref.data[11] || 0) - qty);
    var available = Math.max(0, Number(ref.data[12] || 0) - qty);
    var reorder = Number(ref.data[13] || 0);
    var status = available <= 0 ? '❌ OUT OF STOCK' : available <= reorder ? '⚠️ LOW STOCK' : '✅ IN STOCK';
    ref.data[7] = sold;
    ref.data[11] = current;
    ref.data[12] = available;
    ref.data[14] = status;
    var rowKey = ref.sh.getSheetId() + ':' + ref.row;
    touched[rowKey] = ref;
  });
  Object.keys(touched).forEach(function(rowKey) {
    var ref = touched[rowKey];
    var slice = ref.sh.getRange(ref.row, 8, 1, 8).getValues()[0];
    slice[0] = ref.data[7];
    slice[4] = ref.data[11];
    slice[5] = ref.data[12];
    slice[7] = ref.data[14];
    ref.sh.getRange(ref.row, 8, 1, 8).setValues([slice]);
  });
  SpreadsheetApp.flush();
}

function applyOrderInventoryDeductions_(items, stock) {
  if (!items.length) return;
  var map = stock || getStockRowsBySku_();
  var demand = orderInventoryDemand_(items);
  var touched = {};
  Object.keys(demand).forEach(function(sku) {
    var ref = map[sku];
    if (!ref) throw new Error('Inventory SKU not found while deducting: ' + sku);
    var qty = demand[sku];
    var sold = Number(ref.data[7] || 0) + qty;
    var current = Math.max(0, Number(ref.data[11] || 0) - qty);
    var available = Math.max(0, Number(ref.data[12] || 0) - qty);
    var reorder = Number(ref.data[13] || 0);
    var status = available <= 0 ? '❌ OUT OF STOCK' : available <= reorder ? '⚠️ LOW STOCK' : '✅ IN STOCK';
    ref.data[7] = sold;
    ref.data[11] = current;
    ref.data[12] = available;
    ref.data[14] = status;
    var rowKey = ref.sh.getSheetId() + ':' + ref.row;
    touched[rowKey] = ref;
  });
  Object.keys(touched).forEach(function(rowKey) {
    var ref = touched[rowKey];
    var slice = ref.sh.getRange(ref.row, 8, 1, 8).getValues()[0];
    slice[0] = ref.data[7];
    slice[4] = ref.data[11];
    slice[5] = ref.data[12];
    slice[7] = ref.data[14];
    ref.sh.getRange(ref.row, 8, 1, 8).setValues([slice]);
  });
  SpreadsheetApp.flush();
}

var DEFERRED_CRM_QUEUE_KEY_ = 'deferred_order_crm_queue_v1';

function enqueueDeferredOrderCrmHook_(payload) {
  if (typeof onOrderCrmUpdate !== 'function') return;
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(DEFERRED_CRM_QUEUE_KEY_) || '[]';
    var queue = JSON.parse(raw);
    if (!Array.isArray(queue)) queue = [];
    queue.push({
      ts: Date.now(),
      customer: String(payload.customer || ''),
      phone: String(payload.phone || ''),
      address: String(payload.address || ''),
      source: String(payload.source || ''),
      order_id: String(payload.order_id || ''),
    });
    if (queue.length > 40) queue = queue.slice(queue.length - 40);
    props.setProperty(DEFERRED_CRM_QUEUE_KEY_, JSON.stringify(queue));
  } catch (e) {
    apiLog_('WARN', 'create_order', 'CRM defer enqueue failed: ' + e.message, '');
  }
}

/** Run from time-driven trigger or editor to drain deferred CRM hooks. */
function processDeferredOrderCrmHooks_() {
  if (typeof onOrderCrmUpdate !== 'function') return { ok: true, processed: 0, skipped: 'crm_not_loaded' };
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(DEFERRED_CRM_QUEUE_KEY_) || '[]';
  var queue = [];
  try {
    queue = JSON.parse(raw);
  } catch (e) {
    props.deleteProperty(DEFERRED_CRM_QUEUE_KEY_);
    return { ok: false, error: 'invalid_queue' };
  }
  if (!Array.isArray(queue) || !queue.length) return { ok: true, processed: 0 };
  props.deleteProperty(DEFERRED_CRM_QUEUE_KEY_);
  var processed = 0;
  var failed = 0;
  queue.forEach(function(entry) {
    try {
      onOrderCrmUpdate(entry.customer, entry.phone, entry.address || '', '', entry.source || '');
      processed++;
    } catch (crmErr) {
      failed++;
      apiLog_('WARN', 'deferred_crm', 'CRM hook error: ' + crmErr.message, entry.order_id || '');
    }
  });
  return { ok: true, processed: processed, failed: failed };
}

function isInventoryRestoreTerminal_(status) {
  var key = normalizeOrderStatus_(status);
  return key === 'CANCELLED' || key === 'RETURNED' || key === 'RETURNED_PAID' || key === 'RETURNED_UNPAID';
}

function appendInventoryAudit_(orderId, action, reason, detail) {
  try {
    var sh = ensureAuditSheet_();
    var ts = new Date();
    var iso = Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'");
    sh.appendRow([
      iso,
      'inventory_' + action,
      'system',
      '',
      'ALMA_LIFESTYLE',
      'order',
      String(orderId),
      'Inventory ' + action + ' for order ' + orderId + ' due to ' + reason,
      JSON.stringify(detail || {}).slice(0, 12000),
      'OK',
    ]);
    SpreadsheetApp.flush();
  } catch (e) {
    apiLog_('WARN', 'audit', 'inventory audit append failed: ' + e.message, String(orderId));
  }
}

function restoreOrderItemsOnce_(orderSheet, rowIndex, orderId, reason) {
  var meta = parseOrderItemsMeta_(String(orderSheet.getRange(rowIndex, OC.NOTES).getValue() || ''));
  if (!meta || !meta.items || !meta.items.length) {
    return { ok: true, skipped: 'no_items' };
  }
  if (meta.stockRestored === true) {
    return { ok: true, skipped: 'already_restored', reason: 'already_restored' };
  }
  var stock = getStockRowsBySku_();
  var demand = orderInventoryDemand_(meta.items);
  var restoredSkus = [];
  var missingSkus = [];
  Object.keys(demand).forEach(function(sku) {
    var ref = stock[sku];
    if (!ref) {
      missingSkus.push(sku);
      apiLog_('WARN', 'INVENTORY_RESTORE', String(orderId), 'SKU not found for restock: ' + sku, reason);
      return;
    }
    var qty = demand[sku];
    var sold = Math.max(0, Number(ref.data[7] || 0) - qty);
    var current = Number(ref.data[11] || 0) + qty;
    var available = Number(ref.data[12] || 0) + qty;
    var reorder = Number(ref.data[13] || 0);
    var status = available <= 0 ? '❌ OUT OF STOCK' : available <= reorder ? '⚠️ LOW STOCK' : '✅ IN STOCK';
    ref.sh.getRange(ref.row, 8).setValue(sold);
    ref.sh.getRange(ref.row, 12).setValue(current);
    ref.sh.getRange(ref.row, 13).setValue(available);
    ref.sh.getRange(ref.row, 15).setValue(status);
    restoredSkus.push(sku);
  });
  updateOrderMetaFlag_(orderSheet, rowIndex, function(next) {
    next.stockRestored = true;
    next.stockRestoredAt = new Date().toISOString();
    next.stockRestoreReason = reason;
    delete next.stockRedeductedAt;
    delete next.stockRedeductReason;
  });
  appendInventoryAudit_(orderId, 'restored', reason, { skus: restoredSkus, missing: missingSkus, qty_by_sku: demand });
  apiLog_('INVENTORY_RESTORE', String(orderId), 'Order item stock restored for ' + reason, JSON.stringify({ skus: restoredSkus, missing: missingSkus }).slice(0, 1000));
  return { ok: true, restored: true, skus: restoredSkus, missing: missingSkus };
}

function reapplyOrderInventoryDeductionsOnce_(orderSheet, rowIndex, orderId, reason) {
  var meta = parseOrderItemsMeta_(String(orderSheet.getRange(rowIndex, OC.NOTES).getValue() || ''));
  if (!meta || !meta.items || !meta.items.length || meta.stockRestored !== true) {
    return { ok: true, skipped: 'not_restored_or_no_items' };
  }
  var warnings = [];
  var stock = getStockRowsBySku_();
  applyOrderInventoryDeductionsLenient_(meta.items, stock, warnings);
  updateOrderMetaFlag_(orderSheet, rowIndex, function(next) {
    next.stockRestored = false;
    next.stockRedeductedAt = new Date().toISOString();
    next.stockRedeductReason = reason;
    delete next.stockRestoredAt;
    delete next.stockRestoreReason;
  });
  appendInventoryAudit_(orderId, 'rededucted', reason, { warnings: warnings, items: meta.items.length });
  apiLog_('INVENTORY_REDEDUCT', String(orderId), 'Stock re-deducted after status revert: ' + reason, JSON.stringify({ warnings: warnings }).slice(0, 1000));
  return { ok: true, rededucted: true, warnings: warnings };
}

function ensureOrderItemsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.ORDER_ITEMS);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.ORDER_ITEMS);
    sh.setFrozenRows(1);
  }
  sh.getRange(1, 1, 1, 19).setValues([[
    'ORDER_ID', 'LINE_NO', 'SKU', 'PRODUCT_CODE', 'PRODUCT', 'CATEGORY', 'SIZE', 'VARIANT',
    'QTY', 'UNIT_PRICE', 'SELL_PRICE', 'SUBTOTAL', 'COGS', 'STOCK_SKU',
    'COLLECTION_CODE', 'COLLECTION_TYPE', 'SIZE_GROUP', 'VARIANT_GROUP', 'CREATED_AT'
  ]]);
  return sh;
}

function appendOrderItems_(orderId, items) {
  var sh = ensureOrderItemsSheet_();
  var now = new Date();
  var rows = items.map(function(item) {
    return [
      orderId,
      item.line_no,
      item.sku,
      item.product_code,
      item.product,
      item.category,
      item.size,
      item.variant,
      item.qty,
      item.unit_price,
      item.sell_price,
      item.subtotal,
      item.cogs,
      item.stock_sku,
      item.collection_code,
      item.collection_type,
      item.size_group,
      item.variant_group,
      now,
    ];
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 19).setValues(rows);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE STATUS
// ═══════════════════════════════════════════════════════════════════════════════

function updateStatus_(body) {
  if (!body.id)     return { error: 'id required' };
  if (!body.status) return { error: 'status required' };

  var requestedStatus = normalizeOrderStatus_(body.status);
  var valid = ['Pending','Confirmed','Packed','Shipped','Delivered','RETURNED','RETURNED_PAID','RETURNED_UNPAID','CANCELLED'];
  if (valid.indexOf(requestedStatus) === -1) return { error: 'Invalid status: ' + body.status };

  var found = findOrderRow_(body.id);
  if (!found) return { error: 'Order not found: ' + body.id };

  var oldStatus = found.data[OC.STATUS - 1];
  var oldStatusKey = normalizeOrderStatus_(oldStatus);
  body.previous_status = body.previous_status || oldStatus;
  body.status = requestedStatus;

  var notesBefore = String(found.sh.getRange(found.rowIndex, OC.NOTES).getValue() || '');
  var metaBefore = parseOrderItemsMeta_(notesBefore);
  if (isInventoryRestoreTerminal_(oldStatus) && !isInventoryRestoreTerminal_(requestedStatus) && metaBefore && metaBefore.stockRestored === true) {
    reapplyOrderInventoryDeductionsOnce_(found.sh, found.rowIndex, body.id, oldStatusKey + '→' + requestedStatus);
  }

  found.sh.getRange(found.rowIndex, OC.STATUS).setValue(requestedStatus);
  applyTerminalOrderState_(found.sh, found.rowIndex, requestedStatus, body.reason || '');

  // Fire Phase 2 automation if present
  if (typeof handleStatusChange_ === 'function') {
    try { handleStatusChange_(found.sh, found.rowIndex, found.data, requestedStatus, oldStatus); }
    catch (e) { apiLog_('WARN', 'update_status', 'Phase 2 hook: ' + e.message, ''); }
  } else {
    // Minimal built-in timestamps when Phase 2 is not loaded
    var now = new Date();
    var ts  = found.sh;
    if (requestedStatus === 'Shipped' && !ts.getRange(found.rowIndex, 37).getValue())
      ts.getRange(found.rowIndex, 37).setValue(now).setNumberFormat('DD-MMM-YYYY');
    if (requestedStatus === 'Delivered' && !ts.getRange(found.rowIndex, 38).getValue())
      ts.getRange(found.rowIndex, 38).setValue(now).setNumberFormat('DD-MMM-YYYY');
    if (requestedStatus === 'RETURNED' && !ts.getRange(found.rowIndex, 39).getValue())
      ts.getRange(found.rowIndex, 39).setValue(now).setNumberFormat('DD-MMM-YYYY');
  }

  writeOrderAccountingMeta_(found.sh, found.rowIndex, requestedStatus);
  if (isInventoryRestoreTerminal_(requestedStatus)) {
    restoreOrderItemsOnce_(found.sh, found.rowIndex, body.id, requestedStatus);
  }

  SpreadsheetApp.flush();
  apiLog_('STATUS', body.id, oldStatus + ' → ' + requestedStatus, String(body.actor || '') + ' · ' + String(body.business_id || ''));
  return { ok: true, order_id: body.id, old_status: oldStatus, new_status: requestedStatus };
}

function normalizeOrderStatus_(status) {
  var s = String(status || '').trim();
  var key = s.toUpperCase().replace(/\s+/g, '_');
  if (key === 'CANCELLED' || key === 'CANCELED') return 'CANCELLED';
  if (key === 'FAILED_DELIVERY') return 'RETURNED_UNPAID';
  if (key === 'RETURNED_PAID') return 'RETURNED_PAID';
  if (key === 'RETURNED_UNPAID') return 'RETURNED_UNPAID';
  if (key === 'RETURNED') return 'RETURNED';
  if (key === 'PENDING') return 'Pending';
  if (key === 'CONFIRMED') return 'Confirmed';
  if (key === 'PACKED') return 'Packed';
  if (key === 'SHIPPED') return 'Shipped';
  if (key === 'DELIVERED') return 'Delivered';
  return s;
}

function isTerminalReturnStatus_(key) {
  return key === 'RETURNED' || key === 'RETURNED_PAID' || key === 'RETURNED_UNPAID';
}

function applyTerminalOrderState_(sh, rowIndex, status, reason) {
  var now = new Date();
  if (status === 'RETURNED') {
    sh.getRange(rowIndex, OC.TRACKING_STATUS).setValue('Returned');
    sh.getRange(rowIndex, OC.RETURN_DATE).setValue(now).setNumberFormat('DD-MMM-YYYY');
    sh.getRange(rowIndex, OC.RETURN_STATUS).setValue('Returned');
    if (reason) sh.getRange(rowIndex, OC.RETURN_REASON).setValue(String(reason).slice(0, 500));
  } else if (status === 'RETURNED_PAID') {
    sh.getRange(rowIndex, OC.TRACKING_STATUS).setValue('Returned (paid delivery)');
    sh.getRange(rowIndex, OC.RETURN_DATE).setValue(now).setNumberFormat('DD-MMM-YYYY');
    sh.getRange(rowIndex, OC.RETURN_STATUS).setValue('Returned (paid)');
    if (reason) sh.getRange(rowIndex, OC.RETURN_REASON).setValue(String(reason).slice(0, 500));
  } else if (status === 'RETURNED_UNPAID') {
    sh.getRange(rowIndex, OC.TRACKING_STATUS).setValue('Returned (refused)');
    sh.getRange(rowIndex, OC.RETURN_DATE).setValue(now).setNumberFormat('DD-MMM-YYYY');
    sh.getRange(rowIndex, OC.RETURN_STATUS).setValue('Returned (refused)');
    if (reason) sh.getRange(rowIndex, OC.RETURN_REASON).setValue(String(reason).slice(0, 500));
  } else if (status === 'CANCELLED') {
    sh.getRange(rowIndex, OC.TRACKING_STATUS).setValue('Cancelled');
    sh.getRange(rowIndex, OC.RETURN_STATUS).setValue('Cancelled');
    if (reason) sh.getRange(rowIndex, OC.RETURN_REASON).setValue(String(reason).slice(0, 500));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

function updateTracking_(body) {
  if (!body.id)          return { error: 'id required' };
  if (!body.tracking_id) return { error: 'tracking_id required' };

  var found = findOrderRow_(body.id);
  if (!found) return { error: 'Order not found: ' + body.id };

  var sh       = found.sh;
  var rowIndex = found.rowIndex;
  var rowData  = found.data;

  sh.getRange(rowIndex, OC.TRACKING_ID).setValue(body.tracking_id);
  if (body.courier) sh.getRange(rowIndex, OC.COURIER).setValue(body.courier);

  var current    = rowData[OC.STATUS - 1];
  var preShipped = ['Pending','Confirmed','Packed'].indexOf(current) !== -1;
  var autoShipped = false;

  if (preShipped) {
    sh.getRange(rowIndex, OC.STATUS).setValue('Shipped');
    sh.getRange(rowIndex, OC.TRACKING_STATUS).setValue('In Transit');
    var now = new Date();
    if (!sh.getRange(rowIndex, 37).getValue())
      sh.getRange(rowIndex, 37).setValue(now).setNumberFormat('DD-MMM-YYYY');
    var addr  = String(rowData[OC.ADDRESS - 1] || '').toLowerCase();
    var days  = addr.indexOf('dhaka') !== -1 ? 3 : 5;
    var est   = new Date(now);
    est.setDate(est.getDate() + days);
    if (!sh.getRange(rowIndex, OC.EST_DELIVERY).getValue())
      sh.getRange(rowIndex, OC.EST_DELIVERY).setValue(est).setNumberFormat('DD-MMM-YYYY');
    autoShipped = true;
  } else if (body.tracking_status) {
    sh.getRange(rowIndex, OC.TRACKING_STATUS).setValue(body.tracking_status);
  }

  SpreadsheetApp.flush();
  apiLog_('TRACKING', body.id, body.tracking_id, body.courier || '');
  return { ok: true, order_id: body.id, tracking_id: body.tracking_id, auto_shipped: autoShipped };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE SINGLE FIELD
// ═══════════════════════════════════════════════════════════════════════════════

function updateField_(body) {
  if (!body.id)               return { error: 'id required' };
  if (!body.field)            return { error: 'field required' };
  if (body.value === undefined) return { error: 'value required' };

  var colNum = OC[String(body.field).toUpperCase()];
  if (!colNum) return { error: 'Unknown field: ' + body.field };

  // Refuse writes to formula columns
  var formulaCols = { 1:true, 18:true, 23:true, 33:true, 35:true };
  if (formulaCols[colNum]) return { error: 'Cannot overwrite formula column: ' + body.field };

  var found = findOrderRow_(body.id);
  if (!found) return { error: 'Order not found: ' + body.id };

  found.sh.getRange(found.rowIndex, colNum).setValue(body.value);
  SpreadsheetApp.flush();
  apiLog_('UPDATE_FIELD', body.id, body.field + '=' + body.value, '');
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADD EXPENSE
// ═══════════════════════════════════════════════════════════════════════════════

function addExpense_(body) {
  if (!body.category) return { error: 'category required' };
  if (!body.amount)   return { error: 'amount required' };

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sh  = ss.getSheetByName(SHEETS.EXPENSE);
  if (!sh) return { error: 'EXPENSE sheet not found: ' + SHEETS.EXPENSE };

  var newRow = sh.getLastRow() + 1;
  var today  = body.date ? new Date(body.date) : new Date();
  var biz    = typeof resolveBusinessId_ === 'function'
    ? resolveBusinessId_(body.business_id || '')
    : ((body.business_id === 'CREATIVE_DIGITAL_IT') ? 'CREATIVE_DIGITAL_IT' : 'ALMA_LIFESTYLE');
  var paymentStatus = String(body.payment_status || body.pay_status || 'Paid').trim() || 'Paid';
  var title = String(body.title || body.description || '').trim();
  var noteRaw = String(body.notes || body.note || '');
  var notesMerged = '[PS:' + paymentStatus + ']' + (noteRaw ? ' ' + noteRaw : '');
  var expType = body.recurring === true || body.expense_kind === 'recurring'
    ? 'Recurring'
    : String(body.exp_type || 'One-time');

  var row = [];
  for (var c = 0; c < 17; c++) row.push('');

  row[0]  = '=IF(E' + newRow + '="","","EXP-"&TEXT(ROW()-5,"0000"))';
  row[1]  = today;
  row[2]  = Utilities.formatDate(today, Session.getScriptTimeZone(), 'MMM-yyyy');
  row[3]  = 'W' + getWeekNum_(today);
  row[4]  = body.category;
  row[5]  = biz;
  row[6]  = expType;
  row[7]  = title || body.category;
  row[8]  = body.vendor || '';
  row[9]  = Number(body.amount);
  row[10] = body.payment_method || body.payment || '';
  row[11] = 'Main Account';
  row[12] = String(body.receipt_ref || body.attachment_url || '').trim();
  row[13] = body.linked_order || '';
  row[14] = 'ERP_API';
  row[15] = String(body.recurring === true ? 'Yes' : 'No');
  row[16] = notesMerged;

  sh.getRange(newRow, 1, 1, 17).setValues([row]);
  sh.getRange(newRow, 2).setNumberFormat('DD-MMM-YYYY');
  sh.getRange(newRow, 10).setNumberFormat('৳#,##0');
  SpreadsheetApp.flush();

  var expId = sh.getRange(newRow, 1).getValue();
  return { ok: true, expense_id: String(expId), exp_id: String(expId), row: newRow };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DELEGATE TO PHASE 3 / 4 / 5
// ═══════════════════════════════════════════════════════════════════════════════

function triggerInvoice_(body) {
  var t0 = Date.now();
  Logger.log('triggerInvoice_ start id=' + (body && body.id));
  if (!body.id) return { error: 'id required' };
  if (typeof generateInvoice !== 'function')
    return { error: 'Phase 4 not loaded — add Phase4_Invoice.gs to this project' };
  var found = findOrderRow_(body.id);
  if (!found) return { error: 'Order not found: ' + body.id };
  var result = generateInvoice(found.rowIndex, found.data);
  Logger.log('triggerInvoice_ raw result keys=' + (result ? Object.keys(result).join(',') : 'null') + ' elapsed_ms=' + (Date.now() - t0));
  if (!result) {
    return { error: 'Invoice generation returned no result — check Apps Script Executions and 🤖 AUTOMATION LOG.' };
  }
  if (result.error) {
    Logger.log('triggerInvoice_ error=' + result.error + ' elapsed_ms=' + (Date.now() - t0));
    return { error: result.error };
  }
  if (!result.invoiceNumber) {
    return { error: 'Invoice generation returned no invoice_number' };
  }
  Logger.log('triggerInvoice_ ok invoice_number=' + result.invoiceNumber + ' elapsed_ms=' + (Date.now() - t0));
  return {
    ok: true,
    invoice_number: result.invoiceNumber,
    file_url: result.fileUrl || '',
    drive_url: result.fileUrl || '',
    share_url: result.fileUrl || '',
    file_name: result.fileName || '',
    duplicate: !!result.duplicate,
  };
}

function triggerSaveInvoicePdf_(body) {
  var t0 = Date.now();
  if (!body.id) return { error: 'id required' };
  if (!body.pdf_base64) return { error: 'pdf_base64 required' };
  if (typeof getNextAlInvoiceNumber_ !== 'function') return { error: 'Phase 4 invoice counter not loaded' };
  if (typeof savePdfToDrive_ !== 'function') return { error: 'Phase 4 Drive save not loaded' };

  var found = findOrderRow_(body.id);
  if (!found) return { error: 'Order not found: ' + body.id };

  var order = rowToOrder_(found.data);
  var existing = String(found.data[OC.INVOICE_NUM - 1] || '').trim();
  var allowRegenerate = body.allow_regenerate === true || String(body.allow_regenerate || '') === 'true';
  if (existing && !allowRegenerate && typeof findShareUrlForInvoicePdf_ === 'function') {
    var existingUrl = findShareUrlForInvoicePdf_(String(body.id));
    return {
      ok: true,
      invoice_number: existing,
      file_url: existingUrl,
      drive_url: existingUrl,
      share_url: existingUrl,
      file_name: 'Invoice-' + sanitizeInvoicePdfBaseName_(String(body.id)) + '.pdf',
      duplicate: true,
    };
  }

  var invoiceNumber = existing || String(body.invoice_number || '').trim();
  if (!invoiceNumber) {
    invoiceNumber = getNextAlInvoiceNumber_(true);
  } else if (!existing) {
    // Advance the legacy counter so the next invoice number remains consistent.
    getNextAlInvoiceNumber_(true);
  }

  var b64 = String(body.pdf_base64 || '');
  if (b64.indexOf('base64,') >= 0) b64 = b64.split('base64,')[1];
  var bytes = Utilities.base64Decode(b64);
  var fileName = 'Invoice-' + sanitizeInvoicePdfBaseName_(String(body.id)) + '.pdf';
  var pdfBlob = Utilities.newBlob(bytes, MimeType.PDF, fileName);

  trashExistingAlmaInvoicePdf_(String(body.id));
  var issuedDate = new Date();
  var driveOrder = {
    id: order.id,
    date: order.date ? new Date(order.date) : issuedDate,
    customer: order.customer || '',
  };
  var fileUrl = savePdfToDrive_(pdfBlob, fileName, driveOrder, issuedDate);
  if (!fileUrl) return { error: 'Could not save React-rendered PDF to Google Drive' };

  found.sh.getRange(found.rowIndex, OC.INVOICE_NUM).setValue(invoiceNumber)
    .setFontColor('#8B6914')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  Logger.log('triggerSaveInvoicePdf_ ok invoice_number=' + invoiceNumber + ' elapsed_ms=' + (Date.now() - t0));
  return {
    ok: true,
    invoice_number: invoiceNumber,
    file_url: fileUrl,
    drive_url: fileUrl,
    share_url: fileUrl,
    file_name: fileName,
    duplicate: false,
    renderer: 'react-pdf',
  };
}

function trashExistingAlmaInvoicePdf_(orderId) {
  try {
    if (typeof getOrCreateAlmaErpInvoicesFolder_ !== 'function') return;
    var folder = getOrCreateAlmaErpInvoicesFolder_();
    var name = 'Invoice-' + sanitizeInvoicePdfBaseName_(String(orderId)) + '.pdf';
    var files = folder.getFilesByName(name);
    while (files.hasNext()) {
      files.next().setTrashed(true);
    }
  } catch (e) {
    Logger.log('trashExistingAlmaInvoicePdf_ warning: ' + e.message);
  }
}

function triggerOrderFolder_(body) {
  if (!body.id) return { error: 'id required' };
  if (typeof createOrderFolder_ !== 'function')
    return { error: 'Phase 3 not loaded — add Phase3_Drive.gs to this project' };
  var found = findOrderRow_(body.id);
  if (!found) return { error: 'Order not found: ' + body.id };
  var url = createOrderFolder_(body.id, found.data[OC.CUSTOMER-1], found.data[OC.DATE-1]);
  return { ok: true, folder_url: url };
}

function triggerCreateCustomer_(body) {
  if (!body.name || !body.phone) return { error: 'name and phone required' };
  if (typeof ensureCustomerProfile_ !== 'function')
    return { error: 'Phase 5 not loaded — add Phase5_CRM.gs to this project' };
  var row = ensureCustomerProfile_(body.name, body.phone, body.address || '', body.district || '', body.source || '');
  return { ok: true, profile_row: row };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

function filterOrdersByDateRange_(orders, startDate, endDate) {
  if (!startDate && !endDate) return orders;
  return orders.filter(function(o) {
    if (!o.date) return false;
    if (startDate && o.date < startDate) return false;
    if (endDate   && o.date > endDate)   return false;
    return true;
  });
}

function getDashboard_(p) {
  p = p || {};
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sh    = ss.getSheetByName(SHEETS.ORDERS);
  var last  = sh.getLastRow();

  var emptyResult = {
    kpis: { total_orders:0,total_revenue:0,total_profit:0,total_cogs:0,gross_margin:0,
            avg_order_value:0,delivered_count:0,delivery_rate:0,return_rate:0,
            sla_breaches:0,pending_action:0,returned_count:0,cancelled_count:0,failed_delivery_count:0,
            total_realized_profit:0,pending_profit:0,reversed_profit:0,loss_orders:0,
            total_returns_loss:0,net_business_profit:0,returned_paid_count:0,returned_unpaid_count:0,
            return_rate_paid:0,return_rate_refused:0 },
    by_status:{},by_source:{},by_payment:{},by_category:{},
    profit_by_seller:{},profit_by_collection:{},
    sla_breaches:[],recent_orders:[],generated_at:new Date().toISOString()
  };

  if (last < ORDERS_DATA_START) return emptyResult;

  var rows   = sh.getRange(ORDERS_DATA_START, 1, last - ORDERS_DATA_START + 1, TOTAL_COLS).getValues();
  var orders = rows.filter(function(r){ return r[OC.ORDER_ID-1]; }).map(rowToOrder_);
  orders = filterOrdersByDateRange_(orders, p.startDate || '', p.endDate || '');
  orders = orders.filter(function(o){ return orderMatchesBusiness_(o, resolveBusinessId_(p.business_id || '')); });

  if (!orders.length) return emptyResult;

  var totalRev=0,totalPro=0,totalCOGS=0,delivered=0,returned=0,cancelled=0,failedDelivery=0;
  var pendingProfit=0,reversedProfit=0,lossOrders=0,deliveredProfit=0,returnsLoss=0,returnNetTotal=0;
  var returnedPaid=0,returnedUnpaid=0;
  var byStatus={},bySource={},byPayment={},byCat={},bySeller={},byCollection={},slaBreaches=[],monthly={};

  orders.forEach(function(o) {
    var statusKey = normalizeOrderStatus_(o.status);
    var revenueActive = statusKey === 'Delivered';
    var terminalReverse = statusKey === 'CANCELLED' || isTerminalReturnStatus_(statusKey);
    var estimated = Number(o.estimatedProfit != null ? o.estimatedProfit : o.profit || 0);
    if (revenueActive) {
      var realized = Number(o.realizedProfit != null ? o.realizedProfit : o.net_profit != null ? o.net_profit : estimated);
      totalRev  += o.sell_price;
      totalPro  += realized;
      deliveredProfit += realized;
      totalCOGS += o.cogs;
    } else if (isTerminalReturnStatus_(statusKey)) {
      var returnNet = Number(o.return_net_profit != null ? o.return_net_profit : 0);
      returnNetTotal += returnNet;
      if (returnNet < 0) {
        returnsLoss += Math.abs(returnNet);
        reversedProfit += Math.abs(returnNet);
        lossOrders++;
      }
    } else if (terminalReverse) {
      // CANCELLED — no courier loss
    } else {
      pendingProfit += estimated;
    }
    if (statusKey==='Delivered') delivered++;
    if (isTerminalReturnStatus_(statusKey)) {
      returned++;
      if (statusKey === 'RETURNED_PAID') returnedPaid++;
      if (statusKey === 'RETURNED_UNPAID' || statusKey === 'RETURNED') returnedUnpaid++;
    }
    if (statusKey==='CANCELLED') cancelled++;
    if (statusKey==='RETURNED_UNPAID') failedDelivery++;
    byStatus[statusKey]   = (byStatus[statusKey]||0)+1;
    byPayment[o.payment] = (byPayment[o.payment]||0)+1;
    if (!bySource[o.source]) bySource[o.source]={orders:0,revenue:0};
    bySource[o.source].orders++;
    if (revenueActive) bySource[o.source].revenue += o.sell_price;
    if (!byCat[o.category]) byCat[o.category]={orders:0,revenue:0,profit:0};
    byCat[o.category].orders++;
    if (revenueActive) {
      byCat[o.category].revenue += o.sell_price;
      byCat[o.category].profit  += Number(o.realizedProfit != null ? o.realizedProfit : estimated);
    }
    var seller = o.handled_by || 'Unassigned';
    if (!bySeller[seller]) bySeller[seller] = { orders:0, realized_profit:0, pending_profit:0, reversed_profit:0 };
    bySeller[seller].orders++;
    if (revenueActive) bySeller[seller].realized_profit += Number(o.realizedProfit != null ? o.realizedProfit : estimated);
    else if (terminalReverse) bySeller[seller].reversed_profit += Number(o.reversedProfit != null ? o.reversedProfit : estimated);
    else bySeller[seller].pending_profit += estimated;
    (o.items && o.items.length ? o.items : [{ collection_code:'', subtotal:o.sell_price }]).forEach(function(item) {
      var code = String(item.collection_code || item.product_code || o.category || 'Unknown');
      if (!byCollection[code]) byCollection[code] = { orders:0, realized_profit:0, pending_profit:0, reversed_profit:0 };
      byCollection[code].orders++;
      var share = o.sell_price > 0 ? Number(item.subtotal || 0) / o.sell_price : 1;
      if (revenueActive) byCollection[code].realized_profit += Number(o.realizedProfit != null ? o.realizedProfit : estimated) * share;
      else if (terminalReverse) byCollection[code].reversed_profit += Number(o.reversedProfit != null ? o.reversedProfit : estimated) * share;
      else byCollection[code].pending_profit += estimated * share;
    });
    if (o.sla_status && o.sla_status.indexOf('BREACH')!==-1)
      slaBreaches.push({id:o.id,customer:o.customer,sla_status:o.sla_status,
                        days_pending:o.days_pending,days_in_transit:o.days_in_transit,
                        courier:o.courier,tracking_id:o.tracking_id});
    // Monthly trend
    if (o.date) {
      var d = new Date(o.date);
      if (!isNaN(d.getTime())) {
        var key = d.getFullYear()+'-'+pad_(d.getMonth()+1);
        var mon = Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM yyyy');
        if (!monthly[key]) monthly[key]={month:mon,revenue:0,profit:0,orders:0,cogs:0};
        if (revenueActive) {
          monthly[key].revenue += o.sell_price;
          monthly[key].profit  += Number(o.realizedProfit != null ? o.realizedProfit : estimated);
          monthly[key].cogs    += o.cogs;
        }
        monthly[key].orders++;
      }
    }
  });

  var n = orders.length;
  var recentOrders = orders.slice(-10).reverse().map(function(o){
    return {id:o.id,date:o.date,customer:o.customer,product:o.product,
            status:o.status,sell_price:o.sell_price,profit:o.profit,realizedProfit:o.realizedProfit,pendingProfit:o.estimatedProfit};
  });
  var monthlyArr = Object.keys(monthly).sort().map(function(k){return monthly[k];});

  return {
    kpis:{
      total_orders:n, total_revenue:totalRev, total_profit:totalPro, total_cogs:totalCOGS,
      total_realized_profit:totalPro,
      pending_profit:pendingProfit,
      reversed_profit:reversedProfit,
      loss_orders:lossOrders,
      total_returns_loss:returnsLoss,
      net_business_profit:deliveredProfit + returnNetTotal,
      returned_paid_count:returnedPaid,
      returned_unpaid_count:returnedUnpaid,
      return_rate_paid:n>0 ? Math.round(returnedPaid/n*100):0,
      return_rate_refused:n>0 ? Math.round(returnedUnpaid/n*100):0,
      gross_margin:   totalRev>0 ? Math.round(totalPro/totalRev*100):0,
      avg_order_value:n>0 ? Math.round(totalRev/n):0,
      delivered_count:delivered,
      returned_count:returned,
      cancelled_count:cancelled,
      failed_delivery_count:failedDelivery,
      delivery_rate:  n>0 ? Math.round(delivered/n*100):0,
      return_rate:    n>0 ? Math.round(returned/n*100):0,
      sla_breaches:   slaBreaches.length,
      pending_action: (byStatus['Pending']||0)+(byStatus['Confirmed']||0),
    },
    by_status:byStatus, by_source:bySource, by_payment:byPayment, by_category:byCat,
    profit_by_seller:bySeller,
    profit_by_collection:byCollection,
    sla_breaches:slaBreaches, recent_orders:recentOrders,
    monthly_trend:monthlyArr,
    generated_at:new Date().toISOString(),
  };
}

function getAnalytics_(p) {
  p = p || {};
  var dash    = getDashboard_(p);
  var finance = getFinance_({ business_id: p.business_id, startDate: p.startDate, endDate: p.endDate });
  var hrDash = hrDashboard_({ business_id: p.business_id, startDate: p.startDate, endDate: p.endDate });
  return Object.assign({}, dash, {
    expense_by_cat: finance.by_category,
    total_expenses: finance.total_expenses,
    cash_balance:   finance.cash_balance,
    employee_cost_roll: hrDash.kpis.monthly_payroll_budget || hrDash.kpis.total_monthly_salary,
    net_business_after_opex: hrDash.kpis.net_business_profit_hint,
    payroll_kpis: hrDash.kpis,
  });
}

function getOrders_(p) {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var sh   = ss.getSheetByName(SHEETS.ORDERS);
  var last = sh.getLastRow();
  if (last < ORDERS_DATA_START) return {orders:[],summary:{total:0,total_revenue:0,total_profit:0,by_status:{}}};

  var rows   = sh.getRange(ORDERS_DATA_START,1,last-ORDERS_DATA_START+1,TOTAL_COLS).getValues();
  var statusF = p.status||'', sourceF=p.source||'', paymentF=p.payment||'';
  var search  = (p.search||'').toLowerCase();
  var limit   = parseInt(p.limit||'500',10);
  var offset  = parseInt(p.offset||'0',10);

  var orders = rows
    .filter(function(r){return r[OC.ORDER_ID-1];})
    .map(rowToOrder_);
  orders = filterOrdersByDateRange_(orders, p.startDate || '', p.endDate || '');
  orders = orders.filter(function(o){ return orderMatchesBusiness_(o, resolveBusinessId_(p.business_id || '')); });
  orders = orders.filter(function(o){
      if (statusF  && o.status  !==statusF)  return false;
      if (sourceF  && o.source  !==sourceF)  return false;
      if (paymentF && o.payment !==paymentF) return false;
      if (search) return [o.id,o.customer,o.phone,o.product,o.tracking_id]
        .some(function(v){return String(v).toLowerCase().indexOf(search)!==-1;});
      return true;
    });

  var total   = orders.length;
  var slice   = orders.slice(offset, offset+limit);
  var byStatus={};
  slice.forEach(function(o){byStatus[o.status]=(byStatus[o.status]||0)+1;});
  return {
    orders:slice,
    summary:{total:total,
             total_revenue:slice.reduce(function(a,o){return normalizeOrderStatus_(o.status)==='Delivered' ? a+o.sell_price : a;},0),
             total_profit: slice.reduce(function(a,o){return a+Number(o.realizedProfit || 0);},0),
             pending_profit:slice.reduce(function(a,o){var s=normalizeOrderStatus_(o.status); return (s!=='Delivered' && s!=='CANCELLED' && !isTerminalReturnStatus_(s)) ? a+Number(o.estimatedProfit || o.profit || 0) : a;},0),
             reversed_profit:slice.reduce(function(a,o){return a+Number(o.reversedProfit || 0);},0),
             by_status:byStatus}
  };
}

function getOrder_(id) {
  if (!id) return {error:'id parameter required'};
  var row = findOrderRow_(id);
  if (!row) return {error:'Order not found: '+id};
  var order = rowToOrder_(row.data);
  order.items = getOrderItems_(id);
  return {order:order};
}

function getOrderItems_(orderId) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ORDER_ITEMS);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, Math.max(19, sh.getLastColumn())).getValues();
  return rows
    .filter(function(r){ return String(r[0] || '') === String(orderId); })
    .map(function(r){
      return {
        order_id: String(r[0] || ''),
        line_no: Number(r[1] || 0),
        sku: String(r[2] || ''),
        product_code: String(r[3] || ''),
        product: String(r[4] || ''),
        category: String(r[5] || ''),
        size: String(r[6] || ''),
        variant: String(r[7] || ''),
        qty: Number(r[8] || 0),
        unit_price: Number(r[9] || 0),
        sell_price: Number(r[10] || 0),
        subtotal: Number(r[11] || 0),
        cogs: Number(r[12] || 0),
        stock_sku: String(r[13] || ''),
        collection_code: String(r[14] || ''),
        collection_type: String(r[15] || ''),
        size_group: String(r[16] || ''),
        variant_group: String(r[17] || ''),
      };
    });
}

function getCustomers_(p) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sh  = ss.getSheetByName(SHEETS.CUSTOMERS);
  if (!sh) return {error:'CUSTOMERS sheet not found — run Phase 5 CRM setup'};
  var last=sh.getLastRow(), CSTART=6;
  if (last<CSTART) return {customers:[],summary:{total:0,by_segment:{},by_risk:{},total_revenue:0,avg_clv:0}};

  var rows=sh.getRange(CSTART,1,last-CSTART+1,29).getValues();
  var seg=p.segment||'',risk=p.risk_level||'',search=(p.search||'').toLowerCase();

  var customers=rows.filter(function(r){return r[1];}).map(function(r){
    return {id:String(r[0]||''),name:String(r[1]||''),phone:String(r[2]||''),
            district:String(r[3]||''),address:String(r[4]||''),whatsapp:String(r[5]||''),
            total_orders:Number(r[6]||0),delivered:Number(r[7]||0),returned:Number(r[8]||0),
            cancelled:Number(r[9]||0),pending:Number(r[10]||0),
            total_spent:Number(r[11]||0),avg_order:Number(r[12]||0),total_profit:Number(r[13]||0),
            cod_orders:Number(r[14]||0),cod_fails:Number(r[15]||0),cod_fail_pct:Number(r[16]||0),
            return_rate:Number(r[17]||0),last_order:fmtDate_(r[18]),days_inactive:Number(r[19]||0),
            fav_category:String(r[20]||''),clv_score:Number(r[21]||0),risk_score:Number(r[22]||0),
            risk_level:String(r[23]||''),segment:String(r[24]||''),loyalty_pts:Number(r[25]||0),
            source:String(r[26]||''),wa_optin:String(r[27]||''),notes:String(r[28]||'')};
  }).filter(function(c){
    if (seg  && c.segment   !==seg)  return false;
    if (risk && c.risk_level!==risk) return false;
    if (search) return [c.name,c.phone,c.district].some(function(v){return String(v).toLowerCase().indexOf(search)!==-1;});
    return true;
  });

  var bySegment={},byRisk={};
  customers.forEach(function(c){
    bySegment[c.segment]    =(bySegment[c.segment]   ||0)+1;
    byRisk[c.risk_level]    =(byRisk[c.risk_level]   ||0)+1;
  });
  var clvSum=customers.reduce(function(a,c){return a+c.clv_score;},0);
  return {customers:customers,summary:{total:customers.length,by_segment:bySegment,by_risk:byRisk,
    total_revenue:customers.reduce(function(a,c){return a+c.total_spent;},0),
    avg_clv:customers.length>0?Math.round(clvSum/customers.length):0}};
}

function getCustomer_(name) {
  if (!name) return {error:'name required'};
  var result=getCustomers_({search:name});
  var c=(result.customers||[]).filter(function(c){return c.name.toLowerCase()===name.toLowerCase();})[0];
  if (!c) return {error:'Customer not found: '+name};
  return {customer:c,orders:getOrders_({search:name}).orders||[]};
}

function getInventory_() {
  var ss=SpreadsheetApp.getActiveSpreadsheet(),sh=ss.getSheetByName(SHEETS.STOCK);
  if (!sh) return {error:'STOCK sheet not found'};
  var last=sh.getLastRow(),SSTART=3;
  if (last<SSTART) return {items:[],summary:{total_skus:0,total_value:0,total_sell_val:0,low_stock:0,out_of_stock:0}};
  var rows=sh.getRange(SSTART,1,last-SSTART+1,20).getValues();
  var items=rows.filter(function(r){return r[0];}).map(function(r){
    var item = {sku:String(r[0]||''),product:String(r[1]||''),category:String(r[2]||''),
                color:String(r[3]||''),size:String(r[4]||''),opening:Number(r[5]||0),
                purchased:Number(r[6]||0),sold:Number(r[7]||0),returned:Number(r[8]||0),
                damaged:Number(r[9]||0),reserved:Number(r[10]||0),current_stock:Number(r[11]||0),
                available:Number(r[12]||0),reorder_level:Number(r[13]||0),
                status:String(r[14]||'').replace(/[✅⚠️❌]\s?/g,''),
                stock_value:Number(r[15]||0),sell_value:Number(r[16]||0),potential_profit:Number(r[17]||0)};
    var storedMeta = parseStockMeta_(r[19]);
    var meta = mergeStockMeta_(inferCollectionStockMeta_(item), storedMeta);
    item.collectionCode = meta.collectionCode;
    item.collectionType = meta.collectionType;
    item.genderType = meta.genderType || meta.collectionType;
    item.sizeCategory = meta.sizeCategory || meta.sizeGroup;
    item.sizeValue = meta.sizeValue || item.size;
    item.sizeGroup = meta.sizeGroup || meta.sizeCategory;
    item.variantGroup = meta.variantGroup;
    item.buyingPrice = Number(meta.buyingPrice || stockBuyingPrice_(item));
    item.stockQty = item.available;
    item.barcode = meta.barcode || '';
    item.active = meta.active !== false && !meta.archived && item.status !== 'ARCHIVED';
    item.archived = !!meta.archived || item.status === 'ARCHIVED';
    item.imageUrl = meta.imageUrl || '';
    return item;
  });
  var activeItems = items.filter(function(i){ return !i.archived && i.active !== false; });
  return {items:items,summary:{total_skus:activeItems.length,
    total_value:activeItems.reduce(function(a,i){return a+i.stock_value;},0),
    total_sell_val:activeItems.reduce(function(a,i){return a+i.sell_value;},0),
    low_stock:activeItems.filter(function(i){return i.available>0&&i.available<=i.reorder_level;}).length,
    out_of_stock:activeItems.filter(function(i){return i.available<=0;}).length,
    archived:items.filter(function(i){return i.archived;}).length}};
}

function parseStockMeta_(value) {
  var s = String(value || '').trim();
  if (!s || s.charAt(0) !== '{') return {};
  try { return JSON.parse(s); } catch (e) { return {}; }
}

function mergeStockMeta_(base, extra) {
  var out = {};
  Object.keys(base || {}).forEach(function(k){ out[k] = base[k]; });
  Object.keys(extra || {}).forEach(function(k){ if (extra[k] !== '' && extra[k] != null) out[k] = extra[k]; });
  return out;
}

function writeStockMeta_(sh, row, meta) {
  sh.getRange(row, 20).setValue(JSON.stringify(meta || {}).slice(0, 12000));
}

function menCollectionCodeMap_() {
  var codes = ['133','13','231','111','475','476','240','223','224','345','609','120','130','131','150','110','115','720','20','212'];
  var map = {};
  codes.forEach(function(c){ map[c] = true; });
  return map;
}

function sizeGroupForOrderSize_(size) {
  var raw = String(size || '').trim().toUpperCase();
  if (raw === 'KIDS' || raw === 'ADULT') return raw;
  var n = Number(size);
  if (n >= 16 && n <= 36) return 'KIDS';
  if (n >= 38 && n <= 54) return 'ADULT';
  return '';
}

function normalizeWomenVariantGroup_(value) {
  var v = String(value || '').toUpperCase();
  if (!v) return '';
  if (v.indexOf('ORNA') !== -1) return 'ORNA';
  if (v.indexOf('THREE') !== -1 || v.indexOf('3 PIECE') !== -1 || v.indexOf('3PC') !== -1) return 'THREE PIECE';
  if (v.indexOf('TWO') !== -1 || v.indexOf('2 PIECE') !== -1 || v.indexOf('2PC') !== -1 || v.indexOf('10Y') !== -1 || v.indexOf('14Y') !== -1 || v.indexOf('10-14') !== -1 || v.indexOf('6Y') !== -1 || v.indexOf('9Y') !== -1 || v.indexOf('6-9') !== -1 || v.indexOf('1Y') !== -1 || v.indexOf('5Y') !== -1 || v.indexOf('1-5') !== -1 || v.indexOf('2Y') !== -1 || v.indexOf('2-5') !== -1) return 'TWO PIECE';
  return '';
}

function inferCollectionStockMeta_(item) {
  var raw = [item.sku, item.product, item.category, item.color, item.size].join(' ').toUpperCase();
  var match = raw.match(/\b\d{2,3}T?\b/);
  var code = match ? match[0] : '';
  var menMap = menCollectionCodeMap_();
  var type = '';
  if (/^\d+T$/.test(code)) type = 'WOMEN';
  else if (menMap[code]) type = 'MEN';
  return {
    collectionCode: code,
    collectionType: type,
    sizeGroup: type === 'MEN' ? sizeGroupForOrderSize_(item.size) : '',
    variantGroup: type === 'WOMEN' ? normalizeWomenVariantGroup_([item.size, item.color, item.product].join(' ')) : '',
  };
}

function stockBuyingPrice_(item) {
  if (item.current_stock > 0 && item.stock_value > 0) return Math.round((item.stock_value / item.current_stock) * 100) / 100;
  if (item.opening > 0 && item.stock_value > 0) return Math.round((item.stock_value / item.opening) * 100) / 100;
  return 0;
}

function smartFashionSku_(code, sizeValue, variantGroup) {
  var c = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  var v = String(variantGroup || '').toUpperCase();
  var s = String(sizeValue || '').trim().toUpperCase();
  if (s) return c + '-' + s;
  v = normalizeWomenVariantGroup_(v) || v;
  if (v === 'ORNA') return c + '-ORNA';
  if (v === 'THREE PIECE') return c + '-THREE-PIECE';
  if (v === 'TWO PIECE') return c + '-TWO-PIECE';
  if (v) return c + '-' + v.replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return c;
}

function getProductMasterSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var i;
  for (i = 0; i < PRODUCT_MASTER_ALIASES.length; i++) {
    var sh = ss.getSheetByName(PRODUCT_MASTER_ALIASES[i]);
    if (sh) return sh;
  }
  return null;
}

/** Headers on row 2 (row 1 may be a brand banner). */
function productMasterHeaderMap_(sh) {
  var lc = sh.getLastColumn();
  if (lc < 1) return {};
  var headers = sh.getRange(2, 1, 2, lc).getValues()[0];
  var map = {};
  var c;
  for (c = 0; c < headers.length; c++) {
    var h = String(headers[c] || '')
      .trim()
      .toUpperCase()
      .replace(/[\s\-\/.]+/g, '_');
    if (h) map[h] = c + 1;
  }
  return map;
}

function pmResolveCol_(map, candidates, fallback1Based) {
  var j;
  for (j = 0; j < candidates.length; j++) {
    var k = candidates[j].toUpperCase().replace(/[\s\-\/.]+/g, '_');
    if (map[k]) return map[k];
  }
  return fallback1Based;
}

function loadExistingProductMasterKeys_(sh, map) {
  var skus = {};
  var supplierIds = {};
  var nameLower = {};
  var last = sh.getLastRow();
  if (last < PM_DATA_START) return { skus: skus, supplierIds: supplierIds, nameLower: nameLower };
  var cSku = pmResolveCol_(map, ['SKU', 'PRODUCT_SKU', 'ITEM_SKU'], 1);
  var cName = pmResolveCol_(map, ['PRODUCT_NAME', 'PRODUCT', 'NAME', 'ITEM_NAME'], 2);
  var cSid = pmResolveCol_(map, ['SUPPLIER_PRODUCT_ID', 'SUPPLIER_ID', 'EXTERNAL_ID', 'SOURCE_ID'], 10);
  var skuCol = sh.getRange(PM_DATA_START, cSku, last, cSku).getValues();
  var nameCol = sh.getRange(PM_DATA_START, cName, last, cName).getValues();
  var sidCol = [];
  if (cSid) {
    sidCol = sh.getRange(PM_DATA_START, cSid, last, cSid).getValues();
  }
  var r;
  for (r = 0; r < skuCol.length; r++) {
    var s = String(skuCol[r][0] || '').trim();
    if (s) skus[s.toLowerCase()] = true;
    var nm = String(nameCol[r][0] || '').trim().toLowerCase();
    if (nm) nameLower[nm] = true;
    if (sidCol.length) {
      var sid = String(sidCol[r][0] || '').trim();
      if (sid) supplierIds[sid.toLowerCase()] = true;
    }
  }
  return { skus: skus, supplierIds: supplierIds, nameLower: nameLower };
}

function nextSupplierSku_() {
  var p = PropertiesService.getScriptProperties();
  var key = 'ALMA_SUPPLIER_IMPORT_SKU_SEQ';
  var n = parseInt(p.getProperty(key) || '0', 10) + 1;
  p.setProperty(key, String(n));
  var s = '000000' + String(n % 1000000);
  return 'ALM-SCH-' + s.slice(-6);
}

function getProducts_() {
  var sh = getProductMasterSheet_();
  if (!sh) return { products: [], total: 0, error: 'PRODUCT MASTER sheet not found' };
  var map = productMasterHeaderMap_(sh);
  var cSku = pmResolveCol_(map, ['SKU', 'PRODUCT_SKU'], 1);
  var cName = pmResolveCol_(map, ['PRODUCT_NAME', 'PRODUCT', 'NAME'], 2);
  var cCat = pmResolveCol_(map, ['CATEGORY', 'CAT'], 3);
  var cCogs = pmResolveCol_(map, ['DEFAULT_COGS', 'COGS', 'COST'], 4);
  var cPrice = pmResolveCol_(map, ['DEFAULT_PRICE', 'PRICE', 'SELL_PRICE', 'RETAIL'], 5);
  var cActive = pmResolveCol_(map, ['ACTIVE', 'ENABLED', 'STATUS'], 6);
  var cNotes = pmResolveCol_(map, ['NOTES', 'NOTE', 'REMARKS'], 7);
  var last = sh.getLastRow();
  if (last < PM_DATA_START) return { products: [], total: 0 };
  var lc = Math.max(sh.getLastColumn(), cSku, cName, cCat, cCogs, cPrice, cActive, cNotes);
  var values = sh.getRange(PM_DATA_START, 1, last, lc).getValues();
  var out = [];
  var i;
  for (i = 0; i < values.length; i++) {
    var row = values[i];
    var sku = String(row[cSku - 1] || '').trim();
    var name = String(row[cName - 1] || '').trim();
    if (!sku && !name) continue;
    var activeCell = row[cActive - 1];
    var active = true;
    if (activeCell === false) active = false;
    else {
      var as = String(activeCell).toUpperCase();
      if (as === 'N' || as === 'NO' || as === 'FALSE' || as === '0') active = false;
    }
    out.push({
      id: sku || name,
      sku: sku,
      name: name,
      category: String(row[cCat - 1] || ''),
      default_price: Number(row[cPrice - 1] || 0),
      default_cogs: Number(row[cCogs - 1] || 0),
      active: active,
      notes: String(row[cNotes - 1] || ''),
      updated_at: '',
    });
  }
  return { products: out, total: out.length };
}

function batchImportProductMaster_(body) {
  var items = body.items;
  if (!items || !items.length) return { error: 'items array required' };
  var maxB = 40;
  if (items.length > maxB) return { error: 'Too many items (max ' + maxB + ' per request). Split the import.' };
  var sh = getProductMasterSheet_();
  if (!sh) {
    return {
      error:
        'PRODUCT MASTER sheet not found — create a tab named PRODUCT MASTER with headers in row 2 (SKU, Product name, …).',
    };
  }
  var map = productMasterHeaderMap_(sh);
  var keys = loadExistingProductMasterKeys_(sh, map);
  var skipDupNames = !!body.skip_duplicate_names;
  var lastCol = Math.max(sh.getLastColumn(), 12);
  var created = [];
  var skipped = [];
  var errors = [];
  var setPmCell = function (row, cNum, val) {
    if (cNum >= 1 && cNum <= row.length) row[cNum - 1] = val;
  };
  var idx;
  for (idx = 0; idx < items.length; idx++) {
    var raw = items[idx];
    var skuIn = String(raw.sku || '').trim();
    var name = String(raw.name || raw.product || '').trim();
    if (!name) {
      errors.push({ index: idx, message: 'missing name' });
      continue;
    }
    var sku = skuIn || nextSupplierSku_();
    var sid = String(raw.supplier_product_id || raw.external_id || '').trim();
    var sSku = sku.toLowerCase();
    var sName = name.toLowerCase();
    var sSid = sid.toLowerCase();
    if (keys.skus[sSku]) {
      skipped.push({ sku: sku, reason: 'duplicate_sku' });
      continue;
    }
    if (sid && keys.supplierIds[sSid]) {
      skipped.push({ sku: sku, reason: 'duplicate_supplier_id' });
      continue;
    }
    if (skipDupNames && keys.nameLower[sName]) {
      skipped.push({ sku: sku, reason: 'duplicate_name' });
      continue;
    }
    var row = [];
    var c;
    for (c = 0; c < lastCol; c++) row.push('');
    setPmCell(row, pmResolveCol_(map, ['SKU'], 1), sku);
    setPmCell(row, pmResolveCol_(map, ['PRODUCT_NAME', 'PRODUCT', 'NAME'], 2), name);
    setPmCell(row, pmResolveCol_(map, ['CATEGORY', 'CAT'], 3), String(raw.category || ''));
    setPmCell(row, pmResolveCol_(map, ['DEFAULT_COGS', 'COGS', 'COST'], 4), Number(raw.default_cogs || raw.cogs || 0));
    setPmCell(row, pmResolveCol_(map, ['DEFAULT_PRICE', 'PRICE', 'SELL_PRICE'], 5), Number(raw.default_price || raw.price || 0));
    var active = raw.active !== false;
    setPmCell(row, pmResolveCol_(map, ['ACTIVE', 'ENABLED'], 6), active ? 'Y' : 'N');
    setPmCell(row, pmResolveCol_(map, ['NOTES', 'NOTE'], 7), String(raw.notes || '').slice(0, 500));
    setPmCell(row, pmResolveCol_(map, ['IMAGE_URL', 'IMAGE', 'PHOTO'], 8), String(raw.image_url || raw.image || '').slice(0, 1000));
    setPmCell(row, pmResolveCol_(map, ['SUPPLIER', 'SUPPLIER_TAG'], 9), String(raw.supplier || 'SmartChinaHub').slice(0, 120));
    setPmCell(row, pmResolveCol_(map, ['SUPPLIER_PRODUCT_ID', 'EXTERNAL_ID'], 10), sid.slice(0, 200));
    setPmCell(row, pmResolveCol_(map, ['DESCRIPTION', 'DESC'], 11), String(raw.description || '').slice(0, 5000));
    var vj = '';
    try {
      vj = typeof raw.variants_json === 'string' ? raw.variants_json : JSON.stringify(raw.variants || []);
    } catch (e0) {
      vj = '';
    }
    setPmCell(row, pmResolveCol_(map, ['VARIANTS', 'VARIANTS_JSON', 'OPTIONS'], 12), String(vj).slice(0, 8000));
    try {
      sh.appendRow(row);
      keys.skus[sSku] = true;
      if (sid) keys.supplierIds[sSid] = true;
      keys.nameLower[sName] = true;
      created.push(sku);
    } catch (e1) {
      errors.push({ index: idx, sku: sku, message: String(e1.message || e1) });
    }
  }
  if (created.length) {
    apiLog_(
      'IMPORT',
      'PRODUCT_MASTER',
      'Supplier batch',
      'created=' + created.length + ' skipped=' + skipped.length + ' errors=' + errors.length,
    );
  }
  return { ok: true, created: created, skipped: skipped, errors: errors };
}

/**
 * After PRODUCT MASTER insert, append a matching 📦 STOCK CONTROL row so the Inventory UI lists the SKU.
 * Skips when the sheet is missing, SKU is empty, or that SKU already exists in column A (case-insensitive).
 */
function appendStockRowForNewProduct_(body, sku, productName) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.STOCK);
  if (!sh) return { ok: false, reason: 'no_stock_sheet' };
  var skuNorm = String(sku || '').trim().toLowerCase();
  if (!skuNorm) return { ok: false, reason: 'no_sku' };
  var row = buildStockRowForNewProduct_(body, sku, productName);
  var SSTART = 3;
  var last = sh.getLastRow();
  if (last >= SSTART) {
    var existingRows = sh.getRange(SSTART, 1, last - SSTART + 1, 20).getValues();
    var r;
    for (r = 0; r < existingRows.length; r++) {
      if (String(existingRows[r][0] || '').trim().toLowerCase() === skuNorm) {
        var existingMeta = parseStockMeta_(existingRows[r][19]);
        var archived = !!existingMeta.archived || String(existingRows[r][14] || '').toUpperCase().indexOf('ARCHIVED') !== -1;
        if (archived && !inventoryHasLinkedOrders_(sku)) {
          sh.getRange(SSTART + r, 1, 1, row.length).setValues([row]);
          return { ok: true, reason: 'reactivated_archived_sku' };
        }
        return { ok: false, reason: 'stock_sku_exists' };
      }
    }
  }
  sh.appendRow(row);
  return { ok: true, reason: 'appended' };
}

function buildStockRowForNewProduct_(body, sku, productName) {
  var cat = String(body.category || '');
  var color = String(body.color || '');
  var size = String(body.size || '');
  var qty = Number(body.initial_stock != null ? body.initial_stock : body.stock != null ? body.stock : 0);
  if (isNaN(qty) || qty < 0) qty = 0;
  var reorder = Number(body.reorder_level != null ? body.reorder_level : body.reorder != null ? body.reorder : 0);
  if (isNaN(reorder) || reorder < 0) reorder = 0;
  var unitPrice = Number(body.default_price || body.price || 0);
  var unitCogs = Number(body.default_cogs || body.cogs || 0);
  if (isNaN(unitPrice)) unitPrice = 0;
  if (isNaN(unitCogs)) unitCogs = 0;
  var collectionType = String(body.collection_type || body.collectionType || '').trim().toUpperCase();
  var sizeCategory = String(body.size_category || body.sizeCategory || body.size_group || body.sizeGroup || '').trim().toUpperCase();
  var sizeValue = String(body.size_value || body.sizeValue || size || '').trim();
  if (collectionType === 'MEN') {
    sizeCategory = sizeGroupForOrderSize_(sizeCategory || sizeValue || size);
    sizeValue = sizeCategory || sizeValue;
    size = sizeCategory || size;
  }
  var variantGroup = String(body.variant_group || body.variantGroup || '').trim();
  if (collectionType === 'WOMEN') {
    variantGroup = normalizeWomenVariantGroup_(variantGroup || sizeValue || size);
    sizeValue = '';
    size = variantGroup || size;
  }
  var stockVal = unitCogs * qty;
  var sellVal = unitPrice * qty;
  var pot = sellVal - stockVal;
  var statusDisp = qty > 0 ? '✅ IN STOCK' : '❌ OUT OF STOCK';
  var meta = {
    collectionCode: String(body.collection_code || body.collectionCode || '').trim().toUpperCase(),
    collectionType: collectionType,
    genderType: String(body.gender_type || body.genderType || body.collection_type || body.collectionType || '').trim().toUpperCase(),
    sizeCategory: sizeCategory,
    sizeValue: sizeValue,
    variantGroup: variantGroup,
    buyingPrice: unitCogs,
    stockQty: qty,
    barcode: String(body.barcode || '').trim(),
    active: body.active !== false,
    archived: false,
    imageUrl: String(body.image_url || body.imageUrl || '').trim(),
  };
  var row = [
    sku,
    productName,
    cat,
    color,
    size,
    qty,
    0,
    0,
    0,
    0,
    0,
    qty,
    qty,
    reorder,
    statusDisp,
    stockVal,
    sellVal,
    pot,
    '',
    JSON.stringify(meta),
  ];
  while (row.length < 20) row.push('');
  return row;
}

function createProduct_(body) {
  if (body.inventory_mode === 'collection' && body.bulk_rows && body.bulk_rows.length) {
    return createFashionCollectionInventory_(body);
  }
  var name = String(body.name || '').trim();
  if (!name) return { error: 'name required' };
  var sku = String(body.sku || '').trim();
  if (!sku) sku = nextSupplierSku_();
  var it = {
    sku: sku,
    name: name,
    category: String(body.category || '').trim(),
    default_cogs: Number(body.default_cogs || body.cogs || 0),
    default_price: Number(body.default_price || body.price || 0),
    active: body.active !== false,
    notes: String(body.notes || '').trim(),
    image_url: String(body.image_url || '').trim(),
    supplier: String(body.supplier || 'manual').trim(),
    supplier_product_id: String(body.supplier_product_id || '').trim(),
    description: String(body.description || '').trim(),
    variants_json: typeof body.variants_json === 'string' ? body.variants_json : '',
    variants: body.variants,
  };
  var res = batchImportProductMaster_({ items: [it], skip_duplicate_names: !!body.skip_duplicate_name_check });
  if (res.error) return { error: res.error };
  if (res.errors && res.errors.length) return { error: res.errors[0].message || 'create failed' };
  if (res.created && res.created.length) {
    var skuFinal = String(res.created[0] || sku).trim();
    var stockInfo = { ok: false, reason: 'skipped' };
    if (body.sync_to_stock !== false) {
      stockInfo = appendStockRowForNewProduct_(body, skuFinal, name);
    }
    return { ok: true, product_id: skuFinal, stock: stockInfo };
  }
  if (res.skipped && res.skipped.length) {
    return { error: 'Duplicate or skipped: ' + res.skipped[0].reason, duplicate: true };
  }
  return { error: 'Unknown create result' };
}

function createFashionCollectionInventory_(body) {
  var rows = body.bulk_rows || [];
  if (!rows.length) return { error: 'bulk_rows required' };
  var created = [];
  var skipped = [];
  var stockResults = [];
  rows.forEach(function(raw) {
    var code = String(raw.collectionCode || body.collection_code || '').trim().toUpperCase();
    var type = String(raw.collectionType || body.collection_type || '').trim().toUpperCase();
    var sizeGroup = type === 'MEN' ? sizeGroupForOrderSize_(raw.sizeCategory || raw.sizeGroup || raw.sizeValue || '') : '';
    var variantGroup = type === 'WOMEN' ? normalizeWomenVariantGroup_(raw.variantGroup || raw.sizeValue || '') : String(raw.variantGroup || '').trim();
    var sizeValue = type === 'MEN' ? sizeGroup : String(raw.sizeValue || '');
    var sku = String(raw.sku || smartFashionSku_(code, sizeValue, variantGroup)).trim();
    var label = type === 'MEN'
      ? code + ' ' + sizeGroup
      : code + ' ' + String(variantGroup || raw.sizeValue || type || 'Inventory');
    var productBody = {
      sku: sku,
      name: raw.product || label,
      category: raw.category || (type === 'WOMEN' ? 'Women' : type === 'MEN' ? 'Panjabi' : type === 'SINGLE' ? 'Single Product' : 'Custom Collection'),
      default_cogs: Number(raw.buyingPrice || 0),
      default_price: 0,
      color: '',
      size: sizeValue || variantGroup || '',
      initial_stock: Number(raw.stockQty || 0),
      reorder_level: Number(body.reorder_level || 0),
      image_url: raw.imageUrl || body.image_url || '',
      collection_code: code,
      collection_type: type,
      gender_type: raw.genderType || type,
      size_category: sizeGroup || raw.sizeCategory || '',
      size_value: sizeValue || '',
      variant_group: variantGroup || '',
      barcode: raw.barcode || '',
      active: raw.active !== false,
      skip_duplicate_name_check: false,
      sync_to_stock: true,
    };
    var stock = appendStockRowForNewProduct_(productBody, sku, productBody.name);
    if (stock.ok) {
      created.push(sku);
      stockResults.push({ sku: sku, ok: true });
    } else {
      skipped.push({ sku: sku, reason: stock.reason || 'skipped' });
    }
  });
  apiLog_('INVENTORY_CREATE', String(body.collection_code || ''), 'Fashion collection rows created=' + created.length, JSON.stringify({ created: created, skipped: skipped }).slice(0, 1000));
  return { ok: true, product_id: String(body.collection_code || created[0] || ''), created: created, skipped: skipped, stock: { ok: true, rows: stockResults } };
}

function findStockRowBySku_(sku) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.STOCK);
  if (!sh) throw new Error('STOCK sheet not found');
  var last = sh.getLastRow();
  if (last < 3) return null;
  var values = sh.getRange(3, 1, last - 2, 20).getValues();
  var target = String(sku || '').trim().toLowerCase();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim().toLowerCase() === target) {
      return { sh: sh, row: i + 3, data: values[i] };
    }
  }
  return null;
}

function inventoryHasLinkedOrders_(sku) {
  var target = String(sku || '').trim().toLowerCase();
  var itemSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ORDER_ITEMS);
  if (itemSh && itemSh.getLastRow() >= 2) {
    var vals = itemSh.getRange(2, 1, itemSh.getLastRow() - 1, Math.max(19, itemSh.getLastColumn())).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][13] || vals[i][2] || '').trim().toLowerCase() === target) return true;
    }
  }
  var orderSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ORDERS);
  if (orderSh && orderSh.getLastRow() >= ORDERS_DATA_START) {
    var rows = orderSh.getRange(ORDERS_DATA_START, 1, orderSh.getLastRow() - ORDERS_DATA_START + 1, TOTAL_COLS).getValues();
    for (var j = 0; j < rows.length; j++) {
      if (String(rows[j][OC.SKU - 1] || '').trim().toLowerCase() === target) return true;
    }
  }
  return false;
}

function inventoryEdit_(body) {
  if (!body.sku) return { error: 'sku required' };
  var ref = findStockRowBySku_(body.sku);
  if (!ref) return { error: 'Inventory item not found: ' + body.sku };
  var data = body.data || {};
  var linked = inventoryHasLinkedOrders_(body.sku);
  if (linked && (data.sku || data.collectionCode || data.collection_code || data.sizeValue || data.size_value || data.variantGroup || data.variant_group)) {
    return { error: 'Inventory identity is locked because linked orders exist. Archive and create a new version instead.' };
  }
  var meta = parseStockMeta_(ref.data[19]);
  var before = JSON.stringify({ row: ref.data, meta: meta }).slice(0, 4000);
  if (data.product) ref.sh.getRange(ref.row, 2).setValue(String(data.product));
  if (data.category) ref.sh.getRange(ref.row, 3).setValue(String(data.category));
  if (data.sizeValue || data.size_value) ref.sh.getRange(ref.row, 5).setValue(String(data.sizeValue || data.size_value));
  if (data.buyingPrice != null || data.buying_price != null) {
    var buying = Number(data.buyingPrice != null ? data.buyingPrice : data.buying_price);
    var qty = Number(ref.sh.getRange(ref.row, 12).getValue() || 0);
    ref.sh.getRange(ref.row, 16).setValue(buying * qty);
    meta.buyingPrice = buying;
  }
  ['collectionCode','collectionType','genderType','sizeCategory','sizeValue','variantGroup','barcode','imageUrl','active'].forEach(function(k) {
    if (data[k] !== undefined) meta[k] = data[k];
  });
  writeStockMeta_(ref.sh, ref.row, meta);
  apiLog_('INVENTORY_EDIT', String(body.sku), 'Inventory edited', before);
  return { ok: true, sku: String(body.sku), linked_orders: linked };
}

function inventoryArchive_(body) {
  var ref = findStockRowBySku_(body.sku);
  if (!ref) return { error: 'Inventory item not found: ' + body.sku };
  var meta = parseStockMeta_(ref.data[19]);
  meta.archived = true;
  meta.active = false;
  meta.archiveReason = String(body.reason || body.note || '');
  meta.archivedAt = new Date().toISOString();
  ref.sh.getRange(ref.row, 15).setValue('ARCHIVED');
  writeStockMeta_(ref.sh, ref.row, meta);
  apiLog_('INVENTORY_ARCHIVE', String(body.sku), 'Inventory archived', JSON.stringify(meta).slice(0, 1000));
  return { ok: true, sku: String(body.sku), archived: true };
}

function inventoryRestore_(body) {
  var ref = findStockRowBySku_(body.sku);
  if (!ref) return { error: 'Inventory item not found: ' + body.sku };
  var meta = parseStockMeta_(ref.data[19]);
  meta.archived = false;
  meta.active = true;
  var available = Number(ref.data[12] || 0);
  var reorder = Number(ref.data[13] || 0);
  ref.sh.getRange(ref.row, 15).setValue(available <= 0 ? '❌ OUT OF STOCK' : available <= reorder ? '⚠️ LOW STOCK' : '✅ IN STOCK');
  writeStockMeta_(ref.sh, ref.row, meta);
  apiLog_('INVENTORY_RESTORE', String(body.sku), 'Inventory restored', '');
  return { ok: true, sku: String(body.sku), archived: false };
}

function inventoryAdjust_(body) {
  var ref = findStockRowBySku_(body.sku);
  if (!ref) return { error: 'Inventory item not found: ' + body.sku };
  var prev = Number(ref.data[12] || 0);
  var next = Number(body.new_stock);
  if (isNaN(next) || next < 0) return { error: 'new_stock must be >= 0' };
  var buying = Number(body.buying_price != null ? body.buying_price : stockBuyingPrice_({
    current_stock: Number(ref.data[11] || 0),
    opening: Number(ref.data[5] || 0),
    stock_value: Number(ref.data[15] || 0)
  }));
  var delta = next - prev;
  var reorder = Number(ref.data[13] || 0);
  ref.sh.getRange(ref.row, 12).setValue(next);
  ref.sh.getRange(ref.row, 13).setValue(next);
  ref.sh.getRange(ref.row, 16).setValue(buying * next);
  ref.sh.getRange(ref.row, 15).setValue(next <= 0 ? '❌ OUT OF STOCK' : next <= reorder ? '⚠️ LOW STOCK' : '✅ IN STOCK');
  ref.sh.getRange(ref.row, 19).setValue(new Date()).setNumberFormat('dd-MMM-yyyy');
  var meta = parseStockMeta_(ref.data[19]);
  meta.buyingPrice = buying;
  meta.stockQty = next;
  writeStockMeta_(ref.sh, ref.row, meta);
  apiLog_('INVENTORY_ADJUST', String(body.sku), 'Stock adjusted ' + prev + ' → ' + next, JSON.stringify({ previous_stock: prev, new_stock: next, adjustment: delta, reason: body.reason || '', note: body.note || '' }));
  return { ok: true, sku: String(body.sku), previous_stock: prev, new_stock: next, adjustment: delta };
}

function inventoryBulkUpdate_(body) {
  var items = body.items || [];
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    out.push(inventoryAdjust_({ sku: item.sku, new_stock: item.new_stock, buying_price: item.buying_price, reason: body.reason || 'bulk_update', note: body.note || '' }));
  }
  return { ok: true, results: out };
}

function consolidateLifestyleInventory_(body) {
  var dryRun = body.dry_run !== false;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.STOCK);
  if (!sh) return { error: 'STOCK sheet not found' };
  var SSTART = 3;
  var last = sh.getLastRow();
  if (last < SSTART) return { ok: true, dry_run: dryRun, groups: [], archived: 0, created: 0, updated: 0 };

  var rows = sh.getRange(SSTART, 1, last - SSTART + 1, 20).getValues();
  var bySku = {};
  rows.forEach(function(row, idx) {
    var sku = String(row[0] || '').trim().toLowerCase();
    if (sku) bySku[sku] = { row: SSTART + idx, data: row };
  });

  function emptyAgg(code, type, key, targetSku, label, category) {
    return {
      code: code,
      type: type,
      key: key,
      targetSku: targetSku,
      label: label,
      category: category,
      opening: 0,
      purchased: 0,
      sold: 0,
      returned: 0,
      damaged: 0,
      reserved: 0,
      current: 0,
      available: 0,
      stockValue: 0,
      sellValue: 0,
      potential: 0,
      reorder: 0,
      sourceRows: [],
      sourceSkus: [],
    };
  }

  function addNumbers(agg, row, rowIndex) {
    agg.opening += Number(row[5] || 0);
    agg.purchased += Number(row[6] || 0);
    agg.sold += Number(row[7] || 0);
    agg.returned += Number(row[8] || 0);
    agg.damaged += Number(row[9] || 0);
    agg.reserved += Number(row[10] || 0);
    agg.current += Number(row[11] || 0);
    agg.available += Number(row[12] || 0);
    agg.stockValue += Number(row[15] || 0);
    agg.sellValue += Number(row[16] || 0);
    agg.potential += Number(row[17] || 0);
    agg.reorder = Math.max(agg.reorder, Number(row[13] || 0));
    agg.sourceRows.push(rowIndex);
    agg.sourceSkus.push(String(row[0] || ''));
  }

  function statusForQty(available, reorder) {
    return available <= 0 ? '❌ OUT OF STOCK' : available <= reorder ? '⚠️ LOW STOCK' : '✅ IN STOCK';
  }

  var groups = {};
  rows.forEach(function(row, idx) {
    if (!row[0] || rowIsArchived_(row)) return;
    var item = stockItemFromRow_(row);
    var meta = mergeStockMeta_(inferCollectionStockMeta_(item), parseStockMeta_(row[19]));
    var code = String(meta.collectionCode || '').toUpperCase();
    var type = String(meta.collectionType || '').toUpperCase();
    if (!code || (type !== 'MEN' && type !== 'WOMEN')) return;

    var targetSku = '';
    var key = '';
    var label = '';
    var category = String(row[2] || (type === 'WOMEN' ? 'Women' : 'Panjabi'));
    if (type === 'MEN') {
      var group = sizeGroupForOrderSize_(meta.sizeValue || item.size || '');
      if (!group) return;
      targetSku = smartFashionSku_(code, group, '');
      if (String(item.sku || '').toUpperCase() === targetSku) return;
      key = code + '|MEN|' + group;
      label = code + ' ' + group;
    } else {
      var variant = normalizeWomenVariantGroup_(meta.variantGroup || item.size || item.product || '');
      if (!variant) return;
      targetSku = smartFashionSku_(code, '', variant);
      if (String(item.sku || '').toUpperCase() === targetSku) return;
      key = code + '|WOMEN|' + variant;
      label = code + ' ' + variant;
    }

    if (!groups[key]) groups[key] = emptyAgg(code, type, key, targetSku, label, category);
    addNumbers(groups[key], row, SSTART + idx);
  });

  var summaries = [];
  var created = 0;
  var updated = 0;
  var archived = 0;
  Object.keys(groups).forEach(function(key) {
    var agg = groups[key];
    var target = bySku[String(agg.targetSku).toLowerCase()];
    summaries.push({
      target_sku: agg.targetSku,
      type: agg.type,
      sources: agg.sourceSkus,
      source_rows: agg.sourceRows,
      available_to_merge: agg.available,
      stock_value_to_merge: agg.stockValue,
      action: target ? 'update_target' : 'create_target'
    });
    if (dryRun) return;

    var buying = agg.current > 0 && agg.stockValue > 0 ? Math.round((agg.stockValue / agg.current) * 100) / 100 : 0;
    if (target) {
      var data = target.data;
      var nextOpening = Number(data[5] || 0) + agg.opening;
      var nextPurchased = Number(data[6] || 0) + agg.purchased;
      var nextSold = Number(data[7] || 0) + agg.sold;
      var nextReturned = Number(data[8] || 0) + agg.returned;
      var nextDamaged = Number(data[9] || 0) + agg.damaged;
      var nextReserved = Number(data[10] || 0) + agg.reserved;
      var nextCurrent = Number(data[11] || 0) + agg.current;
      var nextAvailable = Number(data[12] || 0) + agg.available;
      var nextStockValue = Number(data[15] || 0) + agg.stockValue;
      var nextSellValue = Number(data[16] || 0) + agg.sellValue;
      var nextPotential = Number(data[17] || 0) + agg.potential;
      var reorder = Math.max(Number(data[13] || 0), agg.reorder);
      sh.getRange(target.row, 2, 1, 18).setValues([[
        agg.label, agg.category, '', agg.type === 'MEN' ? agg.key.split('|')[2] : agg.key.split('|')[2],
        nextOpening, nextPurchased, nextSold, nextReturned, nextDamaged, nextReserved,
        nextCurrent, nextAvailable, reorder, statusForQty(nextAvailable, reorder),
        nextStockValue, nextSellValue, nextPotential, new Date()
      ]]);
      var targetMeta = parseStockMeta_(data[19]);
      targetMeta.collectionCode = agg.code;
      targetMeta.collectionType = agg.type;
      targetMeta.genderType = agg.type;
      targetMeta.active = true;
      targetMeta.archived = false;
      targetMeta.buyingPrice = nextCurrent > 0 && nextStockValue > 0 ? Math.round((nextStockValue / nextCurrent) * 100) / 100 : buying;
      if (agg.type === 'MEN') {
        targetMeta.sizeCategory = agg.key.split('|')[2];
        targetMeta.sizeGroup = agg.key.split('|')[2];
        targetMeta.sizeValue = agg.key.split('|')[2];
        targetMeta.variantGroup = '';
      } else {
        targetMeta.sizeCategory = '';
        targetMeta.sizeValue = '';
        targetMeta.variantGroup = agg.key.split('|')[2];
      }
      targetMeta.consolidatedAt = new Date().toISOString();
      targetMeta.consolidatedFrom = (targetMeta.consolidatedFrom || []).concat(agg.sourceSkus).slice(-200);
      writeStockMeta_(sh, target.row, targetMeta);
      updated++;
    } else {
      var meta = {
        collectionCode: agg.code,
        collectionType: agg.type,
        genderType: agg.type,
        sizeCategory: agg.type === 'MEN' ? agg.key.split('|')[2] : '',
        sizeGroup: agg.type === 'MEN' ? agg.key.split('|')[2] : '',
        sizeValue: agg.type === 'MEN' ? agg.key.split('|')[2] : '',
        variantGroup: agg.type === 'WOMEN' ? agg.key.split('|')[2] : '',
        buyingPrice: buying,
        stockQty: agg.available,
        barcode: agg.targetSku,
        active: true,
        archived: false,
        consolidatedAt: new Date().toISOString(),
        consolidatedFrom: agg.sourceSkus,
      };
      var row = [
        agg.targetSku,
        agg.label,
        agg.category,
        '',
        agg.type === 'MEN' ? agg.key.split('|')[2] : agg.key.split('|')[2],
        agg.opening,
        agg.purchased,
        agg.sold,
        agg.returned,
        agg.damaged,
        agg.reserved,
        agg.current,
        agg.available,
        agg.reorder,
        statusForQty(agg.available, agg.reorder),
        agg.stockValue,
        agg.sellValue,
        agg.potential,
        new Date(),
        JSON.stringify(meta)
      ];
      sh.appendRow(row);
      created++;
    }

    agg.sourceRows.forEach(function(rowIndex) {
      var source = sh.getRange(rowIndex, 1, 1, 20).getValues()[0];
      var meta = parseStockMeta_(source[19]);
      meta.archived = true;
      meta.active = false;
      meta.archiveReason = 'Consolidated into ' + agg.targetSku;
      meta.archivedAt = new Date().toISOString();
      meta.consolidatedInto = agg.targetSku;
      sh.getRange(rowIndex, 15).setValue('ARCHIVED');
      writeStockMeta_(sh, rowIndex, meta);
      archived++;
    });
  });

  apiLog_('INVENTORY_CONSOLIDATE', 'ALMA_LIFESTYLE', dryRun ? 'Lifestyle consolidation dry run' : 'Lifestyle consolidation applied', JSON.stringify({ groups: summaries.length, created: created, updated: updated, archived: archived }).slice(0, 1000));
  return { ok: true, dry_run: dryRun, groups: summaries, created: created, updated: updated, archived: archived };
}

function expenseMatchesBiz_(subCatBiz, requestedBiz) {
  var rq = requestedBiz ? String(requestedBiz).trim() : '';
  if (!rq) return true;
  var sb = String(subCatBiz || '').trim();
  if (!sb && rq === 'ALMA_LIFESTYLE') return true;
  if (!sb && rq === 'CREATIVE_DIGITAL_IT') return false;
  return sb === rq;
}

function expenseInRange_(dateVal, start, end) {
  var d = fmtDate_(dateVal);
  if (!d) return !start && !end;
  var s = start ? String(start).slice(0, 10) : '';
  var e = end ? String(end).slice(0, 10) : '';
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}

function parsePaymentStatus_(notes) {
  var m = String(notes || '').match(/\[PS:([^\]]+)\]/);
  return m ? m[1] : 'Paid';
}

function stripPaymentStatus_(notes) {
  return String(notes || '').replace(/\[PS:[^\]]+\]\s*/, '').trim();
}

function getFinance_(p) {
  p = p || {};
  var reqBiz = p.business_id ? resolveBusinessId_(p.business_id) : '';
  var start = p.startDate || '';
  var end = p.endDate || '';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.EXPENSE);
  var expenses = [];
  var byCat = {};
  var byType = {};
  if (sh) {
    var last = sh.getLastRow();
    var ESTART = 6;
    if (last >= ESTART) {
      sh.getRange(ESTART, 1, last - ESTART + 1, 17).getValues().forEach(function (r) {
        if (!r[4]) return;
        var rowBizCell = String(r[5] || '').trim();
        if (!expenseMatchesBiz_(rowBizCell, reqBiz)) return;
        if (!expenseInRange_(r[1], start, end)) return;
        var cat = String(r[4] || '');
        var type = String(r[6] || '');
        var amount = Number(r[9] || 0);
        var nRaw = String(r[16] || '');
        var ps = parsePaymentStatus_(nRaw);
        var notesShow = stripPaymentStatus_(nRaw);
        var bid = rowBizCell || 'ALMA_LIFESTYLE';
        byCat[cat] = (byCat[cat] || 0) + amount;
        byType[type] = (byType[type] || 0) + amount;
        expenses.push({
          exp_id: String(r[0] || ''),
          date: fmtDate_(r[1]),
          month: String(r[2] || ''),
          category: cat,
          business_id: bid,
          sub_cat: String(r[5] || ''),
          exp_type: type,
          title: String(r[7] || ''),
          desc: String(r[7] || ''),
          vendor: String(r[8] || ''),
          amount: amount,
          payment_method: String(r[10] || ''),
          payment_status: ps,
          receipt_ref: String(r[12] || ''),
          recurring: String(r[6] || '').indexOf('Recurring') !== -1,
          notes: notesShow,
        });
      });
    }
  }
  var cashBal = 0;
  var cfSh = ss.getSheetByName(SHEETS.CASH_FLOW);
  if (cfSh && cfSh.getLastRow() >= 7) {
    var cfData = cfSh.getRange(7, 9, cfSh.getLastRow() - 6, 1).getValues();
    for (var i = cfData.length - 1; i >= 0; i--) {
      if (cfData[i][0]) {
        cashBal = Number(cfData[i][0]);
        break;
      }
    }
  }
  expenses.sort(function (a, b) {
    return String(b.date).localeCompare(String(a.date));
  });
  return {
    total_expenses: expenses.reduce(function (a, e) { return a + e.amount; }, 0),
    cash_balance: cashBal,
    by_category: byCat,
    by_type: byType,
    expenses: expenses,
    recent_expenses: expenses.slice(0, 20),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HR — Employees & Payroll (shared workbook; filtered by business_id)
// ═══════════════════════════════════════════════════════════════════════════════

function hrEnsureEmployees_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.EMPLOYEES);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.EMPLOYEES);
    sh.getRange(1, 1, 1, 11).setValues([[
      'emp_id', 'business_id', 'name', 'phone', 'email', 'address', 'role', 'joining_date',
      'monthly_salary', 'status', 'notes',
    ]]).setFontWeight('bold');
  }
  return sh;
}

function hrEnsurePayroll_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.HR_PAYROLL);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.HR_PAYROLL);
    sh.getRange(1, 1, 1, 9).setValues([[
      'tx_id', 'date', 'business_id', 'emp_id', 'emp_name', 'tx_type', 'amount', 'period_ym', 'note',
    ]]).setFontWeight('bold');
  }
  return sh;
}

function hrListEmployees_(p) {
  p = p || {};
  var biz = resolveBusinessId_(p.business_id || '');
  var sh = hrEnsureEmployees_();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 11).getValues().forEach(function (r) {
      if (!r[0]) return;
      if (String(r[1] || '').trim() !== biz) return;
      out.push({
        emp_id: String(r[0]),
        business_id: String(r[1]),
        name: String(r[2] || ''),
        phone: String(r[3] || ''),
        email: String(r[4] || ''),
        address: String(r[5] || ''),
        role: String(r[6] || ''),
        joining_date: fmtDate_(r[7]),
        monthly_salary: Number(r[8] || 0),
        status: String(r[9] || 'Active'),
        notes: String(r[10] || ''),
      });
    });
  }
  return { employees: out, total: out.length };
}

function hrUpsertEmployee_(body) {
  if (!body.name) return { error: 'name required' };
  var biz = resolveBusinessId_(body.business_id || '');
  var sh = hrEnsureEmployees_();
  var id = String(body.emp_id || '').trim();
  if (!id) id = 'EMP-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
  var last = sh.getLastRow();
  var rowIndex = -1;
  if (last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === id) {
        rowIndex = 2 + i;
        break;
      }
    }
  }
  var row = [
    id, biz, String(body.name), String(body.phone || ''), String(body.email || ''),
    String(body.address || ''), String(body.role || ''), body.joining_date ? new Date(body.joining_date) : '',
    Number(body.monthly_salary || 0), String(body.status || 'Active'), String(body.notes || ''),
  ];
  if (rowIndex > 0) {
    sh.getRange(rowIndex, 1, 1, 11).setValues([row]);
  } else {
    sh.appendRow(row);
  }
  sh.getRange(rowIndex > 0 ? rowIndex : sh.getLastRow(), 8).setNumberFormat('yyyy-mm-dd');
  SpreadsheetApp.flush();
  return { ok: true, emp_id: id };
}

function hrPatchEmployeeSalary_(body) {
  var empId = String(body.emp_id || '').trim();
  if (!empId) return { error: 'emp_id required' };
  var newSalary = Math.round(Number(body.monthly_salary));
  if (!isFinite(newSalary) || newSalary <= 0) return { error: 'monthly_salary must be positive' };
  var biz = resolveBusinessId_(body.business_id || '');
  var sh = hrEnsureEmployees_();
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'emp_id_not_found' };
  var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) !== empId) continue;
    if (biz && String(rows[i][1]) !== String(biz)) {
      return { ok: false, error: 'business_mismatch' };
    }
    var prevSalary = Math.round(Number(rows[i][8] || 0));
    sh.getRange(i + 2, 9).setValue(newSalary);
    SpreadsheetApp.flush();
    apiLog_(
      'EMPLOYEE_SALARY_UPDATE',
      empId,
      '৳' + prevSalary + ' → ৳' + newSalary,
      JSON.stringify({ business_id: biz, prev_salary: prevSalary, new_salary: newSalary }).slice(0, 300),
    );
    return {
      ok: true,
      emp_id: empId,
      prev_salary: prevSalary,
      new_salary: newSalary,
    };
  }
  return { ok: false, error: 'emp_id_not_found' };
}

function hrPayrollList_(p) {
  p = p || {};
  var biz = resolveBusinessId_(p.business_id || '');
  var empId = String(p.emp_id || '').trim();
  var sh = hrEnsurePayroll_();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 9).getValues().forEach(function (r) {
      if (!r[0]) return;
      if (String(r[2] || '').trim() !== biz) return;
      if (empId && String(r[3] || '') !== empId) return;
      if (p.startDate && fmtDate_(r[1]) < String(p.startDate).slice(0, 10)) return;
      if (p.endDate && fmtDate_(r[1]) > String(p.endDate).slice(0, 10)) return;
      out.push({
        tx_id: String(r[0]),
        date: fmtDate_(r[1]),
        business_id: String(r[2]),
        emp_id: String(r[3]),
        emp_name: String(r[4] || ''),
        tx_type: String(r[5] || ''),
        amount: Number(r[6] || 0),
        period_ym: String(r[7] || ''),
        note: String(r[8] || ''),
      });
    });
  }
  out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return { transactions: out, total: out.length };
}

function hrPayrollAppend_(body) {
  if (!body.emp_id) return { error: 'emp_id required' };
  if (!body.tx_type) return { error: 'tx_type required' };
  if (body.amount === undefined || body.amount === null) return { error: 'amount required' };
  var biz = resolveBusinessId_(body.business_id || '');
  var sh = hrEnsurePayroll_();
  var txId = 'PAY-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
  var d = body.date ? new Date(body.date) : new Date();
  var em = hrListEmployees_({ business_id: biz });
  var name = '';
  for (var i = 0; i < em.employees.length; i++) {
    if (em.employees[i].emp_id === String(body.emp_id)) {
      name = em.employees[i].name;
      break;
    }
  }
  var meta = [];
  if (body.advance_reason) meta.push('Reason: ' + String(body.advance_reason).slice(0, 200));
  if (body.requested_by) meta.push('Requested by: ' + String(body.requested_by).slice(0, 120));
  if (body.approved_by) meta.push('Approved by: ' + String(body.approved_by).slice(0, 120));
  var baseNote = String(body.note || '');
  var composed = meta.length
    ? meta.join(' · ') + (baseNote ? ' · ' + baseNote : '')
    : baseNote;
  sh.appendRow([
    txId, d, biz, String(body.emp_id), name, String(body.tx_type), Number(body.amount),
    String(body.period_ym || ''), composed.slice(0, 1500),
  ]);
  sh.getRange(sh.getLastRow(), 2).setNumberFormat('yyyy-mm-dd');
  sh.getRange(sh.getLastRow(), 7).setNumberFormat('৳#,##0');
  SpreadsheetApp.flush();
  return { ok: true, tx_id: txId };
}

function hrDashboard_(p) {
  p = p || {};
  var biz = resolveBusinessId_(p.business_id || '');
  var dash = getDashboard_(p);
  var em = hrListEmployees_(p);
  var txAll = hrPayrollList_({ business_id: biz });
  var tx = hrPayrollList_({ business_id: biz, startDate: p.startDate, endDate: p.endDate });
  var fin = getFinance_({ business_id: biz, startDate: p.startDate, endDate: p.endDate });
  var active = em.employees.filter(function (e) {
    return String(e.status || '').toLowerCase().indexOf('inactive') === -1;
  });
  var monthlySalary = active.reduce(function (a, e) { return a + e.monthly_salary; }, 0);
  var byEmp = {};
  active.forEach(function (e) {
    byEmp[e.emp_id] = {
      emp_id: e.emp_id,
      name: e.name,
      monthly_salary: e.monthly_salary,
      advance_balance: 0,
      deposits: 0,
      salary_paid: 0,
      adjustments: 0,
      current_due: e.monthly_salary,
    };
  });
  txAll.transactions.forEach(function (t) {
    var b = byEmp[t.emp_id];
    if (!b) return;
    var amt = Number(t.amount || 0);
    if (t.tx_type === 'advance') b.advance_balance += amt;
    else if (t.tx_type === 'deposit') { b.deposits += amt; b.advance_balance -= amt; }
    else if (t.tx_type === 'salary_payment') b.salary_paid += amt;
    else if (t.tx_type === 'adjustment') b.adjustments += amt;
    b.current_due = b.monthly_salary - b.salary_paid + Math.max(0, b.advance_balance);
  });
  var empRows = Object.keys(byEmp).map(function (k) { return byEmp[k]; });
  var periodPaid = tx.transactions
    .filter(function (x) { return x.tx_type === 'salary_payment'; })
    .reduce(function (a, x) { return a + x.amount; }, 0);
  var periodAdv = tx.transactions
    .filter(function (x) { return x.tx_type === 'advance'; })
    .reduce(function (a, x) { return a + x.amount; }, 0);
  var totalAdvances = empRows.reduce(function (a, r) { return a + Math.max(0, r.advance_balance); }, 0);
  var unpaidSal = empRows.reduce(function (a, r) { return a + Math.max(0, r.current_due); }, 0);
  var grossProfit = dash.kpis && dash.kpis.total_profit != null ? dash.kpis.total_profit : 0;
  var revenue = dash.kpis && dash.kpis.total_revenue != null ? dash.kpis.total_revenue : 0;
  var netHint = grossProfit - fin.total_expenses;
  return {
    business_id: biz,
    kpis: {
      total_monthly_salary: monthlySalary,
      monthly_payroll_budget: monthlySalary,
      unpaid_salary_hint: unpaidSal,
      period_salary_paid: periodPaid,
      period_advances: periodAdv,
      advance_outstanding: totalAdvances,
      total_expenses: fin.total_expenses,
      monthly_revenue: revenue,
      order_gross_profit: grossProfit,
      employee_cost_budget: monthlySalary,
      operational_expense: fin.total_expenses,
      net_operation_hint: monthlySalary + fin.total_expenses,
      net_business_profit_hint: netHint,
    },
    orders_summary: dash.kpis || {},
    finance: fin,
    employees_roll: empRows,
    payroll_timeline: tx.transactions.slice(0, 60),
  };
}

function getCourier_() {
  var ss=SpreadsheetApp.getActiveSpreadsheet(),sh=ss.getSheetByName(SHEETS.COURIER);
  if (!sh||sh.getLastRow()<3) return {shipments:[]};
  var rows=sh.getRange(3,1,sh.getLastRow()-2,13).getValues();
  return {shipments:rows.filter(function(r){return r[0];}).map(function(r){
    return {order_id:String(r[0]||''),customer:String(r[1]||''),phone:String(r[2]||''),
            address:String(r[3]||''),courier:String(r[4]||''),tracking_id:String(r[5]||''),
            ship_date:fmtDate_(r[6]),tracking_status:String(r[7]||''),
            est_delivery:fmtDate_(r[8]),actual_delivery:fmtDate_(r[9]),
            courier_charge:Number(r[10]||0)};})};
}

function getLog_(limit) {
  var ss=SpreadsheetApp.getActiveSpreadsheet(),sh=ss.getSheetByName(SHEETS.LOG);
  if (!sh||sh.getLastRow()<2) return {events:[]};
  var last=sh.getLastRow(),n=Math.min(limit||50,last-1),from=Math.max(2,last-n+1);
  return {events:sh.getRange(from,1,last-from+1,5).getValues()
    .filter(function(r){return r[0];}).reverse()
    .map(function(r){return {timestamp:fmtDate_(r[0]),type:String(r[1]||''),
      reference:String(r[2]||''),message:String(r[3]||''),detail:String(r[4]||'').substring(0,200)};})};
}

function getSlaAlerts_() {
  var result=getOrders_({});
  var breaches=(result.orders||[]).filter(function(o){return o.sla_status&&o.sla_status.indexOf('BREACH')!==-1;})
    .map(function(o){return {id:o.id,customer:o.customer,status:o.status,sla_status:o.sla_status,
      days_pending:o.days_pending,days_in_transit:o.days_in_transit,
      courier:o.courier,tracking_id:o.tracking_id};});
  return {breaches:breaches,count:breaches.length};
}

function getNextInvoiceNum_() {
  if (typeof peekAlInvoiceNumber==='function') return {next:peekAlInvoiceNumber()};
  var year=new Date().getFullYear().toString();
  var cur=parseInt(PropertiesService.getScriptProperties().getProperty('AL_INV_COUNTER_'+year)||'0',10);
  var seq=String(cur+1);while(seq.length<4)seq='0'+seq;
  return {next:'AL-INV-'+year+'-'+seq};
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROW MAPPER
// ═══════════════════════════════════════════════════════════════════════════════

function rowToOrder_(r) {
  var sell=Number(r[OC.SELL_PRICE-1]||0),profit=Number(r[OC.PROFIT-1]||0);
  var rawNotes = String(r[OC.NOTES-1]||'');
  var meta = parseOrderItemsMeta_(rawNotes);
  var profitInputs = orderProfitInputsFromRowValues_(r, meta);
  var accounting = calculateOrderAccounting_(String(r[OC.STATUS-1]||''), profitInputs);
  var netProfit = meta && meta.netProfit != null ? Number(meta.netProfit) : accounting.netProfit;
  return {
    id:String(r[OC.ORDER_ID-1]||''),date:fmtDate_(r[OC.DATE-1]),
    customer:String(r[OC.CUSTOMER-1]||''),phone:String(r[OC.PHONE-1]||''),
    address:String(r[OC.ADDRESS-1]||''),payment:String(r[OC.PAYMENT-1]||''),
    source:String(r[OC.SOURCE-1]||''),status:normalizeOrderStatus_(String(r[OC.STATUS-1]||'')),
    product:String(r[OC.PRODUCT-1]||''),category:String(r[OC.CATEGORY-1]||''),
    size:String(r[OC.SIZE-1]||''),qty:Number(r[OC.QTY-1]||0),
    unit_price:Number(r[OC.UNIT_PRICE-1]||0),discount:Number(r[OC.DISCOUNT-1]||0),
    add_discount:Number(r[OC.ADD_DISCOUNT-1]||0),adv_cost:Number(r[OC.ADV_COST-1]||0),
    adv_platform:String(r[OC.ADV_PLATFORM-1]||''),sell_price:sell,
    shipping_fee:Number(r[OC.SHIP_COLLECTED-1]||0),cogs:Number(r[OC.COGS-1]||0),
    courier_charge:Number(r[OC.COURIER_CHARGE-1]||0),other_costs:Number(r[OC.OTHER_COSTS-1]||0),
    profit:profit,courier:String(r[OC.COURIER-1]||''),
    tracking_id:String(r[OC.TRACKING_ID-1]||''),tracking_status:String(r[OC.TRACKING_STATUS-1]||''),
    est_delivery:fmtDate_(r[OC.EST_DELIVERY-1]),actual_delivery:fmtDate_(r[OC.ACTUAL_DELIVERY-1]),
    return_reason:String(r[OC.RETURN_REASON-1]||''),return_date:fmtDate_(r[OC.RETURN_DATE-1]),
    return_status:String(r[OC.RETURN_STATUS-1]||''),notes:meta.notes,
    sku:String(r[OC.SKU-1]||''),handled_by:String(r[OC.HANDLED_BY-1]||''),
    sla_status:String(r[41]||''),days_pending:Number(r[39]||0),days_in_transit:Number(r[40]||0),
    auto_flag:String(r[42]||''),invoice_num:String(r[OC.INVOICE_NUM-1]||''),
    business_id:String(r[OC.BUSINESS_ID-1]||'')||'ALMA_LIFESTYLE',
    paid_amount:meta.paid_amount,
    due_amount:meta.due_amount,
    estimatedProfit:Number(meta.estimatedProfit != null ? meta.estimatedProfit : calculateDeliveredProfit_(profitInputs).netProfit),
    realizedProfit:accounting.realizedProfit,
    reversedProfit:accounting.reversedProfit,
    net_profit:netProfit,
    return_net_profit:Number(meta && meta.returnNetProfit != null ? meta.returnNetProfit : accounting.returnNetProfit),
    shipping_margin:Number(meta && meta.shippingMargin != null ? meta.shippingMargin : accounting.shippingMargin),
    merchandise_profit:Number(meta && meta.merchandiseProfit != null ? meta.merchandiseProfit : accounting.merchandiseProfit),
    returnType:String(meta && meta.returnType || accounting.returnType || ''),
    courierCost:Number(meta.courierCost || r[OC.COURIER_CHARGE-1] || 0),
    inventoryCost:Number(meta.inventoryCost || r[OC.COGS-1] || 0),
    stockRestored:meta.stockRestored === true,
    stockRestoredAt:String(meta.stockRestoredAt || ''),
    stockRestoreReason:String(meta.stockRestoreReason || ''),
    items:meta.items || [],
    margin_pct:sell>0?Math.round(netProfit/sell*100):0,
  };
}

function parseOrderItemsMeta_(notes) {
  var marker = 'ORDER_ITEMS_JSON:';
  var idx = String(notes || '').indexOf(marker);
  if (idx < 0) return { notes: String(notes || ''), paid_amount: null, due_amount: null };
  var clean = String(notes || '').slice(0, idx).trim();
  var raw = String(notes || '').slice(idx + marker.length).trim();
  try {
    var parsed = JSON.parse(raw);
    parsed.notes = clean;
    parsed.paid_amount = Number(parsed.paid_amount || 0);
    parsed.due_amount = Number(parsed.due_amount || 0);
    return parsed;
  } catch (e) {
    return { notes: clean, paid_amount: null, due_amount: null };
  }
}

/** Mirror of src/lib/order-return-profit.ts — keep formulas in sync. */
function roundOrderMoney_(n) {
  var v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round(v);
}

function orderProfitInputsFromRowValues_(r, meta) {
  var qty = Number(r[OC.QTY - 1] || 0);
  var unitPrice = Number(r[OC.UNIT_PRICE - 1] || 0);
  var subtotal = qty > 0 && unitPrice > 0 ? unitPrice * qty : Number(r[OC.SELL_PRICE - 1] || 0);
  return {
    subtotal: Math.max(0, roundOrderMoney_(subtotal)),
    discount: Math.max(0, roundOrderMoney_(Number(r[OC.DISCOUNT - 1] || 0) + Number(r[OC.ADD_DISCOUNT - 1] || 0))),
    inventoryCost: Math.max(0, roundOrderMoney_(meta && meta.inventoryCost != null ? meta.inventoryCost : r[OC.COGS - 1] || 0)),
    shippingFee: Math.max(0, roundOrderMoney_(r[OC.SHIP_COLLECTED - 1] || 0)),
    courierCharge: Math.max(0, roundOrderMoney_(r[OC.COURIER_CHARGE - 1] || 0)),
  };
}

function roundProfitResult_(result) {
  return {
    merchandiseProfit: roundOrderMoney_(result.merchandiseProfit),
    shippingMargin: roundOrderMoney_(result.shippingMargin),
    netProfit: roundOrderMoney_(result.netProfit),
    scenario: result.scenario,
  };
}

function calculateDeliveredProfit_(inputs) {
  var merchandiseProfit = roundOrderMoney_(inputs.subtotal - inputs.discount - inputs.inventoryCost);
  var shippingMargin = roundOrderMoney_(inputs.shippingFee - inputs.courierCharge);
  return roundProfitResult_({
    merchandiseProfit: merchandiseProfit,
    shippingMargin: shippingMargin,
    netProfit: roundOrderMoney_(merchandiseProfit + shippingMargin),
    scenario: 'delivered',
  });
}

function calculateReturnedPaidProfit_(inputs) {
  var roundTrip = roundOrderMoney_(2 * inputs.courierCharge);
  var net = roundOrderMoney_(inputs.shippingFee - roundTrip);
  return roundProfitResult_({
    merchandiseProfit: 0,
    shippingMargin: net,
    netProfit: net,
    scenario: 'returned_paid',
  });
}

function calculateReturnedUnpaidProfit_(inputs) {
  var roundTrip = roundOrderMoney_(2 * inputs.courierCharge);
  var net = roundOrderMoney_(-roundTrip);
  return roundProfitResult_({
    merchandiseProfit: 0,
    shippingMargin: net,
    netProfit: net,
    scenario: 'returned_unpaid',
  });
}

function calculateOrderProfit_(status, inputs) {
  var key = normalizeOrderStatus_(status);
  if (key === 'Delivered') return calculateDeliveredProfit_(inputs);
  if (key === 'RETURNED_PAID') return calculateReturnedPaidProfit_(inputs);
  if (key === 'RETURNED_UNPAID' || key === 'RETURNED') return calculateReturnedUnpaidProfit_(inputs);
  if (key === 'CANCELLED') return { merchandiseProfit: 0, shippingMargin: 0, netProfit: 0, scenario: 'cancelled' };
  var est = calculateDeliveredProfit_(inputs);
  est.scenario = 'in_progress';
  return est;
}

function roundOrderAccounting_(acct) {
  return {
    realizedProfit: roundOrderMoney_(acct.realizedProfit),
    reversedProfit: roundOrderMoney_(acct.reversedProfit),
    pendingProfit: roundOrderMoney_(acct.pendingProfit),
    returnNetProfit: roundOrderMoney_(acct.returnNetProfit),
    netProfit: roundOrderMoney_(acct.netProfit),
    merchandiseProfit: roundOrderMoney_(acct.merchandiseProfit),
    shippingMargin: roundOrderMoney_(acct.shippingMargin),
    returnType: acct.returnType || '',
  };
}

function calculateOrderAccounting_(status, inputs) {
  var result = calculateOrderProfit_(status, inputs);
  var key = normalizeOrderStatus_(status);
  if (key === 'Delivered') {
    return roundOrderAccounting_({
      realizedProfit: result.netProfit,
      reversedProfit: 0,
      pendingProfit: 0,
      returnNetProfit: 0,
      netProfit: result.netProfit,
      merchandiseProfit: result.merchandiseProfit,
      shippingMargin: result.shippingMargin,
      returnType: '',
    });
  }
  if (isTerminalReturnStatus_(key) || key === 'RETURNED') {
    var loss = result.netProfit < 0 ? roundOrderMoney_(Math.abs(result.netProfit)) : 0;
    return roundOrderAccounting_({
      realizedProfit: 0,
      reversedProfit: loss,
      pendingProfit: 0,
      returnNetProfit: result.netProfit,
      netProfit: result.netProfit,
      merchandiseProfit: result.merchandiseProfit,
      shippingMargin: result.shippingMargin,
      returnType: key === 'RETURNED' ? 'RETURNED_UNPAID' : key,
    });
  }
  if (key === 'CANCELLED') {
    return roundOrderAccounting_({
      realizedProfit: 0,
      reversedProfit: 0,
      pendingProfit: 0,
      returnNetProfit: 0,
      netProfit: 0,
      merchandiseProfit: 0,
      shippingMargin: 0,
      returnType: '',
    });
  }
  var pending = calculateDeliveredProfit_(inputs).netProfit;
  return roundOrderAccounting_({
    realizedProfit: 0,
    reversedProfit: 0,
    pendingProfit: pending,
    returnNetProfit: 0,
    netProfit: pending,
    merchandiseProfit: result.merchandiseProfit,
    shippingMargin: result.shippingMargin,
    returnType: '',
  });
}

function accountingForOrderStatus_(status, inputs) {
  return calculateOrderAccounting_(status, inputs);
}

function writeOrderAccountingMeta_(sh, rowIndex, status) {
  var notes = String(sh.getRange(rowIndex, OC.NOTES).getValue() || '');
  var meta = parseOrderItemsMeta_(notes);
  if (!meta || meta.paid_amount == null) return;
  var rowValues = sh.getRange(rowIndex, 1, 1, TOTAL_COLS).getValues()[0];
  var profitInputs = orderProfitInputsFromRowValues_(rowValues, meta);
  var accounting = calculateOrderAccounting_(status, profitInputs);
  meta.realizedProfit = accounting.realizedProfit;
  meta.reversedProfit = accounting.reversedProfit;
  meta.returnNetProfit = accounting.returnNetProfit;
  meta.netProfit = accounting.netProfit;
  meta.merchandiseProfit = accounting.merchandiseProfit;
  meta.shippingMargin = accounting.shippingMargin;
  meta.returnType = accounting.returnType || '';
  meta.estimatedProfit = calculateDeliveredProfit_(profitInputs).netProfit;
  meta.accountingStatus = status === 'Delivered' ? 'REALIZED' : accounting.returnNetProfit !== 0 ? 'RETURN' : accounting.reversedProfit ? 'REVERSED' : 'ESTIMATED';
  var marker = 'ORDER_ITEMS_JSON:';
  sh.getRange(rowIndex, OC.NOTES).setValue((meta.notes ? meta.notes + '\n' : '') + marker + JSON.stringify(meta));
}

function updateOrderMetaFlag_(sh, rowIndex, updater) {
  var notes = String(sh.getRange(rowIndex, OC.NOTES).getValue() || '');
  var meta = parseOrderItemsMeta_(notes);
  if (!meta || meta.paid_amount == null) return null;
  updater(meta);
  sh.getRange(rowIndex, OC.NOTES).setValue((meta.notes ? meta.notes + '\n' : '') + 'ORDER_ITEMS_JSON:' + JSON.stringify(meta));
  return meta;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Find an order row by its ID string. Returns {sh, rowIndex, data} or null. */
function findOrderRow_(orderId) {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var sh   = ss.getSheetByName(SHEETS.ORDERS);
  var last = sh.getLastRow();
  if (last < ORDERS_DATA_START) return null;

  var ids = sh.getRange(ORDERS_DATA_START, OC.ORDER_ID, last - ORDERS_DATA_START + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(orderId)) {
      var rowIndex = ORDERS_DATA_START + i;
      return { sh: sh, rowIndex: rowIndex, data: sh.getRange(rowIndex, 1, 1, TOTAL_COLS).getValues()[0] };
    }
  }
  return null;
}

/** Format any date value to YYYY-MM-DD string, or '' if empty/invalid. */
function fmtDate_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var str = String(val).trim();
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(str)) return ''; // time-only
  if (/^\d{4,6}$/.test(str)) {                       // serial number
    var d = new Date(1899, 11, 30);
    d.setDate(d.getDate() + parseInt(str, 10));
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return str.split(' ')[0] || str;
}

/**
 * Build the JSON response.
 *
 * IMPORTANT: ContentService outputs in GAS do not support custom headers,
 * so CORS cannot be set here. CORS for GAS Web Apps deployed as "Anyone"
 * is handled automatically by Google's infrastructure for simple requests.
 * For requests from browsers, proxy through the Next.js route handlers
 * (src/app/api/*) which add proper CORS headers.
 */
function respond_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Verify API_SECRET. Fails closed when absent or still using a known demo value. */
function checkSecret_(provided) {
  if (!provided) return false;
  var stored = PropertiesService.getScriptProperties().getProperty('API_SECRET') || '';
  if (!stored || stored === 'alma-dev-secret' || stored.indexOf('REPLACE_') === 0) return false;
  return String(provided) === String(stored);
}

/** ISO week number, used by addExpense_. */
function getWeekNum_(date) {
  var d   = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  var y   = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - y) / 86400000) + 1) / 7);
}

function pad_(n) { return n < 10 ? '0' + n : '' + n; }

/** Write to AUTOMATION LOG — never throws. */
function apiLog_(type, ref, message, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEETS.LOG);
    if (!sh) return;
    var row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, 5).setValues([[
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      '[API] ' + type, String(ref || ''), String(message || ''),
      String(detail || '').substring(0, 300),
    ]]);
  } catch (_) { /* silent */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MENU & TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
//
// IMPORTANT: Your Apps Script project must define onOpen() in exactly ONE file.
// If you paste both this file and Code.js, remove onOpen from one of them.
//
function onOpen() {
  var ui   = SpreadsheetApp.getUi();
  var menu = ui.createMenu('⚡ Alma ERP');
  if (typeof runManualSLARefresh === 'function')
    menu.addItem('🔄 Refresh SLA', 'runManualSLARefresh').addSeparator();
  if (typeof onOpenPhase3Menu_   === 'function') onOpenPhase3Menu_(menu);
  if (typeof onOpenInvoiceMenu_  === 'function') onOpenInvoiceMenu_(menu);
  if (typeof onOpenCrmMenu_      === 'function') onOpenCrmMenu_(menu);
  if (typeof onOpenProductionCleanupMenu_ === 'function') {
    onOpenProductionCleanupMenu_(menu);
  }
  menu
    .addSeparator()
    .addItem('🔑 Verify API Secret',       'verifyApiSecret')
    .addItem('✅ Test doGet (dashboard)',   'testGetDashboard')
    .addItem('✅ Test doPost (create_order)','testCreateOrder')
    .addToUi();
}

function verifyApiSecret() {
  var stored = PropertiesService.getScriptProperties().getProperty('API_SECRET');
  SpreadsheetApp.getUi().alert(
    stored
      ? '✅ API_SECRET is set.\nFirst 4 chars: ' + stored.substring(0, 4) + '****'
      : '⚠️ API_SECRET not set.\nGo to Project Settings → Script Properties → add the same strong API_SECRET used by Next.js.'
  );
}

/** Run only through clasp by a project owner when rotating production secrets. */
function setApiSecretForDeployment(secret) {
  if (!secret || String(secret).length < 32 || String(secret) === 'alma-dev-secret') {
    throw new Error('Refusing weak API_SECRET');
  }
  var normalized = String(secret).trim();
  PropertiesService.getScriptProperties().setProperty('API_SECRET', normalized);
  return { ok: true, updated: true };
}

/** clasp-only rotation probe; does not reveal the stored secret. */
function testApiSecretForDeployment(secret) {
  return { ok: checkSecret_(String(secret || '').trim()) };
}

/** Run from editor to test GET without deploying. */
function testGetDashboard() {
  var result = getDashboard_();
  Logger.log(JSON.stringify(result.kpis, null, 2));
  SpreadsheetApp.getUi().alert(
    '✅ getDashboard_ result:\n' +
    'Orders: '    + result.kpis.total_orders   + '\n' +
    'Revenue: ৳'  + result.kpis.total_revenue  + '\n' +
    'Profit: ৳'   + result.kpis.total_profit   + '\n' +
    'Delivery: '  + result.kpis.delivery_rate  + '%'
  );
}

/**
 * Run from editor to test create_order without hitting the HTTP layer.
 * Appends a real test row — remove via ⚡ Alma ERP → 🧹 Production → Preview / DELETE cleanup.
 */
function testCreateOrder() {
  var result = createOrder_({
    customer:   'TEST CUSTOMER',
    phone:      '01700000000',
    address:    'Test Address, Dhaka',
    product:    'TEST PRODUCT',
    category:   'Tops',
    qty:        1,
    unit_price: 1000,
    payment:    'COD',
    source:     'Facebook',
    notes:      'CREATED BY testCreateOrder — DELETE THIS ROW',
  });
  Logger.log(JSON.stringify(result));
  SpreadsheetApp.getUi().alert(
    result.ok
      ? '✅ Order created!\nID: ' + result.order_id + '\nRow: ' + result.row +
        '\n\nPlease delete this test row from the ORDERS sheet.'
      : '❌ Failed: ' + result.error
  );
}