/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ALMA LIFESTYLE ERP — WEB APP API  (Code.gs)                          ║
 * ║                                                                          ║
 * ║   PASTE THIS AS THE ENTIRE CONTENT OF Code.gs, THEN:                   ║
 * ║   1. Deploy → Manage deployments → Edit → Version: New version → Deploy ║
 * ║      (If first deploy: Deploy → New deployment → Web App →              ║
 * ║       Execute as: Me  · Who has access: Anyone → Deploy)                ║
 * ║   2. Project Settings → Script Properties → add if missing:             ║
 * ║        API_SECRET = alma-dev-secret                                     ║
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
    default:
      return {
        error: 'Unknown GET route: "' + route + '"',
        available: 'dashboard, orders, order, finance, hr_employees, hr_payroll, hr_dashboard, audit_log, financial_report, courier, analytics, cdit_*',
      };
  }
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
    } else if (route === 'create_product' || route === 'batch_import_product_master') {
      entityType = 'inventory';
      entityId = String(result.product_id || 'batch');
      summary = route;
    } else if (route === 'create_customer') {
      entityType = 'customer';
      entityId = String(body.phone || body.name || '');
      summary = 'Customer ' + String(body.name || '');
    } else if (route === 'save_branding' || route === 'upload_brand_asset') {
      entityType = 'branding';
      entityId = bid;
      summary = route;
    }

    var detail = { route: route, keys: Object.keys(body).filter(function (k) { return k !== 'secret'; }) };
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
    var vals = sh.getRange(takeFrom, 1, last, 10).getValues();
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
    case 'hr_payroll_add':      return hrPayrollAppend_(body);
    case 'generate_invoice':    return triggerInvoice_(body);
    case 'create_order_folder': return triggerOrderFolder_(body);
    case 'create_customer':
      if (body.business_id === 'CREATIVE_DIGITAL_IT') return createCditClient_(body);
      return triggerCreateCustomer_(body);
    case 'create_client':
      return createCditClient_(body);
    case 'create_product':      return createProduct_(body);
    case 'batch_import_product_master':
      return batchImportProductMaster_(body);
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
  var required = ['customer', 'phone', 'product', 'category', 'qty', 'unit_price', 'payment', 'source'];
  for (var i = 0; i < required.length; i++) {
    if (!body[required[i]] && body[required[i]] !== 0) {
      return { error: 'Missing required field: ' + required[i] };
    }
  }

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

  // Columns written as values (0-indexed in the array):
  row[OC.DATE          - 1] = today;
  row[OC.CUSTOMER      - 1] = String(body.customer  || '').trim();
  row[OC.PHONE         - 1] = String(body.phone     || '').trim();
  row[OC.ADDRESS       - 1] = String(body.address   || '').trim();
  row[OC.PAYMENT       - 1] = String(body.payment   || '');
  row[OC.SOURCE        - 1] = String(body.source    || '');
  row[OC.STATUS        - 1] = String(body.status    || 'Pending');
  row[OC.PRODUCT       - 1] = String(body.product   || '').trim();
  row[OC.CATEGORY      - 1] = String(body.category  || '');
  row[OC.SIZE          - 1] = String(body.size      || '');
  row[OC.QTY           - 1] = Number(body.qty)      || 1;
  row[OC.UNIT_PRICE    - 1] = Number(body.unit_price)|| 0;
  row[OC.DISCOUNT      - 1] = Number(body.discount  || 0);
  row[OC.ADD_DISCOUNT  - 1] = Number(body.add_discount || 0);
  row[OC.ADV_COST      - 1] = Number(body.adv_cost  || 0);
  row[OC.ADV_PLATFORM  - 1] = String(body.adv_platform || '');
  // OC.SELL_PRICE (18) — written as formula below, leave blank here
  row[OC.SHIP_COLLECTED - 1]= Number(body.shipping_fee   || 0);
  row[OC.COGS          - 1] = Number(body.cogs           || 0);
  row[OC.COURIER_CHARGE - 1]= Number(body.courier_charge || 0);
  row[OC.OTHER_COSTS   - 1] = Number(body.other_costs    || 0);
  // OC.PROFIT (23) — written as formula below, leave blank here
  row[OC.COURIER       - 1] = String(body.courier   || '');
  row[OC.TRACKING_ID   - 1] = '';
  row[OC.TRACKING_STATUS-1] = 'Pending';
  row[OC.NOTES         - 1] = String(body.notes     || '');
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

  // PROFIT — col W: sell_price + shipping_collected - COGS - courier_charge - other_costs - adv_cost
  sh.getRange(newRow, OC.PROFIT).setFormula(
    '=IF(C' + newRow + '="","",IFERROR(R' + newRow + '+S' + newRow + '-T' + newRow + '-U' + newRow + '-V' + newRow + '-P' + newRow + ',0))'
  );

  // ── Flush and read back the generated Order ID ────────────────────────────
  SpreadsheetApp.flush();
  var orderId = sh.getRange(newRow, OC.ORDER_ID).getValue();

  // Fallback: if the formula hasn't resolved yet (cold evaluation), derive it
  if (!orderId) {
    orderId = 'AL-' + String(newRow - 2).padStart(4, '0');
  }

  // ── Fire Phase 5 CRM hook if loaded ──────────────────────────────────────
  if (typeof onOrderCrmUpdate === 'function') {
    try {
      onOrderCrmUpdate(body.customer, body.phone, body.address || '', '', body.source);
    } catch (crmErr) {
      apiLog_('WARN', 'create_order', 'CRM hook error: ' + crmErr.message, '');
    }
  }

  // ── Compute profit for response (formula in sheet may not resolve yet) ───────
  var sellPrice   = Number(body.sell_price)     || (Number(body.unit_price) * Number(body.qty));
  var profit      = sellPrice
                  + Number(body.shipping_fee    || 0)
                  - Number(body.cogs            || 0)
                  - Number(body.courier_charge  || 0)
                  - Number(body.other_costs     || 0)
                  - Number(body.adv_cost        || 0);

  // ── Log the event ─────────────────────────────────────────────────────────
  apiLog_('CREATE_ORDER', orderId, body.product + ' × ' + body.qty + ' | profit=' + Math.round(profit), 'Row ' + newRow);

  return { ok: true, order_id: orderId, profit: Math.round(profit), row: newRow };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE STATUS
// ═══════════════════════════════════════════════════════════════════════════════

function updateStatus_(body) {
  if (!body.id)     return { error: 'id required' };
  if (!body.status) return { error: 'status required' };

  var valid = ['Pending','Confirmed','Packed','Shipped','Delivered','Returned','Cancelled'];
  if (valid.indexOf(body.status) === -1) return { error: 'Invalid status: ' + body.status };

  var found = findOrderRow_(body.id);
  if (!found) return { error: 'Order not found: ' + body.id };

  var oldStatus = found.data[OC.STATUS - 1];
  found.sh.getRange(found.rowIndex, OC.STATUS).setValue(body.status);

  // Fire Phase 2 automation if present
  if (typeof handleStatusChange_ === 'function') {
    try { handleStatusChange_(found.sh, found.rowIndex, found.data, body.status, oldStatus); }
    catch (e) { apiLog_('WARN', 'update_status', 'Phase 2 hook: ' + e.message, ''); }
  } else {
    // Minimal built-in timestamps when Phase 2 is not loaded
    var now = new Date();
    var ts  = found.sh;
    if (body.status === 'Shipped' && !ts.getRange(found.rowIndex, 37).getValue())
      ts.getRange(found.rowIndex, 37).setValue(now).setNumberFormat('DD-MMM-YYYY');
    if (body.status === 'Delivered' && !ts.getRange(found.rowIndex, 38).getValue())
      ts.getRange(found.rowIndex, 38).setValue(now).setNumberFormat('DD-MMM-YYYY');
    if (body.status === 'Returned' && !ts.getRange(found.rowIndex, 39).getValue())
      ts.getRange(found.rowIndex, 39).setValue(now).setNumberFormat('DD-MMM-YYYY');
  }

  SpreadsheetApp.flush();
  apiLog_('STATUS', body.id, oldStatus + ' → ' + body.status, '');
  return { ok: true, order_id: body.id, old_status: oldStatus, new_status: body.status };
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

  sh.getRange(newRow, 1, newRow, 17).setValues([row]);
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
            sla_breaches:0,pending_action:0 },
    by_status:{},by_source:{},by_payment:{},by_category:{},
    sla_breaches:[],recent_orders:[],generated_at:new Date().toISOString()
  };

  if (last < ORDERS_DATA_START) return emptyResult;

  var rows   = sh.getRange(ORDERS_DATA_START, 1, last - ORDERS_DATA_START + 1, TOTAL_COLS).getValues();
  var orders = rows.filter(function(r){ return r[OC.ORDER_ID-1]; }).map(rowToOrder_);
  orders = filterOrdersByDateRange_(orders, p.startDate || '', p.endDate || '');
  orders = orders.filter(function(o){ return orderMatchesBusiness_(o, resolveBusinessId_(p.business_id || '')); });

  if (!orders.length) return emptyResult;

  var totalRev=0,totalPro=0,totalCOGS=0,delivered=0,returned=0;
  var byStatus={},bySource={},byPayment={},byCat={},slaBreaches=[],monthly={};

  orders.forEach(function(o) {
    totalRev  += o.sell_price;
    totalPro  += o.profit;
    totalCOGS += o.cogs;
    if (o.status==='Delivered') delivered++;
    if (o.status==='Returned')  returned++;
    byStatus[o.status]   = (byStatus[o.status]||0)+1;
    byPayment[o.payment] = (byPayment[o.payment]||0)+1;
    if (!bySource[o.source]) bySource[o.source]={orders:0,revenue:0};
    bySource[o.source].orders++;
    bySource[o.source].revenue += o.sell_price;
    if (!byCat[o.category]) byCat[o.category]={orders:0,revenue:0,profit:0};
    byCat[o.category].orders++;
    byCat[o.category].revenue += o.sell_price;
    byCat[o.category].profit  += o.profit;
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
        monthly[key].revenue += o.sell_price;
        monthly[key].profit  += o.profit;
        monthly[key].cogs    += o.cogs;
        monthly[key].orders++;
      }
    }
  });

  var n = orders.length;
  var recentOrders = orders.slice(-10).reverse().map(function(o){
    return {id:o.id,date:o.date,customer:o.customer,product:o.product,
            status:o.status,sell_price:o.sell_price,profit:o.profit};
  });
  var monthlyArr = Object.keys(monthly).sort().map(function(k){return monthly[k];});

  return {
    kpis:{
      total_orders:n, total_revenue:totalRev, total_profit:totalPro, total_cogs:totalCOGS,
      gross_margin:   totalRev>0 ? Math.round(totalPro/totalRev*100):0,
      avg_order_value:n>0 ? Math.round(totalRev/n):0,
      delivered_count:delivered,
      delivery_rate:  n>0 ? Math.round(delivered/n*100):0,
      return_rate:    n>0 ? Math.round(returned/n*100):0,
      sla_breaches:   slaBreaches.length,
      pending_action: (byStatus['Pending']||0)+(byStatus['Confirmed']||0),
    },
    by_status:byStatus, by_source:bySource, by_payment:byPayment, by_category:byCat,
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
             total_revenue:slice.reduce(function(a,o){return a+o.sell_price;},0),
             total_profit: slice.reduce(function(a,o){return a+o.profit;},0),
             by_status:byStatus}
  };
}

function getOrder_(id) {
  if (!id) return {error:'id parameter required'};
  var row = findOrderRow_(id);
  if (!row) return {error:'Order not found: '+id};
  return {order:rowToOrder_(row.data)};
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
    return {sku:String(r[0]||''),product:String(r[1]||''),category:String(r[2]||''),
            color:String(r[3]||''),size:String(r[4]||''),opening:Number(r[5]||0),
            purchased:Number(r[6]||0),sold:Number(r[7]||0),returned:Number(r[8]||0),
            damaged:Number(r[9]||0),reserved:Number(r[10]||0),current_stock:Number(r[11]||0),
            available:Number(r[12]||0),reorder_level:Number(r[13]||0),
            status:String(r[14]||'').replace(/[✅⚠️❌]\s?/g,''),
            stock_value:Number(r[15]||0),sell_value:Number(r[16]||0),potential_profit:Number(r[17]||0)};
  });
  return {items:items,summary:{total_skus:items.length,
    total_value:items.reduce(function(a,i){return a+i.stock_value;},0),
    total_sell_val:items.reduce(function(a,i){return a+i.sell_value;},0),
    low_stock:items.filter(function(i){return i.available>0&&i.available<=i.reorder_level;}).length,
    out_of_stock:items.filter(function(i){return i.available<=0;}).length}};
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
  var SSTART = 3;
  var last = sh.getLastRow();
  if (last >= SSTART) {
    var colSkus = sh.getRange(SSTART, 1, last, 1).getValues();
    var r;
    for (r = 0; r < colSkus.length; r++) {
      if (String(colSkus[r][0] || '').trim().toLowerCase() === skuNorm) {
        return { ok: false, reason: 'stock_sku_exists' };
      }
    }
  }
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
  var stockVal = unitCogs * qty;
  var sellVal = unitPrice * qty;
  var pot = sellVal - stockVal;
  var statusDisp = qty > 0 ? '✅ IN STOCK' : '❌ OUT OF STOCK';
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
    '',
  ];
  while (row.length < 20) row.push('');
  sh.appendRow(row);
  return { ok: true, reason: 'appended' };
}

function createProduct_(body) {
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
    sh.getRange(rowIndex, 1, rowIndex, 11).setValues([row]);
  } else {
    sh.appendRow(row);
  }
  sh.getRange(rowIndex > 0 ? rowIndex : sh.getLastRow(), 8).setNumberFormat('yyyy-mm-dd');
  SpreadsheetApp.flush();
  return { ok: true, emp_id: id };
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
  return {
    id:String(r[OC.ORDER_ID-1]||''),date:fmtDate_(r[OC.DATE-1]),
    customer:String(r[OC.CUSTOMER-1]||''),phone:String(r[OC.PHONE-1]||''),
    address:String(r[OC.ADDRESS-1]||''),payment:String(r[OC.PAYMENT-1]||''),
    source:String(r[OC.SOURCE-1]||''),status:String(r[OC.STATUS-1]||''),
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
    return_status:String(r[OC.RETURN_STATUS-1]||''),notes:String(r[OC.NOTES-1]||''),
    sku:String(r[OC.SKU-1]||''),handled_by:String(r[OC.HANDLED_BY-1]||''),
    sla_status:String(r[41]||''),days_pending:Number(r[39]||0),days_in_transit:Number(r[40]||0),
    auto_flag:String(r[42]||''),invoice_num:String(r[OC.INVOICE_NUM-1]||''),
    business_id:String(r[OC.BUSINESS_ID-1]||'')||'ALMA_LIFESTYLE',
    margin_pct:sell>0?Math.round(profit/sell*100):0,
  };
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

/** Verify API_SECRET. Falls back to 'alma-dev-secret' if not set in Script Properties. */
function checkSecret_(provided) {
  if (!provided) return false;
  var stored = PropertiesService.getScriptProperties().getProperty('API_SECRET') || 'alma-dev-secret';
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
      : '⚠️ API_SECRET not set.\nGo to Project Settings → Script Properties → add:\n  Key: API_SECRET\n  Value: alma-dev-secret'
  );
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