/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ALMA ERP — PRODUCTION CLEANUP (safe test/demo row removal)            ║
 * ║                                                                          ║
 * ║   DEPLOY: Apps Script → + → Script file name: ProductionCleanup          ║
 * ║                                                                          ║
 * ║   WHAT IT DOES                                                           ║
 * ║   • PREVIEW: logs + UI summary of rows that WOULD be removed            ║
 * ║   • EXECUTE: after typing DELETE, deletes ONLY rows matching rules      ║
 * ║   • Never touches row 1–2 on ORDERS (brand + headers)                  ║
 * ║   • Never deletes sheet tabs, Apps Script, or deployment                ║
 * ║                                                                          ║
 * ║   WHAT IT NEVER DOES                                                     ║
 * ║   • Does not wipe whole sheets or remove header rows                     ║
 * ║   • Does not delete rows with empty test markers (blank template rows)   ║
 * ║   • Does not remove Drive folders (only optional test PDFs in Alma      ║
 * ║     Invoices folder by filename pattern)                                 ║
 * ║                                                                          ║
 * ║   ORDER IDs after cleanup                                                ║
 * ║   • New orders append after last row with data in col C (CUSTOMER)      ║
 * ║   • ORDER_ID uses =TEXT(ROW()-2,"AL-0000") — sequence follows row #      ║
 * ║                                                                          ║
 * ║   INVOICE counter (Script Properties)                                    ║
 * ║   • Optional: reset AL_INV_COUNTER_YYYY — OFF by default (see menu)      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

/* global OC, ORDERS_DATA_START, TOTAL_COLS, SHEETS, SpreadsheetApp, DriveApp, PropertiesService, Utilities, Logger, HtmlService */

var PRODUCTION_CLEANUP = {
  /** Substrings / regexes (case-insensitive) matched against customer, product, notes, source, log message/detail */
  textPatterns: [
    /\bTEST\s+CUSTOMER\b/i,
    /\bTEST\s+PRODUCT\b/i,
    /\bAUTO\s+TEST\b/i,
    /\bCREATED\s+BY\s+testCreateOrder\b/i,
    /\bDEBUG\b/i,
    /\bSAMPLE\b/i,
    /\bDEMO\b/i,
    /\bFAKE\b/i,
    /\bMOCK\b/i,
    /\bLorem\s+ipsum\b/i,
  ],
  /** Order ID display value (column A) — optional extra checks */
  orderIdTestRegex: /^AL-TEST/i,
  /** testCreateOrder() default phone — row may match even if name edited */
  testPhoneExact: ['01700000000', '8801700000000'],
  /** ORDERS: first data row (after brand row 1 + header row 2) */
  ordersDataStart: typeof ORDERS_DATA_START !== 'undefined' ? ORDERS_DATA_START : 3,
  /** CUSTOMERS (Phase 5): first data row */
  customersDataStart: 6,
  /** STOCK CONTROL: first data row (matches getInventory_) */
  stockDataStart: 3,
  /** EXPENSE LEDGER: first data row (matches getFinance_) */
  expenseDataStart: 6,
  /** COURIER TRACKER */
  courierDataStart: 3,
  /** AUTOMATION LOG */
  logDataStart: 2,
  /** Filename prefix for Alma invoice PDFs (Phase 4) */
  almaInvoicePdfPrefix: 'Invoice-',
};

function productionCleanupMatchesText_(s) {
  var t = String(s || '');
  if (!t) return false;
  var pats = PRODUCTION_CLEANUP.textPatterns;
  for (var i = 0; i < pats.length; i++) {
    if (pats[i].test(t)) return true;
  }
  return false;
}

function productionCleanupMatchesOrderId_(id) {
  var s = String(id || '').trim();
  if (!s) return false;
  if (PRODUCTION_CLEANUP.orderIdTestRegex.test(s)) return true;
  return false;
}

function productionCleanupIsTestOrderRow_(orderId, customer, product, notes, source, phone) {
  if (productionCleanupMatchesOrderId_(orderId)) return true;
  if (productionCleanupMatchesText_(customer)) return true;
  if (productionCleanupMatchesText_(product)) return true;
  if (productionCleanupMatchesText_(notes)) return true;
  if (productionCleanupMatchesText_(source)) return true;
  var ph = String(phone || '').replace(/\D/g, '');
  var testPhones = PRODUCTION_CLEANUP.testPhoneExact;
  for (var i = 0; i < testPhones.length; i++) {
    var x = String(testPhones[i] || '').replace(/\D/g, '');
    if (x && ph === x) return true;
  }
  return false;
}

function productionCleanupOrders_(ss, report, dryRun) {
  var sh = ss.getSheetByName(SHEETS.ORDERS);
  if (!sh) {
    report.lines.push('ORDERS: sheet not found — skipped');
    return;
  }
  var start = PRODUCTION_CLEANUP.ordersDataStart;
  var last = sh.getLastRow();
  var oc = typeof OC !== 'undefined' ? OC : { CUSTOMER: 3, PRODUCT: 9, NOTES: 32, SOURCE: 7, ORDER_ID: 1, PHONE: 4 };
  var deleted = 0;
  for (var row = last; row >= start; row--) {
    var customer = String(sh.getRange(row, oc.CUSTOMER).getValue() || '').trim();
    var product = String(sh.getRange(row, oc.PRODUCT).getValue() || '');
    var notes = String(sh.getRange(row, oc.NOTES).getValue() || '');
    var source = String(sh.getRange(row, oc.SOURCE).getValue() || '');
    var phone = String(sh.getRange(row, oc.PHONE).getValue() || '');
    var orderId = String(sh.getRange(row, oc.ORDER_ID).getValue() || '').trim();
    var isEmptyRow = !customer && !product && !notes;
    if (isEmptyRow) continue;
    if (!productionCleanupIsTestOrderRow_(orderId, customer, product, notes, source, phone)) continue;
    report.lines.push('ORDERS row ' + row + ': ' + orderId + ' | ' + customer + ' | ' + product);
    deleted++;
    if (!dryRun) sh.deleteRow(row);
  }
  report.ordersRemoved += deleted;
}

function productionCleanupAutomationLog_(ss, report, dryRun) {
  var sh = ss.getSheetByName(SHEETS.LOG);
  if (!sh) return;
  var start = PRODUCTION_CLEANUP.logDataStart;
  var last = sh.getLastRow();
  if (last < start) return;
  var removed = 0;
  for (var row = last; row >= start; row--) {
    var type = String(sh.getRange(row, 2).getValue() || '');
    var ref = String(sh.getRange(row, 3).getValue() || '');
    var msg = String(sh.getRange(row, 4).getValue() || '');
    var det = String(sh.getRange(row, 5).getValue() || '');
    var blob = type + ' ' + ref + ' ' + msg + ' ' + det;
    if (!productionCleanupMatchesText_(blob) && !productionCleanupMatchesOrderId_(ref)) continue;
    report.lines.push('LOG row ' + row + ': ' + type + ' | ' + ref);
    removed++;
    if (!dryRun) sh.deleteRow(row);
  }
  report.logRowsRemoved += removed;
}

function productionCleanupStock_(ss, report, dryRun) {
  var sh = ss.getSheetByName(SHEETS.STOCK);
  if (!sh) return;
  var start = PRODUCTION_CLEANUP.stockDataStart;
  var last = sh.getLastRow();
  var removed = 0;
  for (var row = last; row >= start; row--) {
    var sku = String(sh.getRange(row, 1).getValue() || '');
    var name = String(sh.getRange(row, 2).getValue() || '');
    if (!sku && !name) continue;
    if (!productionCleanupMatchesText_(name) && !productionCleanupMatchesText_(sku)) continue;
    report.lines.push('STOCK row ' + row + ': ' + sku + ' | ' + name);
    removed++;
    if (!dryRun) sh.deleteRow(row);
  }
  report.stockRowsRemoved += removed;
}

function productionCleanupCustomers_(ss, report, dryRun) {
  var sh = ss.getSheetByName(SHEETS.CUSTOMERS);
  if (!sh) return;
  var start = PRODUCTION_CLEANUP.customersDataStart;
  var last = sh.getLastRow();
  var cc =
    typeof CRM_CONFIG !== 'undefined' && CRM_CONFIG.cc
      ? CRM_CONFIG.cc
      : { NAME: 2, PHONE: 3, TOTAL_ORDERS: 7 };
  var removed = 0;
  for (var row = last; row >= start; row--) {
    var name = String(sh.getRange(row, cc.NAME).getValue() || '').trim();
    var phone = String(sh.getRange(row, cc.PHONE).getValue() || '');
    if (!name && !phone) continue;
    var tot = sh.getRange(row, cc.TOTAL_ORDERS).getValue();
    var totNum = Number(tot);
    var nameHit = productionCleanupMatchesText_(name);
    var phoneNorm = String(phone).replace(/\D/g, '');
    var phoneHit = false;
    var tps = PRODUCTION_CLEANUP.testPhoneExact;
    for (var t = 0; t < tps.length; t++) {
      if (phoneNorm === String(tps[t]).replace(/\D/g, '')) phoneHit = true;
    }
    if (!nameHit && !phoneHit) continue;
    if (!isNaN(totNum) && totNum > 0 && !phoneHit) {
      report.lines.push('CUSTOMERS row ' + row + ': SKIP (TOTAL_ORDERS>0) ' + name);
      continue;
    }
    report.lines.push('CUSTOMERS row ' + row + ': ' + name);
    removed++;
    if (!dryRun) sh.deleteRow(row);
  }
  report.customerRowsRemoved += removed;
}

function productionCleanupExpenses_(ss, report, dryRun) {
  var sh = ss.getSheetByName(SHEETS.EXPENSE);
  if (!sh) return;
  var start = PRODUCTION_CLEANUP.expenseDataStart;
  var last = sh.getLastRow();
  var removed = 0;
  for (var row = last; row >= start; row--) {
    var desc = String(sh.getRange(row, 8).getValue() || '');
    var vendor = String(sh.getRange(row, 9).getValue() || '');
    var cat = String(sh.getRange(row, 5).getValue() || '');
    var blob = desc + ' ' + vendor + ' ' + cat;
    if (!productionCleanupMatchesText_(blob)) continue;
    report.lines.push('EXPENSE row ' + row + ': ' + vendor + ' | ' + desc);
    removed++;
    if (!dryRun) sh.deleteRow(row);
  }
  report.expenseRowsRemoved += removed;
}

function productionCleanupCourier_(ss, report, dryRun) {
  var sh = ss.getSheetByName(SHEETS.COURIER);
  if (!sh) return;
  var start = PRODUCTION_CLEANUP.courierDataStart;
  var last = sh.getLastRow();
  var removed = 0;
  for (var row = last; row >= start; row--) {
    var oid = String(sh.getRange(row, 1).getValue() || '');
    var cust = String(sh.getRange(row, 2).getValue() || '');
    if (!oid && !cust) continue;
    if (!productionCleanupMatchesOrderId_(oid) && !productionCleanupMatchesText_(cust)) continue;
    report.lines.push('COURIER row ' + row + ': ' + oid);
    removed++;
    if (!dryRun) sh.deleteRow(row);
  }
  report.courierRowsRemoved += removed;
}

function productionCleanupReturns_(ss, report, dryRun) {
  if (!SHEETS.RETURNS) return;
  var sh = ss.getSheetByName(SHEETS.RETURNS);
  if (!sh) return;
  var start = 3;
  var last = sh.getLastRow();
  var removed = 0;
  for (var row = last; row >= start; row--) {
    var oid = String(sh.getRange(row, 1).getValue() || '');
    var cust = String(sh.getRange(row, 2).getValue() || '');
    if (!oid && !cust) continue;
    if (!productionCleanupMatchesOrderId_(oid) && !productionCleanupMatchesText_(cust)) continue;
    report.lines.push('RETURNS row ' + row + ': ' + oid);
    removed++;
    if (!dryRun) sh.deleteRow(row);
  }
  report.returnsRowsRemoved = (report.returnsRowsRemoved || 0) + removed;
}

/**
 * Optional: remove PDFs in "Alma ERP Invoices" whose names look like test orders.
 * Only runs if Phase 4 folder helper exists.
 */
function productionCleanupDriveInvoicePdfs_(report, dryRun) {
  if (typeof getOrCreateAlmaErpInvoicesFolder_ !== 'function') {
    report.lines.push('Drive: Phase4 getOrCreateAlmaErpInvoicesFolder_ not loaded — skipped');
    return;
  }
  var folder;
  try {
    folder = getOrCreateAlmaErpInvoicesFolder_();
  } catch (e) {
    report.lines.push('Drive: folder open failed — ' + e.message);
    return;
  }
  var prefix = PRODUCTION_CLEANUP.almaInvoicePdfPrefix;
  var it = folder.getFiles();
  var n = 0;
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    if (name.indexOf(prefix) !== 0 || !/\.pdf$/i.test(name)) continue;
    var base = name.replace(/\.pdf$/i, '').substring(prefix.length);
    if (!productionCleanupMatchesOrderId_(base) && !/test|demo|sample|debug|fake|mock/i.test(base)) continue;
    report.lines.push('Drive file: ' + name);
    n++;
    if (!dryRun) {
      try {
        f.setTrashed(true);
      } catch (e2) {
        report.lines.push('Drive trash failed: ' + name + ' — ' + e2.message);
      }
    }
  }
  report.driveFilesTrashed += n;
}

/**
 * Preview only — run from editor or menu. Safe: no deletes.
 */
function previewProductionCleanup_() {
  var report = productionCleanupRun_(true);
  productionCleanupShowReport_(report, 'PREVIEW (no changes)');
}

/**
 * Deletes matched rows after user types DELETE in the prompt.
 */
function runProductionCleanupWithConfirm_() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt(
    'Production cleanup',
    'This removes rows that match TEST/DEBUG/SAMPLE/DEMO/MOCK/FAKE markers (see ProductionCleanup.gs.js).\n\n' +
      'Type DELETE in capitals to run. Cancel to abort.',
    ui.ButtonSet.OK_CANCEL
  );
  if (r.getSelectedButton() !== ui.Button.OK) return;
  if (String(r.getResponseText()).trim() !== 'DELETE') {
    ui.alert('Cancelled — you must type exactly: DELETE');
    return;
  }
  var report = productionCleanupRun_(false);
  productionCleanupShowReport_(report, 'CLEANUP COMPLETE');
  ui.alert('Done. Review the log output and 🤖 AUTOMATION LOG. Run preview again to confirm zero matches.');
}

/**
 * Optional: set current year invoice counter to 0 (next invoice will be ...-0001).
 * Only use if no real invoices were issued this year.
 */
function resetInvoiceCounterCurrentYearWithConfirm_() {
  var ui = SpreadsheetApp.getUi();
  var y = new Date().getFullYear().toString();
  var prefix =
    typeof INV_CONFIG !== 'undefined' && INV_CONFIG.counterKey ? INV_CONFIG.counterKey : 'AL_INV_COUNTER_';
  var key = prefix + y;
  var r = ui.prompt(
    'Reset invoice counter',
    'Type RESET-INV-' + y + ' to set ' + key + ' to 0 (dangerous if real invoices exist).',
    ui.ButtonSet.OK_CANCEL
  );
  if (r.getSelectedButton() !== ui.Button.OK) return;
  if (String(r.getResponseText()).trim() !== 'RESET-INV-' + y) {
    ui.alert('Cancelled.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty(key, '0');
  ui.alert('Script property ' + key + ' set to 0.');
}

function productionCleanupRun_(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = {
    dryRun: dryRun,
    lines: [],
    ordersRemoved: 0,
    logRowsRemoved: 0,
    stockRowsRemoved: 0,
    customerRowsRemoved: 0,
    expenseRowsRemoved: 0,
    courierRowsRemoved: 0,
    driveFilesTrashed: 0,
    returnsRowsRemoved: 0,
  };
  if (typeof SHEETS === 'undefined') {
    report.lines.push('ERROR: SHEETS not defined — paste WebApp_API.gs.js / Code.gs before this file.');
    return report;
  }
  productionCleanupOrders_(ss, report, dryRun);
  productionCleanupAutomationLog_(ss, report, dryRun);
  productionCleanupStock_(ss, report, dryRun);
  productionCleanupCustomers_(ss, report, dryRun);
  productionCleanupExpenses_(ss, report, dryRun);
  productionCleanupCourier_(ss, report, dryRun);
  productionCleanupReturns_(ss, report, dryRun);
  productionCleanupDriveInvoicePdfs_(report, dryRun);
  var summary =
    'dryRun=' +
    dryRun +
    ' orders=' +
    report.ordersRemoved +
    ' log=' +
    report.logRowsRemoved +
    ' stock=' +
    report.stockRowsRemoved +
    ' customers=' +
    report.customerRowsRemoved +
    ' expense=' +
    report.expenseRowsRemoved +
    ' courier=' +
    report.courierRowsRemoved +
    ' returns=' +
    report.returnsRowsRemoved +
    ' drivePdf=' +
    report.driveFilesTrashed;
  report.lines.unshift('SUMMARY: ' + summary);
  Logger.log(summary);
  return report;
}

function productionCleanupShowReport_(report, title) {
  var body = report.lines.join('\n');
  if (body.length > 4500) body = body.substring(0, 4500) + '\n…(truncated — View → Executions → full logs)';
  var esc = String(body)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  var html =
    '<html><body style="margin:12px;"><pre style="font-family:Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;">' +
    esc +
    '</pre></body></html>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(760).setHeight(540),
    title
  );
}

/** Wire from Code.gs onOpen: if (typeof onOpenProductionCleanupMenu_ === 'function') onOpenProductionCleanupMenu_(menu); */
function onOpenProductionCleanupMenu_(menu) {
  var ui = SpreadsheetApp.getUi();
  return menu.addSubMenu(
    ui.createMenu('🧹 Production')
      .addItem('Preview test-data cleanup', 'previewProductionCleanup_')
      .addItem('DELETE test rows (type DELETE)', 'runProductionCleanupWithConfirm_')
      .addSeparator()
      .addItem('Reset invoice counter (typed code)', 'resetInvoiceCounterCurrentYearWithConfirm_')
  );
}
