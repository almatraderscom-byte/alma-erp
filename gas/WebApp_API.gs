/**
 * ALMA LIFESTYLE ERP — Web App API
 *
 * Deploy:  Extensions → Apps Script → Deploy → New deployment
 *          Type: Web App | Execute as: Me | Access: Anyone
 *
 * Script Properties (Project Settings → Script Properties):
 *   API_SECRET = alma-dev-secret
 *
 * Field names (POST body for create_order):
 *   customer, phone, address, product, category, qty,
 *   sell_price, unit_price, courier, payment_method, status,
 *   cogs, courier_charge, shipping_fee, notes, size, source
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

var CFG = {
  orderSheets: ['📦 ORDERS', 'ORDERS', 'Orders'],
  logSheets:   ['🤖 AUTOMATION LOG', 'LOG', 'AUTOMATION_LOG', 'Automation Log'],
  orderIdPrefix: 'ALM-',
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('API_SECRET') || 'alma-dev-secret';
}

function getSS_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function findSheet_(names) {
  var ss = getSS_();
  for (var i = 0; i < names.length; i++) {
    var s = ss.getSheetByName(names[i]);
    if (s) return s;
  }
  var all = ss.getSheets().map(function(s) { return '"' + s.getName() + '"'; }).join(', ');
  throw new Error('Sheet not found. Tried: ' + JSON.stringify(names) + '. Available: ' + all);
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function log_(type, ref, msg, detail) {
  Logger.log('[' + type + '] ' + ref + ' | ' + msg);
  try {
    var sh = findSheet_(CFG.logSheets);
    sh.appendRow([
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      type, String(ref || ''), String(msg || ''), String(detail || '').slice(0, 300),
    ]);
  } catch (e) { Logger.log('log_ write failed: ' + e.message); }
}

/** Build { HEADER_NAME: colIndex_1based } from a sheet's header row. */
function buildColMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (!lastCol) return {};
  // Try row 1, if it has fewer than 3 non-empty cells try row 2 (brand header row)
  function rowToMap(rowNum) {
    var vals = sheet.getRange(rowNum, 1, 1, lastCol).getValues()[0];
    var map = {}, nonEmpty = 0;
    for (var i = 0; i < vals.length; i++) {
      var h = String(vals[i]).trim().toUpperCase().replace(/[\s\/\-()]+/g, '_').replace(/_+$/, '');
      if (h) { map[h] = i + 1; nonEmpty++; }
    }
    return { map: map, count: nonEmpty };
  }
  var r1 = rowToMap(1);
  if (r1.count >= 3) return r1.map;
  var r2 = rowToMap(2);
  return r2.count >= r1.count ? r2.map : r1.map;
}

/** Write a value to a cell identified by header name. Silent if column missing. */
function writeCell_(sheet, row, colMap, headerName, value) {
  // Try exact match, then common aliases
  var aliases = [
    headerName.toUpperCase().replace(/[\s\-]+/g, '_'),
    headerName.toUpperCase(),
  ];
  for (var i = 0; i < aliases.length; i++) {
    var col = colMap[aliases[i]];
    if (col) {
      var cell = sheet.getRange(row, col);
      // Skip formula columns
      if (cell.getFormula()) return;
      cell.setValue(value);
      return;
    }
  }
  Logger.log('writeCell_: no column for "' + headerName + '" in colMap');
}

/** Find the next empty row after the last row that has data in the first 3 columns. */
function nextDataRow_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return 2;
  // Scan backwards to find last non-empty row in col 1..3
  var range = sheet.getRange(1, 1, last, Math.min(3, sheet.getLastColumn())).getValues();
  for (var r = range.length - 1; r >= 0; r--) {
    if (range[r][0] || range[r][1] || (range[r][2] && String(range[r][2]).trim())) {
      return r + 2; // 1-based + 1
    }
  }
  return 2;
}

/** Find a row by ORDER_ID value. */
function findOrderRow_(sheet, colMap, orderId) {
  var col = colMap['ORDER_ID'] || colMap['ID'];
  if (!col) throw new Error('ORDER_ID column not found');
  var last = sheet.getLastRow();
  if (last < 2) throw new Error('Order not found: ' + orderId);
  var ids = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(orderId).trim()) return i + 2;
  }
  throw new Error('Order not found: ' + orderId);
}

function fmtDate_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val).split('T')[0] || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  Logger.log('doGet route=' + p.route);
  try {
    switch (p.route) {
      case 'orders':    return respond_(getOrders_(p));
      case 'order':     return respond_(getOrder_(p.id));
      case 'customers': return respond_(getCustomers_(p));
      case 'dashboard': return respond_(getDashboard_());
      case 'analytics': return respond_(getDashboard_());
      case 'log':       return respond_(getLog_(p));
      case 'stock':     return respond_(getStock_());
      case 'finance':   return respond_(getFinance_());
      default:
        return respond_({ ok: true, service: 'Alma ERP API', version: '3.0',
          routes: ['orders','order','customers','dashboard','analytics','log','stock','finance'] });
    }
  } catch (err) {
    Logger.log('doGet error: ' + err.message);
    return respond_({ error: err.message });
  }
}

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
  Logger.log('doPost raw: ' + raw.slice(0, 300));
  var body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return respond_({ error: 'Invalid JSON: ' + err.message });
  }

  if (body.secret !== getSecret_()) {
    Logger.log('doPost: UNAUTHORIZED');
    return respond_({ error: 'Unauthorized' });
  }

  Logger.log('doPost route=' + body.route + ' customer=' + body.customer + ' product=' + body.product);

  try {
    switch (body.route) {
      case 'create_order':    return respond_(createOrder_(body));
      case 'update_status':   return respond_(updateStatus_(body));
      case 'update_tracking': return respond_(updateTracking_(body));
      case 'update_field':    return respond_(updateField_(body));
      default:
        return respond_({ error: 'Unknown POST route: ' + body.route });
    }
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + (err.stack || ''));
    log_('ERROR', body.route || '?', err.message, err.stack || '');
    return respond_({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER
// ─────────────────────────────────────────────────────────────────────────────

function createOrder_(body) {
  if (!body.customer)       throw new Error('Missing required field: customer');
  if (!body.phone)          throw new Error('Missing required field: phone');
  if (!body.product)        throw new Error('Missing required field: product');
  if (!body.payment_method) throw new Error('Missing required field: payment_method');

  var sheet  = findSheet_(CFG.orderSheets);
  var colMap = buildColMap_(sheet);
  var newRow = nextDataRow_(sheet);

  var qty         = Number(body.qty)          || 1;
  var unitPrice   = Number(body.unit_price)   || 0;
  var sellPrice   = Number(body.sell_price)   || (unitPrice * qty);
  var cogs        = Number(body.cogs)         || 0;
  var courierChg  = Number(body.courier_charge) || 0;
  var shippingFee = Number(body.shipping_fee) || 0;
  var discount    = Number(body.discount)     || 0;
  var profit      = sellPrice - cogs - courierChg + shippingFee - discount;
  var today       = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Derive order ID from row position
  var dataStartRow = newRow <= 3 ? newRow : 3; // guess; will adjust after reading back
  // Use last row count as sequence number
  var seq = newRow - 1; // row 2 = seq 1 when header is row 1
  var orderId = CFG.orderIdPrefix + String(seq).padStart(4, '0');

  Logger.log('createOrder_: row=' + newRow + ' orderId=' + orderId + ' customer=' + body.customer);

  // Write each field using column map
  var w = function(name, val) { writeCell_(sheet, newRow, colMap, name, val); };

  w('ORDER_ID',       orderId);
  w('DATE',           today);
  w('CUSTOMER',       String(body.customer).trim());
  w('PHONE',          String(body.phone).trim());
  w('ADDRESS',        String(body.address || ''));
  w('PAYMENT',        String(body.payment_method));
  w('PAYMENT_METHOD', String(body.payment_method));
  w('SOURCE',         String(body.source   || ''));
  w('STATUS',         String(body.status   || 'Pending'));
  w('PRODUCT',        String(body.product).trim());
  w('CATEGORY',       String(body.category || ''));
  w('SIZE',           String(body.size     || ''));
  w('SKU',            String(body.sku      || ''));
  w('QTY',            qty);
  w('UNIT_PRICE',     unitPrice);
  w('SELL_PRICE',     sellPrice);
  w('COGS',           cogs);
  w('COURIER_CHARGE', courierChg);
  w('SHIPPING_FEE',   shippingFee);
  w('DISCOUNT',       discount);
  w('PROFIT',         profit);
  w('COURIER',        String(body.courier  || ''));
  w('NOTES',          String(body.notes    || ''));
  w('HANDLED_BY',     'Web');

  SpreadsheetApp.flush();

  // Verify write by reading back ORDER_ID
  var idCol = colMap['ORDER_ID'] || colMap['ID'];
  if (idCol) {
    var written = String(sheet.getRange(newRow, idCol).getValue()).trim();
    Logger.log('createOrder_: verify ORDER_ID="' + written + '"');
    if (written !== orderId) {
      // The sheet may have a formula-based ORDER_ID; use whatever is there
      if (written) orderId = written;
    }
  }

  log_('CREATE_ORDER', orderId, body.customer + ' | ' + body.product,
       'sell=' + sellPrice + ' profit=' + Math.round(profit) + ' row=' + newRow);

  return { ok: true, order_id: orderId, profit: Math.round(profit), row: newRow };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE STATUS
// ─────────────────────────────────────────────────────────────────────────────

function updateStatus_(body) {
  if (!body.id)     throw new Error('id required');
  if (!body.status) throw new Error('status required');

  var sheet  = findSheet_(CFG.orderSheets);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, body.id);

  var statusCol = colMap['STATUS'];
  if (!statusCol) throw new Error('STATUS column not found');

  var oldStatus = String(sheet.getRange(row, statusCol).getValue());
  sheet.getRange(row, statusCol).setValue(body.status);

  if (body.status === 'Delivered' && colMap['ACTUAL_DELIVERY'])
    sheet.getRange(row, colMap['ACTUAL_DELIVERY']).setValue(
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  if (body.status === 'Returned' && colMap['RETURN_DATE'])
    sheet.getRange(row, colMap['RETURN_DATE']).setValue(
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));

  SpreadsheetApp.flush();
  log_('UPDATE_STATUS', body.id, oldStatus + ' → ' + body.status, '');
  return { ok: true, order_id: body.id, old_status: oldStatus, new_status: body.status };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE TRACKING
// ─────────────────────────────────────────────────────────────────────────────

function updateTracking_(body) {
  if (!body.id)          throw new Error('id required');
  if (!body.tracking_id) throw new Error('tracking_id required');

  var sheet  = findSheet_(CFG.orderSheets);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, body.id);

  if (colMap['TRACKING_ID'])    sheet.getRange(row, colMap['TRACKING_ID']).setValue(body.tracking_id);
  if (body.courier && colMap['COURIER']) sheet.getRange(row, colMap['COURIER']).setValue(body.courier);

  var autoShipped = false;
  if (colMap['STATUS']) {
    var cur = String(sheet.getRange(row, colMap['STATUS']).getValue());
    if (['Pending','Confirmed','Packed'].indexOf(cur) !== -1) {
      sheet.getRange(row, colMap['STATUS']).setValue('Shipped');
      autoShipped = true;
    }
  }

  SpreadsheetApp.flush();
  log_('UPDATE_TRACKING', body.id, body.tracking_id, body.courier || '');
  return { ok: true, order_id: body.id, tracking_id: body.tracking_id, auto_shipped: autoShipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE FIELD
// ─────────────────────────────────────────────────────────────────────────────

function updateField_(body) {
  if (!body.id)    throw new Error('id required');
  if (!body.field) throw new Error('field required');
  if (body.value === undefined) throw new Error('value required');

  var sheet  = findSheet_(CFG.orderSheets);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, body.id);

  var fieldKey = String(body.field).toUpperCase().replace(/[\s\-]+/g, '_');
  var col = colMap[fieldKey];
  if (!col) throw new Error('Column not found: ' + body.field);

  sheet.getRange(row, col).setValue(body.value);
  SpreadsheetApp.flush();
  log_('UPDATE_FIELD', body.id, body.field + '=' + body.value, '');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: orders
// ─────────────────────────────────────────────────────────────────────────────

function getOrders_(p) {
  var sheet   = findSheet_(CFG.orderSheets);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { orders: [], summary: { total: 0, total_revenue: 0, total_profit: 0, by_status: {} } };

  var numCols  = sheet.getLastColumn();
  var colMap   = buildColMap_(sheet);
  var headerRow = _detectHeaderRow_(sheet);
  var dataStart = headerRow + 1;
  if (lastRow < dataStart) return { orders: [], summary: { total: 0, total_revenue: 0, total_profit: 0, by_status: {} } };

  var headers = sheet.getRange(headerRow, 1, 1, numCols).getValues()[0];
  var raw     = sheet.getRange(dataStart, 1, lastRow - dataStart + 1, numCols).getValues();

  var orders = [];
  for (var r = 0; r < raw.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-()]+/g, '_').replace(/_+$/, '');
      if (key) obj[key] = raw[r][c];
    }
    var id = obj['order_id'] || obj['id'] || '';
    if (!String(id).trim()) continue;
    orders.push(rowToOrder_(obj));
  }

  var statusF = p.status || '', search = (p.search || '').toLowerCase();
  var limit = Math.min(Number(p.limit || 500), 1000);
  var offset = Number(p.offset || 0);

  if (statusF) orders = orders.filter(function(o) { return o.status === statusF; });
  if (search) orders = orders.filter(function(o) {
    return [o.id, o.customer, o.product, o.phone].join(' ').toLowerCase().indexOf(search) !== -1;
  });

  var total = orders.length;
  orders = orders.slice(offset, offset + limit);

  var byStatus = {}, totalRev = 0, totalPro = 0;
  orders.forEach(function(o) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    totalRev += o.sell_price;
    totalPro += o.profit;
  });

  return { orders: orders, summary: { total: total, total_revenue: Math.round(totalRev), total_profit: Math.round(totalPro), by_status: byStatus } };
}

function _detectHeaderRow_(sheet) {
  var numCols = sheet.getLastColumn();
  if (!numCols) return 1;
  var r1 = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var r2 = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, 1, numCols).getValues()[0] : [];
  var c1 = r1.filter(function(v) { return String(v).trim(); }).length;
  var c2 = r2.filter(function(v) { return String(v).trim(); }).length;
  return c2 > c1 ? 2 : 1;
}

function getOrder_(id) {
  if (!id) throw new Error('id required');
  var sheet   = findSheet_(CFG.orderSheets);
  var numCols = sheet.getLastColumn();
  var colMap  = buildColMap_(sheet);
  var row     = findOrderRow_(sheet, colMap, id);
  var headerRow = _detectHeaderRow_(sheet);
  var headers = sheet.getRange(headerRow, 1, 1, numCols).getValues()[0];
  var vals    = sheet.getRange(row, 1, 1, numCols).getValues()[0];
  var obj = {};
  for (var c = 0; c < headers.length; c++) {
    var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-()]+/g, '_').replace(/_+$/, '');
    if (key) obj[key] = vals[c];
  }
  return { order: rowToOrder_(obj) };
}

function rowToOrder_(obj) {
  var sellPrice = Number(obj['sell_price'] || obj['selling_price'] || 0);
  var profit    = Number(obj['profit'] || 0);
  return {
    id:              String(obj['order_id']     || obj['id']           || ''),
    date:            fmtDate_(obj['date']),
    customer:        String(obj['customer']     || ''),
    phone:           String(obj['phone']        || ''),
    address:         String(obj['address']      || ''),
    payment:         String(obj['payment']      || obj['payment_method'] || ''),
    payment_method:  String(obj['payment_method'] || obj['payment']    || ''),
    source:          String(obj['source']       || ''),
    status:          String(obj['status']       || 'Pending'),
    product:         String(obj['product']      || ''),
    category:        String(obj['category']     || ''),
    size:            String(obj['size']         || ''),
    qty:             Number(obj['qty'])          || 1,
    unit_price:      Number(obj['unit_price'])   || 0,
    sell_price:      sellPrice,
    cogs:            Number(obj['cogs'])          || 0,
    courier_charge:  Number(obj['courier_charge']) || 0,
    shipping_fee:    Number(obj['shipping_fee']) || 0,
    discount:        Number(obj['discount'])     || 0,
    profit:          profit,
    margin_pct:      sellPrice > 0 ? Math.round(profit / sellPrice * 100) : 0,
    courier:         String(obj['courier']       || ''),
    tracking_id:     String(obj['tracking_id']   || ''),
    tracking_status: String(obj['tracking_status'] || ''),
    est_delivery:    fmtDate_(obj['est_delivery']),
    actual_delivery: fmtDate_(obj['actual_delivery']),
    return_reason:   String(obj['return_reason'] || ''),
    return_date:     fmtDate_(obj['return_date']),
    return_status:   String(obj['return_status'] || ''),
    notes:           String(obj['notes']         || ''),
    sku:             String(obj['sku']            || ''),
    handled_by:      String(obj['handled_by']     || ''),
    invoice_num:     String(obj['invoice_num']    || obj['invoice_number'] || ''),
    days_pending:    Number(obj['days_pending'])  || 0,
    days_in_transit: Number(obj['days_in_transit']) || 0,
    sla_status:      String(obj['sla_status']     || ''),
    auto_flag:       String(obj['auto_flag']      || ''),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: customers
// ─────────────────────────────────────────────────────────────────────────────

function getCustomers_(p) {
  var cusSheets = ['👥 CUSTOMERS', 'CUSTOMERS', 'Customers'];
  var sheet;
  try { sheet = findSheet_(cusSheets); }
  catch (e) { return { customers: [], total: 0 }; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { customers: [], total: 0 };

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var raw     = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var search  = (p.search || '').toLowerCase();

  var customers = [];
  for (var r = 0; r < raw.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-()]+/g, '_').replace(/_+$/, '');
      if (key) obj[key] = raw[r][c];
    }
    var name = String(obj['name'] || obj['customer'] || '').trim();
    if (!name) continue;
    var cust = {
      id:           String(obj['id']           || name),
      name:         name,
      phone:        String(obj['phone']         || ''),
      district:     String(obj['district']      || ''),
      address:      String(obj['address']       || ''),
      total_orders: Number(obj['total_orders'])  || 0,
      total_spent:  Number(obj['total_spent'])   || 0,
      segment:      String(obj['segment']        || 'NEW'),
      risk_level:   String(obj['risk_level']     || 'LOW'),
      source:       String(obj['source']         || ''),
      last_order:   fmtDate_(obj['last_order']),
    };
    if (search && [cust.name, cust.phone].join(' ').toLowerCase().indexOf(search) === -1) continue;
    customers.push(cust);
  }
  return { customers: customers, total: customers.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: dashboard
// ─────────────────────────────────────────────────────────────────────────────

function getDashboard_() {
  var result = getOrders_({});
  var orders = result.orders;
  var kpis = {
    total_orders:    orders.length,
    total_revenue:   result.summary.total_revenue,
    total_profit:    result.summary.total_profit,
    total_cogs:      0,
    gross_margin:    0,
    avg_order_value: orders.length > 0 ? Math.round(result.summary.total_revenue / orders.length) : 0,
    delivered_count: 0,
    delivery_rate:   0,
    return_rate:     0,
    sla_breaches:    0,
    pending_action:  0,
  };
  var byStatus = {}, bySource = {}, byPayment = {}, byCat = {};
  var totalCogs = 0;

  orders.forEach(function(o) {
    byStatus[o.status]   = (byStatus[o.status]   || 0) + 1;
    byPayment[o.payment_method] = (byPayment[o.payment_method] || 0) + 1;
    if (!bySource[o.source]) bySource[o.source] = { orders: 0, revenue: 0 };
    bySource[o.source].orders++;
    bySource[o.source].revenue += o.sell_price;
    if (!byCat[o.category]) byCat[o.category] = { orders: 0, revenue: 0, profit: 0 };
    byCat[o.category].orders++;
    byCat[o.category].revenue += o.sell_price;
    byCat[o.category].profit  += o.profit;
    totalCogs += o.cogs;
    if (o.status === 'Delivered') kpis.delivered_count++;
    if (['Pending','Confirmed'].indexOf(o.status) !== -1) kpis.pending_action++;
  });

  kpis.total_cogs   = Math.round(totalCogs);
  kpis.delivery_rate = orders.length > 0 ? Math.round(kpis.delivered_count / orders.length * 100) : 0;
  kpis.return_rate   = orders.length > 0 ? Math.round((byStatus['Returned'] || 0) / orders.length * 100) : 0;
  kpis.gross_margin  = kpis.total_revenue > 0 ? Math.round(kpis.total_profit / kpis.total_revenue * 100) : 0;

  return {
    kpis:          kpis,
    by_status:     byStatus,
    by_source:     bySource,
    by_payment:    byPayment,
    by_category:   byCat,
    sla_breaches:  [],
    recent_orders: orders.slice(-10).reverse().map(function(o) {
      return { id: o.id, date: o.date, customer: o.customer, product: o.product,
               status: o.status, sell_price: o.sell_price, profit: o.profit };
    }),
    generated_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: log
// ─────────────────────────────────────────────────────────────────────────────

function getLog_(p) {
  var limit = Math.min(Number(p.limit || 100), 500);
  var sheet;
  try { sheet = findSheet_(CFG.logSheets); }
  catch (e) { return { events: [], total: 0 }; }

  var last = sheet.getLastRow();
  if (last < 2) return { events: [], total: 0 };

  var fetchRows = Math.min(limit, last - 1);
  var startRow  = Math.max(2, last - fetchRows + 1);
  var raw = sheet.getRange(startRow, 1, fetchRows, 5).getValues();

  return {
    events: raw.map(function(r) {
      return { timestamp: fmtDate_(r[0]) || String(r[0]), type: String(r[1] || ''),
               reference: String(r[2] || ''), message: String(r[3] || ''), detail: String(r[4] || '') };
    }).reverse(),
    total: last - 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: stock
// ─────────────────────────────────────────────────────────────────────────────

function getStock_() {
  var stockSheets = ['📦 STOCK CONTROL', 'STOCK', 'Stock', 'INVENTORY', 'Inventory'];
  var sheet;
  try { sheet = findSheet_(stockSheets); }
  catch (e) { return { items: [], summary: { total_skus: 0, low_stock: 0, out_of_stock: 0, total_value: 0 } }; }

  var last = sheet.getLastRow();
  if (last < 2) return { items: [], summary: { total_skus: 0, low_stock: 0, out_of_stock: 0, total_value: 0 } };

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var raw     = sheet.getRange(2, 1, last - 1, numCols).getValues();

  var items = [], low = 0, out = 0;
  for (var r = 0; r < raw.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-()]+/g, '_').replace(/_+$/, '');
      if (key) obj[key] = raw[r][c];
    }
    if (!obj['sku'] && !obj['product']) continue;
    var avail   = Number(obj['available'] || obj['current_stock'] || 0);
    var reorder = Number(obj['reorder_level'] || 5);
    if (avail <= 0) out++;
    else if (avail < reorder) low++;
    items.push({
      sku: String(obj['sku'] || ''), product: String(obj['product'] || ''),
      category: String(obj['category'] || ''), size: String(obj['size'] || ''),
      available: avail, reorder_level: reorder,
      status: avail <= 0 ? 'Out of Stock' : avail < reorder ? 'Low Stock' : 'In Stock',
      stock_value: 0, sell_value: 0, potential_profit: 0,
    });
  }
  return { items: items, summary: { total_skus: items.length, low_stock: low, out_of_stock: out, total_value: 0 } };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: finance
// ─────────────────────────────────────────────────────────────────────────────

function getFinance_() {
  var expSheets = ['💸 EXPENSE LEDGER', 'EXPENSES', 'Expenses'];
  var expenses = [], byCat = {}, totalExpense = 0;
  try {
    var sh = findSheet_(expSheets);
    var last = sh.getLastRow();
    if (last >= 2) {
      var raw = sh.getRange(2, 1, last - 1, 4).getValues();
      raw.forEach(function(r) {
        var cat = String(r[1] || ''), amt = Number(r[2] || 0);
        if (!cat) return;
        byCat[cat]    = (byCat[cat] || 0) + amt;
        totalExpense  += amt;
        expenses.push({ date: fmtDate_(r[0]), category: cat, amount: amt, notes: String(r[3] || '') });
      });
    }
  } catch (e) {}

  var orders = getOrders_({});
  var totalIncome = orders.summary.total_revenue;

  return {
    cash_balance:    Math.round(totalIncome - totalExpense),
    total_income:    Math.round(totalIncome),
    total_expense:   Math.round(totalExpense),
    net_profit:      Math.round(orders.summary.total_profit - totalExpense),
    expense_by_cat:  byCat,
    recent_expenses: expenses.slice(-20).reverse(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST (run from GAS editor — creates a real row, delete it after)
// ─────────────────────────────────────────────────────────────────────────────

function testCreateOrder() {
  var result = createOrder_({
    customer:       'TEST CUSTOMER',
    phone:          '01700000000',
    address:        'Test Address, Dhaka',
    product:        'Test Product',
    category:       'Tops',
    qty:            1,
    unit_price:     800,
    sell_price:     800,
    cogs:           400,
    courier_charge: 80,
    shipping_fee:   0,
    payment_method: 'COD',
    source:         'Facebook',
    status:         'Pending',
    courier:        'Pathao',
    notes:          'AUTO TEST — DELETE THIS ROW',
  });
  Logger.log(JSON.stringify(result));
  SpreadsheetApp.getUi().alert(
    result.ok
      ? '✅ Created: ' + result.order_id + ' | row ' + result.row + ' | profit ৳' + result.profit +
        '\n\nDelete this test row from the ORDERS sheet.'
      : '❌ Failed: ' + result.error
  );
}
