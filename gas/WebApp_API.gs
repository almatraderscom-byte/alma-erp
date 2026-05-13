// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ALMA ERP — Google Apps Script Web App                                  ║
// ║  Deploy: Execute as Me | Access: Anyone                                 ║
// ║                                                                          ║
// ║  Script Properties (Project Settings → Script Properties):              ║
// ║    API_SECRET     = alma-dev-secret   (must match Vercel env)           ║
// ║    SPREADSHEET_ID = <your-sheet-id>   (from URL, or leave blank if      ║
// ║                     this script is bound/attached to the spreadsheet)   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('API_SECRET') || 'alma-dev-secret';
}

function getSS_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

// Returns a sheet by name; throws with available names if missing
function getSheet_(name) {
  var ss = getSS_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    var available = ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; }).join(', ');
    throw new Error('Sheet "' + name + '" not found. Available: ' + available);
  }
  return sheet;
}

// Tries a list of names, returns first match or throws
function findSheet_(names) {
  var ss = getSS_();
  for (var i = 0; i < names.length; i++) {
    var s = ss.getSheetByName(names[i]);
    if (s) return s;
  }
  var available = ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; }).join(', ');
  throw new Error('None of ' + JSON.stringify(names) + ' found. Available: ' + available);
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING (writes to LOG or AUTOMATION_LOG sheet if it exists)
// ─────────────────────────────────────────────────────────────────────────────

function writeLog_(type, ref, msg, detail) {
  Logger.log('[' + type + '] ref=' + ref + ' | ' + msg + (detail ? ' | ' + detail : ''));
  try {
    var ss = getSS_();
    var logSheet = ss.getSheetByName('LOG') || ss.getSheetByName('AUTOMATION_LOG');
    if (!logSheet) return;
    logSheet.appendRow([
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      type, ref || '', msg || '', detail || ''
    ]);
  } catch (e) {
    Logger.log('writeLog_ failed: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN MAP BUILDER
// Reads row 1 of a sheet, returns { HEADER_NAME: columnIndex (1-based) }
// Header names are uppercased and spaces → underscores for flexible matching
// ─────────────────────────────────────────────────────────────────────────────

function buildColMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) throw new Error('Sheet "' + sheet.getName() + '" has no columns');
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i]).trim().toUpperCase().replace(/[\s\/\-]+/g, '_');
    if (h) map[h] = i + 1; // 1-based column index
  }
  Logger.log('colMap for "' + sheet.getName() + '": ' + JSON.stringify(map));
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// doGet
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  var p = e.parameter;
  Logger.log('doGet route=' + p.route + ' params=' + JSON.stringify(p));
  try {
    switch (p.route) {
      case 'orders':              return jsonOut_(getOrders_(p));
      case 'order':               return jsonOut_(getOrder_(p.id));
      case 'customers':           return jsonOut_(getCustomers_(p));
      case 'customer':            return jsonOut_(getCustomer_(p.name));
      case 'dashboard':           return jsonOut_(getDashboard_());
      case 'analytics':           return jsonOut_(getDashboard_());
      case 'finance':             return jsonOut_(getFinance_());
      case 'stock':               return jsonOut_(getStock_());
      case 'log':                 return jsonOut_(getLog_(p));
      case 'next_invoice_number': return jsonOut_(getNextInvoiceNumber_());
      default:                    return jsonOut_({ error: 'Unknown GET route: ' + p.route });
    }
  } catch (err) {
    Logger.log('doGet error: ' + err.message + '\n' + err.stack);
    return jsonOut_({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// doPost
// ─────────────────────────────────────────────────────────────────────────────

function doPost(e) {
  var raw = (e.postData && e.postData.contents) ? e.postData.contents : '{}';
  Logger.log('doPost raw body (first 500): ' + raw.slice(0, 500));

  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    Logger.log('doPost: JSON parse failed: ' + err.message);
    return jsonOut_({ error: 'Invalid JSON body: ' + err.message });
  }

  Logger.log('doPost route=' + data.route + ' customer=' + data.customer + ' product=' + data.product);

  // Authenticate
  if (data.secret !== getSecret_()) {
    Logger.log('doPost: UNAUTHORIZED secret=' + data.secret);
    return jsonOut_({ error: 'Unauthorized' });
  }

  try {
    switch (data.route) {
      case 'create_order':     return jsonOut_(createOrder_(data));
      case 'update_status':    return jsonOut_(updateStatus_(data));
      case 'update_tracking':  return jsonOut_(updateTracking_(data));
      case 'update_field':     return jsonOut_(updateField_(data));
      case 'generate_invoice': return jsonOut_(generateInvoice_(data));
      case 'add_expense':      return jsonOut_(addExpense_(data));
      case 'add_product':      return jsonOut_(addProduct_(data));
      case 'create_customer':  return jsonOut_(createCustomer_(data));
      default:                 return jsonOut_({ error: 'Unknown POST route: ' + data.route });
    }
  } catch (err) {
    Logger.log('doPost error route=' + data.route + ': ' + err.message + '\n' + err.stack);
    writeLog_('ERROR', data.route, err.message, err.stack);
    return jsonOut_({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// create_order  ← KEY FIX: reads headers dynamically, verifies write
// ─────────────────────────────────────────────────────────────────────────────

function createOrder_(data) {
  // 1. Validate required fields
  if (!data.customer) throw new Error('Missing required field: customer');
  if (!data.phone)    throw new Error('Missing required field: phone');
  if (!data.product)  throw new Error('Missing required field: product');

  // 2. Find ORDERS sheet (tolerant of different capitalizations)
  var sheet = findSheet_(['ORDERS', 'Orders', 'orders', 'ORDER']);
  Logger.log('createOrder_: using sheet "' + sheet.getName() + '"');

  // 3. Build column map from header row
  var colMap = buildColMap_(sheet);

  // 4. Compute values
  var qty         = Number(data.qty)            || 1;
  var unitPrice   = Number(data.unit_price)     || 0;
  var sellPrice   = Number(data.sell_price)     || (unitPrice * qty);
  var cogs        = Number(data.cogs)           || 0;
  var courierChg  = Number(data.courier_charge) || 0;
  var shippingFee = Number(data.shipping_fee)   || 0;
  var discount    = Number(data.discount)       || 0;
  var profit      = sellPrice - cogs - courierChg + shippingFee - discount;
  var marginPct   = sellPrice > 0 ? Math.round((profit / sellPrice) * 100) : 0;
  var today       = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // 5. Generate order ID  (row 1 = header → first order at row 2 = ALM-0001)
  var lastRow  = sheet.getLastRow();
  var orderNum = lastRow;                              // lastRow=1 → ALM-0001
  var orderId  = 'ALM-' + String(orderNum).padStart(4, '0');
  var nextRow  = lastRow + 1;

  Logger.log('createOrder_: orderId=' + orderId + ' row=' + nextRow +
             ' customer=' + data.customer + ' product=' + data.product +
             ' qty=' + qty + ' sell_price=' + sellPrice + ' profit=' + profit);

  // 6. Write each field using dynamic column positions
  //    Skip columns not present in this sheet (logged but not fatal)
  //    Skip formula cells (they self-compute)
  function writeCell(headerName, value) {
    var col = colMap[headerName.toUpperCase()];
    if (!col) {
      Logger.log('createOrder_: column "' + headerName + '" not in sheet — skipping');
      return;
    }
    var cell = sheet.getRange(nextRow, col);
    // Don't overwrite existing formula cells
    if (cell.getFormula()) {
      Logger.log('createOrder_: "' + headerName + '" is a formula column — skipping setValue');
      return;
    }
    cell.setValue(value);
  }

  writeCell('ORDER_ID',        orderId);
  writeCell('DATE',            today);
  writeCell('CUSTOMER',        String(data.customer).trim());
  writeCell('PHONE',           String(data.phone).trim());
  writeCell('ADDRESS',         String(data.address  || ''));
  writeCell('PAYMENT',         String(data.payment  || 'COD'));
  writeCell('SOURCE',          String(data.source   || ''));
  writeCell('STATUS',          String(data.status   || 'Pending'));
  writeCell('PRODUCT',         String(data.product).trim());
  writeCell('CATEGORY',        String(data.category || ''));
  writeCell('SIZE',            String(data.size     || ''));
  writeCell('SKU',             String(data.sku      || ''));
  writeCell('QTY',             qty);
  writeCell('UNIT_PRICE',      unitPrice);
  writeCell('SELL_PRICE',      sellPrice);
  writeCell('COGS',            cogs);
  writeCell('COURIER_CHARGE',  courierChg);
  writeCell('SHIPPING_FEE',    shippingFee);
  writeCell('DISCOUNT',        discount);
  writeCell('PROFIT',          profit);
  writeCell('MARGIN_PCT',      marginPct);
  writeCell('COURIER',         String(data.courier      || ''));
  writeCell('TRACKING_ID',     String(data.tracking_id  || ''));
  writeCell('NOTES',           String(data.notes        || ''));
  writeCell('HANDLED_BY',      'Web');
  writeCell('AUTO_FLAG',       '');
  writeCell('INVOICE_NUM',     '');
  writeCell('RETURN_STATUS',   '');

  // 7. Flush all pending writes to Sheets
  SpreadsheetApp.flush();

  // 8. Verify write: read ORDER_ID back from the row we just wrote
  var orderIdCol = colMap['ORDER_ID'];
  if (!orderIdCol) throw new Error('ORDER_ID column not found in ORDERS sheet');
  var written = String(sheet.getRange(nextRow, orderIdCol).getValue()).trim();
  Logger.log('createOrder_: verification read ORDER_ID="' + written + '" expected="' + orderId + '"');
  if (written !== orderId) {
    throw new Error(
      'Sheet write failed verification: wrote "' + orderId +
      '" but read back "' + written + '" at row ' + nextRow +
      '. Check sheet permissions and column layout.'
    );
  }

  // 9. Log the event
  writeLog_('CREATE_ORDER', orderId,
    data.customer + ' | ' + data.product,
    'sell=' + sellPrice + ' profit=' + profit + ' row=' + nextRow
  );

  Logger.log('createOrder_: SUCCESS ' + orderId);
  return { ok: true, order_id: orderId, profit: profit };
}

// ─────────────────────────────────────────────────────────────────────────────
// update_status
// ─────────────────────────────────────────────────────────────────────────────

function updateStatus_(data) {
  if (!data.id)     throw new Error('Missing field: id');
  if (!data.status) throw new Error('Missing field: status');

  var sheet  = findSheet_(['ORDERS', 'Orders']);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, data.id);

  var statusCol = colMap['STATUS'];
  if (!statusCol) throw new Error('STATUS column not found');

  var oldStatus = String(sheet.getRange(row, statusCol).getValue());
  sheet.getRange(row, statusCol).setValue(data.status);

  // Write delivery date if Delivered
  if (data.status === 'Delivered' && colMap['ACTUAL_DELIVERY']) {
    sheet.getRange(row, colMap['ACTUAL_DELIVERY']).setValue(
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    );
  }
  // Write return date if Returned
  if (data.status === 'Returned' && colMap['RETURN_DATE']) {
    sheet.getRange(row, colMap['RETURN_DATE']).setValue(
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    );
  }

  SpreadsheetApp.flush();
  writeLog_('UPDATE_STATUS', data.id, oldStatus + ' → ' + data.status, '');
  return { ok: true, order_id: data.id, old_status: oldStatus, new_status: data.status };
}

// ─────────────────────────────────────────────────────────────────────────────
// update_tracking
// ─────────────────────────────────────────────────────────────────────────────

function updateTracking_(data) {
  if (!data.id)          throw new Error('Missing field: id');
  if (!data.tracking_id) throw new Error('Missing field: tracking_id');

  var sheet  = findSheet_(['ORDERS', 'Orders']);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, data.id);

  if (colMap['TRACKING_ID']) sheet.getRange(row, colMap['TRACKING_ID']).setValue(data.tracking_id);
  if (data.courier && colMap['COURIER']) sheet.getRange(row, colMap['COURIER']).setValue(data.courier);

  // Auto-advance to Shipped if currently Pending/Confirmed/Packed
  var autoShipped = false;
  if (colMap['STATUS']) {
    var currentStatus = String(sheet.getRange(row, colMap['STATUS']).getValue());
    if (['Pending', 'Confirmed', 'Packed'].indexOf(currentStatus) !== -1) {
      sheet.getRange(row, colMap['STATUS']).setValue('Shipped');
      autoShipped = true;
    }
  }

  SpreadsheetApp.flush();
  writeLog_('UPDATE_TRACKING', data.id, data.tracking_id, data.courier || '');
  return { ok: true, order_id: data.id, tracking_id: data.tracking_id, auto_shipped: autoShipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// update_field
// ─────────────────────────────────────────────────────────────────────────────

var FORMULA_COLS_ = ['ORDER_ID', 'PROFIT', 'MARGIN_PCT', 'DAYS_PENDING', 'DAYS_IN_TRANSIT'];

function updateField_(data) {
  if (!data.id)    throw new Error('Missing field: id');
  if (!data.field) throw new Error('Missing field: field');
  if (data.value === undefined || data.value === null) throw new Error('Missing field: value');

  var fieldUpper = String(data.field).toUpperCase();
  if (FORMULA_COLS_.indexOf(fieldUpper) !== -1) {
    throw new Error('Cannot update formula column: ' + data.field);
  }

  var sheet  = findSheet_(['ORDERS', 'Orders']);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, data.id);

  var col = colMap[fieldUpper];
  if (!col) throw new Error('Column "' + data.field + '" not found in ORDERS sheet');

  sheet.getRange(row, col).setValue(data.value);
  SpreadsheetApp.flush();

  writeLog_('UPDATE_FIELD', data.id, data.field + '=' + data.value, '');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// add_expense
// ─────────────────────────────────────────────────────────────────────────────

function addExpense_(data) {
  if (!data.category) throw new Error('Missing field: category');
  if (!data.amount)   throw new Error('Missing field: amount');

  var sheet = findSheet_(['EXPENSES', 'Expenses', 'EXPENSE_LEDGER', 'Expense Ledger']);
  var date  = data.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  sheet.appendRow([date, data.category, Number(data.amount), data.notes || '']);
  SpreadsheetApp.flush();

  writeLog_('ADD_EXPENSE', date, data.category + ' | ' + data.amount, data.notes || '');
  return { ok: true, expense_id: date + '_' + data.category };
}

// ─────────────────────────────────────────────────────────────────────────────
// add_product
// ─────────────────────────────────────────────────────────────────────────────

function addProduct_(data) {
  if (!data.name) throw new Error('Missing field: name');

  var sheet = findSheet_(['PRODUCTS', 'Products', 'CATALOG', 'Product Catalog']);
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  sheet.appendRow([
    data.name, data.category || '', Number(data.default_price) || 0,
    Number(data.default_cogs) || 0, data.notes || '', today, 'TRUE'
  ]);
  SpreadsheetApp.flush();

  return { ok: true, product_id: data.name };
}

// ─────────────────────────────────────────────────────────────────────────────
// create_customer
// ─────────────────────────────────────────────────────────────────────────────

function createCustomer_(data) {
  if (!data.name)  throw new Error('Missing field: name');
  if (!data.phone) throw new Error('Missing field: phone');

  var sheet = findSheet_(['CUSTOMERS', 'Customers', 'customers']);
  var colMap = buildColMap_(sheet);

  // Check for existing customer by phone
  var phoneCol = colMap['PHONE'];
  if (phoneCol) {
    var lastRow  = sheet.getLastRow();
    var phones   = lastRow > 1 ? sheet.getRange(2, phoneCol, lastRow - 1, 1).getValues() : [];
    for (var i = 0; i < phones.length; i++) {
      if (String(phones[i][0]).trim() === String(data.phone).trim()) {
        return { ok: true, customer_id: data.name, created: false }; // already exists
      }
    }
  }

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var nextRow = sheet.getLastRow() + 1;

  function writeCell(col, val) {
    var c = colMap[col.toUpperCase()];
    if (c) sheet.getRange(nextRow, c).setValue(val);
  }

  writeCell('NAME',     data.name);
  writeCell('PHONE',    data.phone);
  writeCell('ADDRESS',  data.address  || '');
  writeCell('DISTRICT', data.district || '');
  writeCell('SOURCE',   data.source   || '');
  writeCell('JOINED',   today);
  writeCell('SEGMENT',  'NEW');

  SpreadsheetApp.flush();
  writeLog_('CREATE_CUSTOMER', data.name, data.phone, data.district || '');
  return { ok: true, customer_id: data.name, created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// generate_invoice (stub — implement Phase 4 PDF logic here)
// ─────────────────────────────────────────────────────────────────────────────

function generateInvoice_(data) {
  if (!data.id) throw new Error('Missing field: id');

  var sheet  = findSheet_(['ORDERS', 'Orders']);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, data.id);

  // Check if invoice already generated
  if (colMap['INVOICE_NUM']) {
    var existing = String(sheet.getRange(row, colMap['INVOICE_NUM']).getValue()).trim();
    if (existing) return { ok: true, invoice_number: existing, drive_url: '' };
  }

  var invoiceNum = 'INV-' + data.id.replace('ALM-', '');
  if (colMap['INVOICE_NUM']) sheet.getRange(row, colMap['INVOICE_NUM']).setValue(invoiceNum);
  SpreadsheetApp.flush();

  writeLog_('GENERATE_INVOICE', data.id, invoiceNum, '');
  return { ok: true, invoice_number: invoiceNum, drive_url: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: orders
// ─────────────────────────────────────────────────────────────────────────────

function getOrders_(p) {
  var sheet  = findSheet_(['ORDERS', 'Orders']);
  var colMap = buildColMap_(sheet);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) return { orders: [], summary: { total: 0, total_revenue: 0, total_profit: 0, by_status: {} } };

  var numRows = lastRow - 1;
  var numCols = sheet.getLastColumn();
  var raw = sheet.getRange(2, 1, numRows, numCols).getValues();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];

  var orders = [];
  for (var r = 0; r < raw.length; r++) {
    var row = raw[r];
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-]+/g, '_');
      obj[key] = row[c];
    }
    if (!obj['order_id'] && !obj['id']) continue; // skip blank rows

    var order = rowToOrder_(obj);

    // Apply filters
    if (p.status  && order.status  !== p.status)  continue;
    if (p.source  && order.source  !== p.source)  continue;
    if (p.payment && order.payment !== p.payment) continue;
    if (p.search) {
      var q = String(p.search).toLowerCase();
      var haystack = [order.id, order.customer, order.product, order.phone].join(' ').toLowerCase();
      if (haystack.indexOf(q) === -1) continue;
    }

    orders.push(order);
  }

  // Apply limit/offset
  var limit  = p.limit  ? Math.min(Number(p.limit), 500)  : 200;
  var offset = p.offset ? Number(p.offset) : 0;
  orders = orders.slice(offset, offset + limit);

  // Summary
  var byStatus = {};
  var totalRevenue = 0, totalProfit = 0;
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    totalRevenue += Number(o.sell_price) || 0;
    totalProfit  += Number(o.profit)     || 0;
  }

  return {
    orders: orders,
    summary: {
      total:         orders.length,
      total_revenue: Math.round(totalRevenue),
      total_profit:  Math.round(totalProfit),
      by_status:     byStatus
    }
  };
}

function getOrder_(id) {
  if (!id) throw new Error('Missing id');
  var sheet  = findSheet_(['ORDERS', 'Orders']);
  var colMap = buildColMap_(sheet);
  var row    = findOrderRow_(sheet, colMap, id);
  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var vals    = sheet.getRange(row, 1, 1, numCols).getValues()[0];
  var obj = {};
  for (var c = 0; c < headers.length; c++) {
    var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-]+/g, '_');
    obj[key] = vals[c];
  }
  return { order: rowToOrder_(obj) };
}

function rowToOrder_(obj) {
  return {
    id:               String(obj['order_id']     || obj['id']         || ''),
    date:             fmt_date_(obj['date']),
    customer:         String(obj['customer']     || ''),
    phone:            String(obj['phone']        || ''),
    address:          String(obj['address']      || ''),
    payment:          String(obj['payment']      || ''),
    source:           String(obj['source']       || ''),
    status:           String(obj['status']       || 'Pending'),
    product:          String(obj['product']      || ''),
    category:         String(obj['category']     || ''),
    size:             String(obj['size']         || ''),
    qty:              Number(obj['qty'])          || 1,
    unit_price:       Number(obj['unit_price'])   || 0,
    discount:         Number(obj['discount'])     || 0,
    add_discount:     Number(obj['add_discount']) || 0,
    adv_cost:         Number(obj['adv_cost'])     || 0,
    adv_platform:     String(obj['adv_platform'] || ''),
    sell_price:       Number(obj['sell_price'])   || 0,
    shipping_fee:     Number(obj['shipping_fee']) || 0,
    cogs:             Number(obj['cogs'])          || 0,
    courier_charge:   Number(obj['courier_charge'])|| 0,
    other_costs:      Number(obj['other_costs'])   || 0,
    profit:           Number(obj['profit'])        || 0,
    margin_pct:       Number(obj['margin_pct'])    || 0,
    courier:          String(obj['courier']        || ''),
    tracking_id:      String(obj['tracking_id']    || ''),
    tracking_status:  String(obj['tracking_status']|| ''),
    est_delivery:     fmt_date_(obj['est_delivery']),
    actual_delivery:  fmt_date_(obj['actual_delivery']),
    return_reason:    String(obj['return_reason']  || ''),
    return_date:      fmt_date_(obj['return_date']),
    return_status:    String(obj['return_status']  || ''),
    notes:            String(obj['notes']          || ''),
    sku:              String(obj['sku']            || ''),
    handled_by:       String(obj['handled_by']     || ''),
    sla_status:       String(obj['sla_status']     || ''),
    days_pending:     Number(obj['days_pending'])  || 0,
    days_in_transit:  Number(obj['days_in_transit'])|| 0,
    auto_flag:        String(obj['auto_flag']      || ''),
    invoice_num:      String(obj['invoice_num']    || ''),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: customers
// ─────────────────────────────────────────────────────────────────────────────

function getCustomers_(p) {
  var sheet = findSheet_(['CUSTOMERS', 'Customers', 'customers']);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { customers: [], total: 0 };

  var numCols  = sheet.getLastColumn();
  var headers  = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var raw      = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  var customers = [];
  for (var r = 0; r < raw.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-]+/g, '_');
      obj[key] = raw[r][c];
    }
    if (!obj['name'] && !obj['customer']) continue;
    var cust = rowToCustomer_(obj);
    if (p.segment    && cust.segment    !== p.segment)    continue;
    if (p.risk_level && cust.risk_level !== p.risk_level) continue;
    if (p.search) {
      var q = String(p.search).toLowerCase();
      if ([cust.name, cust.phone].join(' ').toLowerCase().indexOf(q) === -1) continue;
    }
    customers.push(cust);
  }
  return { customers: customers, total: customers.length };
}

function getCustomer_(name) {
  if (!name) throw new Error('Missing name');
  var result = getCustomers_({ search: name });
  var match  = result.customers.filter(function (c) { return c.name === name; })[0] || result.customers[0];
  if (!match) throw new Error('Customer not found: ' + name);
  return { customer: match, orders: [] };
}

function rowToCustomer_(obj) {
  return {
    id:            String(obj['id']            || obj['name']   || ''),
    name:          String(obj['name']          || obj['customer'] || ''),
    phone:         String(obj['phone']         || ''),
    district:      String(obj['district']      || ''),
    address:       String(obj['address']       || ''),
    whatsapp:      String(obj['whatsapp']      || obj['phone'] || ''),
    total_orders:  Number(obj['total_orders'])  || 0,
    delivered:     Number(obj['delivered'])     || 0,
    returned:      Number(obj['returned'])      || 0,
    cancelled:     Number(obj['cancelled'])     || 0,
    pending:       Number(obj['pending'])       || 0,
    total_spent:   Number(obj['total_spent'])   || 0,
    avg_order:     Number(obj['avg_order'])     || 0,
    total_profit:  Number(obj['total_profit'])  || 0,
    cod_orders:    Number(obj['cod_orders'])    || 0,
    cod_fails:     Number(obj['cod_fails'])     || 0,
    cod_fail_pct:  Number(obj['cod_fail_pct'])  || 0,
    return_rate:   Number(obj['return_rate'])   || 0,
    last_order:    fmt_date_(obj['last_order']),
    days_inactive: Number(obj['days_inactive']) || 0,
    fav_category:  String(obj['fav_category']  || ''),
    clv_score:     Number(obj['clv_score'])     || 0,
    risk_score:    Number(obj['risk_score'])    || 0,
    risk_level:    String(obj['risk_level']     || 'LOW'),
    segment:       String(obj['segment']        || 'NEW'),
    loyalty_pts:   Number(obj['loyalty_pts'])   || 0,
    source:        String(obj['source']         || ''),
    wa_optin:      String(obj['wa_optin']       || ''),
    notes:         String(obj['notes']          || ''),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: dashboard / analytics
// ─────────────────────────────────────────────────────────────────────────────

function getDashboard_() {
  var result   = getOrders_({});
  var orders   = result.orders;
  var now      = new Date();

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
  var sla_breaches = [], totalCogs = 0;

  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    byStatus[o.status]  = (byStatus[o.status]  || 0) + 1;
    byPayment[o.payment]= (byPayment[o.payment] || 0) + 1;

    if (!bySource[o.source])   bySource[o.source]   = { orders: 0, revenue: 0 };
    bySource[o.source].orders++;
    bySource[o.source].revenue += o.sell_price;

    if (!byCat[o.category])    byCat[o.category]    = { orders: 0, revenue: 0, profit: 0 };
    byCat[o.category].orders++;
    byCat[o.category].revenue += o.sell_price;
    byCat[o.category].profit  += o.profit;

    totalCogs += o.cogs;

    if (o.status === 'Delivered') kpis.delivered_count++;
    if (['Returned', 'Cancelled'].indexOf(o.status) === -1 && o.days_pending > 3) {
      sla_breaches.push({ id: o.id, customer: o.customer, sla_status: 'Overdue', days_pending: o.days_pending, days_in_transit: o.days_in_transit });
      kpis.sla_breaches++;
    }
    if (['Pending', 'Confirmed'].indexOf(o.status) !== -1) kpis.pending_action++;
  }

  kpis.total_cogs   = Math.round(totalCogs);
  kpis.delivery_rate = orders.length > 0 ? Math.round((kpis.delivered_count / orders.length) * 100) : 0;
  kpis.return_rate   = orders.length > 0 ? Math.round(((byStatus['Returned'] || 0) / orders.length) * 100) : 0;
  kpis.gross_margin  = kpis.total_revenue > 0 ? Math.round((kpis.total_profit / kpis.total_revenue) * 100) : 0;

  return {
    kpis:          kpis,
    by_status:     byStatus,
    by_source:     bySource,
    by_payment:    byPayment,
    by_category:   byCat,
    sla_breaches:  sla_breaches.slice(0, 20),
    recent_orders: orders.slice(0, 10),
    generated_at:  Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: finance
// ─────────────────────────────────────────────────────────────────────────────

function getFinance_() {
  var expSheet = null;
  try { expSheet = findSheet_(['EXPENSES', 'Expenses', 'EXPENSE_LEDGER', 'Expense Ledger']); } catch(e) {}

  var expenses = [];
  var totalExpense = 0;
  var expByCat = {};

  if (expSheet) {
    var lastRow = expSheet.getLastRow();
    if (lastRow > 1) {
      var raw = expSheet.getRange(2, 1, lastRow - 1, 4).getValues();
      for (var i = 0; i < raw.length; i++) {
        var date = fmt_date_(raw[i][0]), cat = String(raw[i][1]), amt = Number(raw[i][2]), notes = String(raw[i][3] || '');
        if (!cat) continue;
        expenses.push({ date: date, category: cat, amount: amt, notes: notes });
        totalExpense += amt;
        expByCat[cat] = (expByCat[cat] || 0) + amt;
      }
    }
  }

  var orderData  = getOrders_({});
  var totalIncome = orderData.summary.total_revenue;

  return {
    cash_balance:    Math.round(totalIncome - totalExpense),
    total_income:    Math.round(totalIncome),
    total_expense:   Math.round(totalExpense),
    net_profit:      Math.round(orderData.summary.total_profit - totalExpense),
    expense_by_cat:  expByCat,
    recent_expenses: expenses.slice(-20).reverse(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: stock
// ─────────────────────────────────────────────────────────────────────────────

function getStock_() {
  var sheet = findSheet_(['STOCK', 'Stock', 'INVENTORY', 'Inventory']);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { items: [], summary: { total_skus: 0, low_stock: 0, out_of_stock: 0, total_value: 0 } };

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var raw     = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  var items = [], lowStock = 0, outOfStock = 0, totalValue = 0;
  for (var r = 0; r < raw.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = String(headers[c]).trim().toLowerCase().replace(/[\s\/\-]+/g, '_');
      obj[key] = raw[r][c];
    }
    if (!obj['sku'] && !obj['product']) continue;
    var avail = Number(obj['available'] || obj['current_stock'] || 0);
    var reorder = Number(obj['reorder_level'] || 5);
    if (avail === 0)         outOfStock++;
    else if (avail < reorder) lowStock++;
    var unitVal = Number(obj['cogs'] || obj['unit_cost'] || 0);
    totalValue += avail * unitVal;

    items.push({
      sku:             String(obj['sku']            || ''),
      product:         String(obj['product']        || ''),
      category:        String(obj['category']       || ''),
      color:           String(obj['color']          || ''),
      size:            String(obj['size']           || ''),
      opening:         Number(obj['opening'])        || 0,
      purchased:       Number(obj['purchased'])      || 0,
      sold:            Number(obj['sold'])           || 0,
      returned:        Number(obj['returned'])       || 0,
      damaged:         Number(obj['damaged'])        || 0,
      reserved:        Number(obj['reserved'])       || 0,
      current_stock:   Number(obj['current_stock'])  || avail,
      available:       avail,
      reorder_level:   reorder,
      status:          avail === 0 ? 'Out of Stock' : avail < reorder ? 'Low Stock' : 'In Stock',
      stock_value:     0,
      sell_value:      0,
      potential_profit:0,
    });
  }

  return {
    items:   items,
    summary: { total_skus: items.length, low_stock: lowStock, out_of_stock: outOfStock, total_value: Math.round(totalValue) }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: log
// ─────────────────────────────────────────────────────────────────────────────

function getLog_(p) {
  var limit = Math.min(Number(p.limit || 100), 500);
  var sheet;
  try { sheet = findSheet_(['LOG', 'AUTOMATION_LOG']); } catch(e) { return { events: [], total: 0 }; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { events: [], total: 0 };

  var fetchRows = Math.min(limit, lastRow - 1);
  var startRow  = Math.max(2, lastRow - fetchRows + 1);
  var raw = sheet.getRange(startRow, 1, fetchRows, 5).getValues();

  var events = raw.map(function (r) {
    return { timestamp: fmt_date_(r[0]), type: String(r[1] || ''), reference: String(r[2] || ''), message: String(r[3] || ''), detail: String(r[4] || '') };
  }).reverse();

  return { events: events, total: lastRow - 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: next_invoice_number
// ─────────────────────────────────────────────────────────────────────────────

function getNextInvoiceNumber_() {
  var sheet  = findSheet_(['ORDERS', 'Orders']);
  var lastRow = sheet.getLastRow();
  return { invoice_number: 'INV-' + String(lastRow).padStart(4, '0') };
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function findOrderRow_(sheet, colMap, orderId) {
  var col = colMap['ORDER_ID'];
  if (!col) throw new Error('ORDER_ID column not found in sheet');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Order not found: ' + orderId);
  var ids = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(orderId).trim()) return i + 2; // +2: 1-based + skip header
  }
  throw new Error('Order not found: ' + orderId);
}

function fmt_date_(val) {
  if (!val) return '';
  if (val instanceof Date) return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(val);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST — run manually in Apps Script editor to verify Sheets access
// ─────────────────────────────────────────────────────────────────────────────

function testCreateOrder() {
  var result = createOrder_({
    customer:    'Test Debug Customer',
    phone:       '01711999888',
    address:     'Test Address, Dhaka',
    product:     'Debug Item',
    category:    'Tops',
    qty:         1,
    unit_price:  500,
    sell_price:  500,
    cogs:        300,
    courier_charge: 80,
    shipping_fee: 0,
    payment:     'COD',
    source:      'Facebook',
    status:      'Pending',
    courier:     'Pathao',
    notes:       'AUTO TEST — DELETE ME',
  });
  Logger.log('testCreateOrder result: ' + JSON.stringify(result));
}

function testGetOrders() {
  var result = getOrders_({});
  Logger.log('Total orders: ' + result.orders.length);
  Logger.log('First order: ' + JSON.stringify(result.orders[0]));
}
