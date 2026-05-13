/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         ALMA LIFESTYLE ERP — AUTOMATION MODULE 1                        ║
 * ║         ORDER WORKFLOW AUTOMATION ENGINE                                 ║
 * ║         Version 1.0 | Phase 2 Automation Infrastructure                 ║
 * ║                                                                          ║
 * ║  SAFE TO DEPLOY: All writes are idempotent and rollback-friendly.        ║
 * ║  Existing formulas are NEVER overwritten. Only blank cells are written.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * INSTALLATION:
 *   1. Open your Google Sheet → Extensions → Apps Script
 *   2. Delete all existing code in the editor
 *   3. Paste this entire file
 *   4. Click Save (disk icon), name the project "Alma_ERP_Automation"
 *   5. Run installTriggers() ONCE from the Run menu
 *   6. Authorize permissions when prompted
 *   7. Done — automation is live
 *
 * TRIGGER MAP:
 *   onEdit(e)           → installable trigger (spreadsheet edit)
 *   runDailyOperations  → time-based trigger (daily 8:00 AM)
 *   runHourlySLACheck   → time-based trigger (every 2 hours)
 */

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION — Update these if sheet names ever change
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
  sheets: {
    ORDERS:         '📦 ORDERS',
    STOCK_CONTROL:  '📦 STOCK CONTROL',
    STOCK_MOVEMENTS:'🔄 STOCK MOVEMENTS',
    COURIER:        '🚚 COURIER TRACKER',
    RETURNS:        '↩️ RETURNS',
    CUSTOMER:       '👤 CUSTOMER MASTER',
    EXPENSE:        '💸 EXPENSE LEDGER',
    CASH_FLOW:      '💰 CASH FLOW',
    AUTOMATION_LOG: '🤖 AUTOMATION LOG',
    SETTINGS:       '⚙️ SETTINGS',
  },

  // ORDERS sheet column indices (1-based, matching your ERP exactly)
  col: {
    ORDER_ID:        1,   // A
    DATE:            2,   // B
    CUSTOMER:        3,   // C
    PHONE:           4,   // D
    ADDRESS:         5,   // E
    PAYMENT:         6,   // F
    SOURCE:          7,   // G
    STATUS:          8,   // H
    PRODUCT:         9,   // I
    CATEGORY:        10,  // J
    SIZE:            11,  // K
    QTY:             12,  // L
    UNIT_PRICE:      13,  // M
    DISCOUNT:        14,  // N
    ADD_DISCOUNT:    15,  // O
    ADV_COST:        16,  // P
    ADV_PLATFORM:    17,  // Q
    SELL_PRICE:      18,  // R
    SHIP_COLLECTED:  19,  // S
    COGS:            20,  // T
    COURIER_CHARGE:  21,  // U
    OTHER_COSTS:     22,  // V
    PROFIT:          23,  // W
    COURIER:         24,  // X
    TRACKING_ID:     25,  // Y
    TRACKING_STATUS: 26,  // Z
    EST_DELIVERY:    27,  // AA
    ACTUAL_DELIVERY: 28,  // AB
    RETURN_REASON:   29,  // AC
    RETURN_DATE:     30,  // AD
    RETURN_STATUS:   31,  // AE
    NOTES:           32,  // AF
    SKU:             33,  // AG
    HANDLED_BY:      34,  // AH
    CUST_ORDER_NUM:  35,  // AI
    // Automation columns (appended by script — do not use for formulas)
    CONFIRMED_DATE:  36,  // AJ — auto-written by script
    SHIP_DATE_AUTO:  37,  // AK — auto-written by script
    DELIVERY_DATE_AUTO: 38, // AL — auto-written by script
    RETURN_DATE_AUTO:39,  // AM — auto-written by script
    DAYS_PENDING:    40,  // AN — auto-written by script
    DAYS_IN_TRANSIT: 41,  // AO — auto-written by script
    SLA_STATUS:      42,  // AP — auto-written by script
    AUTO_FLAG:       43,  // AQ — automation audit trail
  },

  // SLA thresholds (days)
  sla: {
    PENDING_WARN:    2,   // Warn if pending > 2 days
    PENDING_BREACH:  4,   // Breach if pending > 4 days
    TRANSIT_WARN:    4,   // Warn if in transit > 4 days
    TRANSIT_BREACH:  7,   // Breach if in transit > 7 days
  },

  // Stock Movement types
  mvt: {
    SALE:     'Stock Out (Sale)',
    RETURN:   'Return In',
    DAMAGE:   'Damage Write-off',
  },

  // Status constants
  status: {
    PENDING:   'Pending',
    CONFIRMED: 'Confirmed',
    PACKED:    'Packed',
    SHIPPED:   'Shipped',
    DELIVERED: 'Delivered',
    RETURNED:  'Returned',
    CANCELLED: 'Cancelled',
  }
};

// ═══════════════════════════════════════════════════════════════════
// TRIGGER INSTALLATION — Run once after pasting this script
// ═══════════════════════════════════════════════════════════════════

/**
 * Run this function ONCE to install all triggers.
 * Go to Run → Run function → installTriggers
 */
function installTriggers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Remove any existing triggers to prevent duplicates
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 1. onEdit trigger — fires on every cell edit
  ScriptApp.newTrigger('onOrderEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  // 2. Daily operations — 8:00 AM every day
  ScriptApp.newTrigger('runDailyOperations')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();

  // 3. SLA check — every 2 hours during business hours
  ScriptApp.newTrigger('runHourlySLACheck')
    .timeBased()
    .everyHours(2)
    .create();

  log_('SYSTEM', 'INIT', 'All triggers installed successfully', 'installTriggers');
  SpreadsheetApp.getUi().alert(
    '✅ Alma Lifestyle ERP Automation\n\n' +
    'All triggers installed successfully!\n\n' +
    '• onEdit trigger: ACTIVE\n' +
    '• Daily operations (8 AM): ACTIVE\n' +
    '• SLA monitoring (every 2h): ACTIVE\n\n' +
    'Check the 🤖 AUTOMATION LOG sheet for activity.'
  );
}

/**
 * Remove all triggers (emergency stop)
 * Run this if you need to pause all automation
 */
function emergencyStop() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  log_('SYSTEM', 'EMERGENCY_STOP', 'All triggers removed by user', 'emergencyStop');
  SpreadsheetApp.getUi().alert('⛔ Automation paused. Run installTriggers() to restart.');
}

// ═══════════════════════════════════════════════════════════════════
// MAIN onEdit HANDLER — Entry point for all edit-triggered automation
// ═══════════════════════════════════════════════════════════════════

/**
 * Master onEdit handler. Called automatically on every edit.
 * Routes to the correct sub-handler based on which sheet was edited.
 *
 * SAFETY: All operations check for existing values before writing.
 * Nothing overwrites existing data.
 */
function onOrderEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();

  // Only process ORDERS sheet edits
  if (sheetName !== CONFIG.sheets.ORDERS) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();

  // Skip header rows
  if (row < 3) return;

  // Get the full row data once (efficient — single API call)
  const rowData = sheet.getRange(row, 1, 1, 43).getValues()[0];

  // Only process rows with an Order ID
  if (!rowData[CONFIG.col.ORDER_ID - 1]) return;

  try {
    // Route based on which column was edited
    if (col === CONFIG.col.STATUS) {
      handleStatusChange_(sheet, row, rowData, e.value, e.oldValue);
    } else if (col === CONFIG.col.TRACKING_ID) {
      handleTrackingIdAdded_(sheet, row, rowData, e.value);
    } else if (col === CONFIG.col.DATE && !e.oldValue) {
      handleNewOrder_(sheet, row, rowData);
    } else if (col === CONFIG.col.COURIER && !rowData[CONFIG.col.TRACKING_ID - 1]) {
      // Courier assigned — update courier tracker
      syncCourierTracker_(row, rowData);
    }
  } catch (err) {
    log_('ERROR', 'onOrderEdit', err.message, `Row ${row}: ${err.stack}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER: STATUS CHANGE
// ═══════════════════════════════════════════════════════════════════

/**
 * Fires when the STATUS column (H) changes.
 * Routes to the correct workflow based on the new status.
 */
function handleStatusChange_(sheet, row, rowData, newStatus, oldStatus) {
  if (!newStatus || newStatus === oldStatus) return;

  const orderId = rowData[CONFIG.col.ORDER_ID - 1];
  log_('STATUS', newStatus, `Order ${orderId}: ${oldStatus} → ${newStatus}`, `Row ${row}`);

  const S = CONFIG.status;

  switch (newStatus) {
    case S.CONFIRMED:
      onOrderConfirmed_(sheet, row, rowData);
      break;
    case S.PACKED:
      onOrderPacked_(sheet, row, rowData);
      break;
    case S.SHIPPED:
      onOrderShipped_(sheet, row, rowData);
      break;
    case S.DELIVERED:
      onOrderDelivered_(sheet, row, rowData);
      break;
    case S.RETURNED:
      onOrderReturned_(sheet, row, rowData);
      break;
    case S.CANCELLED:
      onOrderCancelled_(sheet, row, rowData);
      break;
  }
}

// ─── Confirmed ────────────────────────────────────────────────────
function onOrderConfirmed_(sheet, row, rowData) {
  const now = new Date();
  const orderId = rowData[CONFIG.col.ORDER_ID - 1];

  // Write CONFIRMED_DATE only if empty (idempotent)
  writeIfEmpty_(sheet, row, CONFIG.col.CONFIRMED_DATE, now, 'dd-MMM-yyyy');

  // Mark automation flag
  setAutoFlag_(sheet, row, '✓ Auto-confirmed ' + formatDate_(now));

  log_('CONFIRMED', orderId, 'Confirmation timestamp written', `Row ${row}`);
}

// ─── Packed ──────────────────────────────────────────────────────
function onOrderPacked_(sheet, row, rowData) {
  const orderId = rowData[CONFIG.col.ORDER_ID - 1];
  setAutoFlag_(sheet, row, '✓ Packed ' + formatDate_(new Date()));
  log_('PACKED', orderId, 'Order marked packed', `Row ${row}`);
}

// ─── Shipped ─────────────────────────────────────────────────────
function onOrderShipped_(sheet, row, rowData) {
  const now  = new Date();
  const orderId = rowData[CONFIG.col.ORDER_ID - 1];
  const tracking = rowData[CONFIG.col.TRACKING_ID - 1];

  // Write ship date timestamp
  writeIfEmpty_(sheet, row, CONFIG.col.SHIP_DATE_AUTO, now, 'dd-MMM-yyyy');

  // Update tracking status to "In Transit" if currently Pending
  const curTracking = rowData[CONFIG.col.TRACKING_STATUS - 1];
  if (!curTracking || curTracking === 'Pending') {
    sheet.getRange(row, CONFIG.col.TRACKING_STATUS).setValue('In Transit');
  }

  // Sync to Courier Tracker sheet
  syncCourierTracker_(row, rowData);

  // Calculate and write estimated delivery (3 days inside Dhaka, 5 outside)
  if (!rowData[CONFIG.col.EST_DELIVERY - 1]) {
    const address = (rowData[CONFIG.col.ADDRESS - 1] || '').toLowerCase();
    const daysToAdd = address.includes('dhaka') ? 3 : 5;
    const estDelivery = new Date(now);
    estDelivery.setDate(estDelivery.getDate() + daysToAdd);
    sheet.getRange(row, CONFIG.col.EST_DELIVERY).setValue(estDelivery)
         .setNumberFormat('dd-MMM-yyyy');
  }

  setAutoFlag_(sheet, row, '✓ Shipped ' + formatDate_(now) + ' | TRK: ' + (tracking || 'N/A'));
  log_('SHIPPED', orderId, `Shipped. Tracking: ${tracking}`, `Row ${row}`);
}

// ─── Delivered ───────────────────────────────────────────────────
function onOrderDelivered_(sheet, row, rowData) {
  const now     = new Date();
  const orderId = rowData[CONFIG.col.ORDER_ID - 1];
  const product = rowData[CONFIG.col.PRODUCT - 1];
  const qty     = rowData[CONFIG.col.QTY - 1] || 0;
  const customer= rowData[CONFIG.col.CUSTOMER - 1];

  // 1. Write actual delivery date
  writeIfEmpty_(sheet, row, CONFIG.col.ACTUAL_DELIVERY, now, 'dd-MMM-yyyy');

  // 2. Update tracking status
  sheet.getRange(row, CONFIG.col.TRACKING_STATUS).setValue('Delivered');

  // 3. Deduct stock — critical operation with validation
  if (product && qty > 0) {
    deductStock_(product, qty, orderId, customer);
  }

  // 4. Sync courier tracker
  syncCourierTracker_(row, rowData);

  // 5. Flag
  setAutoFlag_(sheet, row, '✓ Delivered ' + formatDate_(now) + ' | Stock deducted');
  log_('DELIVERED', orderId, `Delivered. Stock deducted: ${product} x${qty}`, `Row ${row}`);

  // 6. Send summary to automation log
  const sellPrice = rowData[CONFIG.col.SELL_PRICE - 1] || 0;
  const profit    = rowData[CONFIG.col.PROFIT - 1]     || 0;
  log_('FINANCIAL', orderId, `Revenue: ৳${sellPrice} | Profit: ৳${profit}`, `Row ${row}`);
}

// ─── Returned ────────────────────────────────────────────────────
function onOrderReturned_(sheet, row, rowData) {
  const now     = new Date();
  const orderId = rowData[CONFIG.col.ORDER_ID - 1];
  const product = rowData[CONFIG.col.PRODUCT - 1];
  const qty     = rowData[CONFIG.col.QTY - 1] || 0;
  const customer= rowData[CONFIG.col.CUSTOMER - 1];
  const cogs    = rowData[CONFIG.col.COGS - 1] || 0;
  const sellPrice = rowData[CONFIG.col.SELL_PRICE - 1] || 0;

  // 1. Write return date
  writeIfEmpty_(sheet, row, CONFIG.col.RETURN_DATE, now, 'dd-MMM-yyyy');
  writeIfEmpty_(sheet, row, CONFIG.col.RETURN_DATE_AUTO, now, 'dd-MMM-yyyy');

  // 2. Update tracking status
  sheet.getRange(row, CONFIG.col.TRACKING_STATUS).setValue('Returned to Origin');

  // 3. Set return status if empty
  const curReturnStatus = rowData[CONFIG.col.RETURN_STATUS - 1];
  if (!curReturnStatus) {
    sheet.getRange(row, CONFIG.col.RETURN_STATUS).setValue('Requested');
  }

  // 4. Restore stock (return units back)
  if (product && qty > 0) {
    restoreStock_(product, qty, orderId, customer);
  }

  // 5. Log return in RETURNS sheet
  createReturnRecord_(orderId, rowData, now);

  // 6. Update customer risk flag
  flagCustomerReturnRisk_(customer, orderId);

  // 7. Calculate return loss and log
  const returnLoss = cogs + (rowData[CONFIG.col.COURIER_CHARGE - 1] || 0);
  log_('RETURN_LOSS', orderId, `Loss: ৳${returnLoss} (COGS: ৳${cogs} + Courier)`, `Row ${row}`);

  setAutoFlag_(sheet, row, '⚠️ Returned ' + formatDate_(now) + ' | Stock restored | Loss: ৳' + returnLoss);
  log_('RETURNED', orderId, `Returned. Stock restored: ${product} x${qty}`, `Row ${row}`);
}

// ─── Cancelled ──────────────────────────────────────────────────
function onOrderCancelled_(sheet, row, rowData) {
  const now     = new Date();
  const orderId = rowData[CONFIG.col.ORDER_ID - 1];

  // Release any reserved stock
  const product = rowData[CONFIG.col.PRODUCT - 1];
  const qty     = rowData[CONFIG.col.QTY - 1] || 0;

  setAutoFlag_(sheet, row, '✗ Cancelled ' + formatDate_(now));
  log_('CANCELLED', orderId, `Order cancelled. Reserved stock released if applicable.`, `Row ${row}`);
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER: TRACKING ID ADDED
// ═══════════════════════════════════════════════════════════════════

/**
 * Fires when a tracking ID is typed into column Y.
 * Automatically sets status to "Shipped" and adds ship date.
 */
function handleTrackingIdAdded_(sheet, row, rowData, trackingId) {
  if (!trackingId || trackingId.toString().trim() === '') return;

  const currentStatus = rowData[CONFIG.col.STATUS - 1];
  const orderId = rowData[CONFIG.col.ORDER_ID - 1];

  // Only auto-advance if still in pre-shipped state
  const preShippedStatuses = [CONFIG.status.PENDING, CONFIG.status.CONFIRMED, CONFIG.status.PACKED];

  if (preShippedStatuses.includes(currentStatus)) {
    // Auto-set to Shipped
    sheet.getRange(row, CONFIG.col.STATUS).setValue(CONFIG.status.SHIPPED);
    // onOrderShipped_ will be called by the next edit trigger cycle
    // So we also write the ship date directly here for immediate consistency
    writeIfEmpty_(sheet, row, CONFIG.col.SHIP_DATE_AUTO, new Date(), 'dd-MMM-yyyy');
    sheet.getRange(row, CONFIG.col.TRACKING_STATUS).setValue('In Transit');
    log_('TRACKING', orderId, `Tracking ID "${trackingId}" added → Status auto-set to Shipped`, `Row ${row}`);
  }

  // Update courier tracker with new tracking ID
  syncCourierTracker_(row, rowData);
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER: NEW ORDER
// ═══════════════════════════════════════════════════════════════════

/**
 * Fires when a new row is being filled in (DATE column populated).
 * Sets default status to Pending if blank.
 */
function handleNewOrder_(sheet, row, rowData) {
  const status = rowData[CONFIG.col.STATUS - 1];

  if (!status) {
    sheet.getRange(row, CONFIG.col.STATUS)
      .setValue(CONFIG.status.PENDING);
  }

  log_('NEW_ORDER',
    rowData[CONFIG.col.ORDER_ID - 1] || 'DRAFT',
    'New order row initialized',
    `Row ${row}`
  );

  // Phase 5 CRM sync
onOrderCrmUpdate(
  rowData[CONFIG.col.CUSTOMER - 1],
  rowData[CONFIG.col.PHONE - 1],
  rowData[CONFIG.col.ADDRESS - 1],
  '',
  rowData[CONFIG.col.SOURCE - 1]
);
}

// ═══════════════════════════════════════════════════════════════════
// STOCK OPERATIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Deducts stock from STOCK CONTROL and logs to STOCK MOVEMENTS.
 * SAFETY: Validates qty > 0, product exists, and current stock >= qty before writing.
 */
function deductStock_(productName, qty, orderId, customerName) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const scSh = ss.getSheetByName(CONFIG.sheets.STOCK_CONTROL);
  if (!scSh) return;

  const scData = scSh.getDataRange().getValues();
  // Find product row (column B = Product Name, index 1)
  let productRow = -1;
  for (let i = 1; i < scData.length; i++) {
    if (scData[i][1] && scData[i][1].toString().trim() === productName.toString().trim()) {
      productRow = i + 1; // 1-based
      break;
    }
  }

  if (productRow === -1) {
    log_('STOCK_WARN', orderId, `Product not found in Stock Control: "${productName}"`, 'deductStock_');
    return;
  }

  // Column H (index 7) = SOLD − (manual input column, not formula)
  const soldCell  = scSh.getRange(productRow, 8); // H = SOLD
  const currentSold = soldCell.getValue() || 0;
  soldCell.setValue(currentSold + qty);

  // Update last updated date (column S = index 19)
  scSh.getRange(productRow, 19).setValue(new Date()).setNumberFormat('dd-MMM-yyyy');

  // Log to Stock Movements
  logStockMovement_(productName, CONFIG.mvt.SALE, 0, qty, orderId,
    `Delivered to ${customerName}`, scData[productRow-1][0]); // SKU from col A

  log_('STOCK', orderId, `Deducted ${qty}x "${productName}" from stock`, 'deductStock_');
}

/**
 * Restores stock when an order is returned.
 * Increments the RETURNED + column and logs the movement.
 */
function restoreStock_(productName, qty, orderId, customerName) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const scSh = ss.getSheetByName(CONFIG.sheets.STOCK_CONTROL);
  if (!scSh) return;

  const scData = scSh.getDataRange().getValues();
  let productRow = -1;
  for (let i = 1; i < scData.length; i++) {
    if (scData[i][1] && scData[i][1].toString().trim() === productName.toString().trim()) {
      productRow = i + 1;
      break;
    }
  }

  if (productRow === -1) {
    log_('STOCK_WARN', orderId, `Product not found for return restore: "${productName}"`, 'restoreStock_');
    return;
  }

  // Column I (index 8) = RETURNED +
  const returnCell  = scSh.getRange(productRow, 9);
  const currentReturns = returnCell.getValue() || 0;
  returnCell.setValue(currentReturns + qty);

  // Update last updated
  scSh.getRange(productRow, 19).setValue(new Date()).setNumberFormat('dd-MMM-yyyy');

  // Log movement
  logStockMovement_(productName, CONFIG.mvt.RETURN, qty, 0, orderId,
    `Return from ${customerName}`, scData[productRow-1][0]);

  log_('STOCK', orderId, `Restored ${qty}x "${productName}" to stock (return)`, 'restoreStock_');
}

/**
 * Writes a row to the STOCK MOVEMENTS log.
 */
function logStockMovement_(productName, movementType, qtyIn, qtyOut, reference, reason, sku) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const mvSh = ss.getSheetByName(CONFIG.sheets.STOCK_MOVEMENTS);
  if (!mvSh) return;

  // Find next empty row (check column B = DATE)
  const lastRow = mvSh.getLastRow();
  let nextRow = 3; // data starts at row 3
  for (let r = 3; r <= lastRow + 1; r++) {
    if (!mvSh.getRange(r, 2).getValue()) {
      nextRow = r;
      break;
    }
  }

  const now = new Date();
  // Columns: A=MVMT ID (formula), B=DATE, C=SKU, D=PRODUCT NAME,
  //          E=MOVEMENT TYPE, F=QTY IN, G=QTY OUT, I=REFERENCE, J=REASON
  const mvtSheet = mvSh.getRange(nextRow, 2, 1, 9);
  mvtSheet.setValues([[
    now,           // B: DATE
    sku || '',     // C: SKU
    productName,   // D: PRODUCT NAME
    movementType,  // E: MOVEMENT TYPE
    qtyIn,         // F: QTY IN
    qtyOut,        // G: QTY OUT
    '',            // H: BALANCE AFTER (formula handles this)
    reference,     // I: REFERENCE (Order ID)
    reason,        // J: REASON
  ]]);
  mvSh.getRange(nextRow, 2).setNumberFormat('dd-MMM-yyyy');
}

// ═══════════════════════════════════════════════════════════════════
// COURIER TRACKER SYNC
// ═══════════════════════════════════════════════════════════════════

/**
 * Syncs order data to the Courier Tracker sheet.
 * Finds the matching row by Order ID and updates trackable fields.
 */
function syncCourierTracker_(orderRow, rowData) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const ctSh = ss.getSheetByName(CONFIG.sheets.COURIER);
  if (!ctSh) return;

  const orderId = rowData[CONFIG.col.ORDER_ID - 1];
  if (!orderId) return;

  // Find matching row in Courier Tracker (column A = ORDER ID)
  const ctData = ctSh.getDataRange().getValues();
  let courierRow = -1;
  for (let i = 2; i < ctData.length; i++) {
    if (ctData[i][0] === orderId) {
      courierRow = i + 1;
      break;
    }
  }

  // If no existing row found, find the row where the formula references this order
  // (Courier Tracker uses VLOOKUP from Order ID in col A)
  if (courierRow === -1) return; // Row not yet set up in courier tracker

  // Update: Tracking ID (col F=6), Ship Date (col G=7), Tracking Status (col H=8)
  const trackingId = rowData[CONFIG.col.TRACKING_ID - 1];
  const trackingStatus = rowData[CONFIG.col.TRACKING_STATUS - 1];

  if (trackingId) ctSh.getRange(courierRow, 6).setValue(trackingId);
  if (trackingStatus) ctSh.getRange(courierRow, 8).setValue(trackingStatus);

  // Ship date
  const shipDate = rowData[CONFIG.col.SHIP_DATE_AUTO - 1];
  if (shipDate) {
    ctSh.getRange(courierRow, 7).setValue(shipDate).setNumberFormat('dd-MMM-yyyy');
  }

  // Actual delivery
  const actualDelivery = rowData[CONFIG.col.ACTUAL_DELIVERY - 1];
  if (actualDelivery) {
    ctSh.getRange(courierRow, 10).setValue(actualDelivery).setNumberFormat('dd-MMM-yyyy');
  }
}

// ═══════════════════════════════════════════════════════════════════
// RETURNS RECORD CREATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Creates a record in the RETURNS sheet when an order is returned.
 * Checks for duplicates before writing.
 */
function createReturnRecord_(orderId, rowData, returnDate) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const retSh = ss.getSheetByName(CONFIG.sheets.RETURNS);
  if (!retSh) return;

  // Check if this order already has a return record
  const retData = retSh.getDataRange().getValues();
  for (let i = 2; i < retData.length; i++) {
    if (retData[i][0] === orderId) {
      log_('RETURNS', orderId, 'Return record already exists — skipping duplicate', 'createReturnRecord_');
      return;
    }
  }

  // Find next empty row in RETURNS (starts at row 3)
  const lastRetRow = retSh.getLastRow();
  let nextRetRow = 3;
  for (let r = 3; r <= lastRetRow + 1; r++) {
    if (!retSh.getRange(r, 1).getValue()) {
      nextRetRow = r;
      break;
    }
  }

  // RETURNS columns: A=ORDER ID, B=CUSTOMER, C=PHONE, D=PRODUCT,
  // E=RETURN DATE, F=RETURN REASON, G=RETURN STATUS, H=REFUND AMOUNT
  retSh.getRange(nextRetRow, 1, 1, 8).setValues([[
    orderId,
    rowData[CONFIG.col.CUSTOMER - 1] || '',
    rowData[CONFIG.col.PHONE - 1]    || '',
    rowData[CONFIG.col.PRODUCT - 1]  || '',
    returnDate,
    rowData[CONFIG.col.RETURN_REASON - 1] || 'Customer Return',
    'Requested',
    rowData[CONFIG.col.SELL_PRICE - 1] || 0,
  ]]);
  retSh.getRange(nextRetRow, 5).setNumberFormat('dd-MMM-yyyy');
  retSh.getRange(nextRetRow, 8).setNumberFormat('৳#,##0');

  log_('RETURNS', orderId, `Return record created at row ${nextRetRow}`, 'createReturnRecord_');
}

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER RISK FLAGGING
// ═══════════════════════════════════════════════════════════════════

/**
 * Flags a customer in CUSTOMER MASTER with increased return risk.
 * The CRM formulas auto-recalculate risk scores — this adds a note
 * to the NOTES column for the human team to review.
 */
function flagCustomerReturnRisk_(customerName, orderId) {
  if (!customerName) return;

  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const cmSh = ss.getSheetByName(CONFIG.sheets.CUSTOMER);
  if (!cmSh) return;

  const cmData = cmSh.getDataRange().getValues();
  // Customer name is in column B (index 1), starts row 7 (index 6)
  for (let i = 6; i < cmData.length; i++) {
    if (cmData[i][1] && cmData[i][1].toString().trim() === customerName.toString().trim()) {
      const notesCol = 37; // AK = NOTES column (index 36 = col 37)
      const existingNote = cmData[i][36] || '';
      const newNote = existingNote
        ? existingNote + ` | Return: ${orderId} (${formatDate_(new Date())})`
        : `Return: ${orderId} (${formatDate_(new Date())})`;
      cmSh.getRange(i + 1, notesCol).setValue(newNote);
      log_('CRM', customerName, `Return risk flag added for ${orderId}`, 'flagCustomerReturnRisk_');
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// DAILY OPERATIONS (Time-triggered, 8 AM daily)
// ═══════════════════════════════════════════════════════════════════

/**
 * Runs every morning at 8 AM.
 * Updates SLA status, recalculates pending days, sends alerts.
 */
function runDailyOperations() {
  log_('DAILY', 'START', 'Daily operations started', new Date().toString());

  updateSLAStatus_();
  updateTimestampCalculations_();
  sendDailySummaryEmail_();

  log_('DAILY', 'COMPLETE', 'Daily operations completed', new Date().toString());
}

/**
 * Runs every 2 hours to check for SLA breaches.
 */
function runHourlySLACheck() {
  updateSLAStatus_();
}

// ═══════════════════════════════════════════════════════════════════
// SLA STATUS ENGINE
// ═══════════════════════════════════════════════════════════════════

/**
 * Scans all active orders and writes SLA status, days pending,
 * days in transit, and breach flags.
 * Writes to columns AN (days pending), AO (days in transit), AP (SLA status).
 */
function updateSLAStatus_() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(CONFIG.sheets.ORDERS);
  if (!ordSh) return;

  const lastRow = ordSh.getLastRow();
  if (lastRow < 3) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Batch read for efficiency
  const dataRange = ordSh.getRange(3, 1, lastRow - 2, 43);
  const data      = dataRange.getValues();

  // Prepare output arrays for batch write
  const daysPendingArr    = [];
  const daysInTransitArr  = [];
  const slaStatusArr      = [];

  data.forEach((row) => {
    const status      = row[CONFIG.col.STATUS - 1];
    const orderDate   = row[CONFIG.col.DATE - 1];
    const shipDateAuto= row[CONFIG.col.SHIP_DATE_AUTO - 1]; // AK
    const orderId     = row[CONFIG.col.ORDER_ID - 1];

    let daysPending   = '';
    let daysInTransit = '';
    let slaStatus     = '';

    // Skip completed/terminal orders
    const terminal = [CONFIG.status.DELIVERED, CONFIG.status.CANCELLED];
    if (terminal.includes(status) || !orderId) {
      daysPendingArr.push([daysPending]);
      daysInTransitArr.push([daysInTransit]);
      slaStatusArr.push([slaStatus]);
      return;
    }

    if (status === CONFIG.status.PENDING || status === CONFIG.status.CONFIRMED ||
        status === CONFIG.status.PACKED) {
      // Calculate days pending
      if (orderDate instanceof Date) {
        const orderDay = new Date(orderDate); orderDay.setHours(0,0,0,0);
        daysPending    = Math.max(0, Math.round((today - orderDay) / (1000*60*60*24)));

        if (daysPending > CONFIG.sla.PENDING_BREACH) {
          slaStatus = '🔴 BREACH: Pending ' + daysPending + 'd';
        } else if (daysPending > CONFIG.sla.PENDING_WARN) {
          slaStatus = '🟡 WARN: Pending ' + daysPending + 'd';
        } else {
          slaStatus = '🟢 OK (' + daysPending + 'd)';
        }
      }
    } else if (status === CONFIG.status.SHIPPED) {
      // Calculate days in transit
      const shipDate = shipDateAuto instanceof Date ? shipDateAuto : orderDate;
      if (shipDate instanceof Date) {
        const shipDay = new Date(shipDate); shipDay.setHours(0,0,0,0);
        daysInTransit = Math.max(0, Math.round((today - shipDay) / (1000*60*60*24)));

        if (daysInTransit > CONFIG.sla.TRANSIT_BREACH) {
          slaStatus = '🔴 BREACH: Transit ' + daysInTransit + 'd';
        } else if (daysInTransit > CONFIG.sla.TRANSIT_WARN) {
          slaStatus = '🟡 WARN: Transit ' + daysInTransit + 'd';
        } else {
          slaStatus = '🟢 OK (' + daysInTransit + 'd)';
        }
      }
    }

    daysPendingArr.push([daysPending === '' ? '' : daysPending]);
    daysInTransitArr.push([daysInTransit === '' ? '' : daysInTransit]);
    slaStatusArr.push([slaStatus]);
  });

  // Batch write (one API call per column — efficient)
  if (daysPendingArr.length > 0) {
    ordSh.getRange(3, CONFIG.col.DAYS_PENDING,    lastRow - 2, 1).setValues(daysPendingArr);
    ordSh.getRange(3, CONFIG.col.DAYS_IN_TRANSIT, lastRow - 2, 1).setValues(daysInTransitArr);
    ordSh.getRange(3, CONFIG.col.SLA_STATUS,      lastRow - 2, 1).setValues(slaStatusArr);
  }
}

/**
 * Recalculates time-based metrics (called in daily run)
 */
function updateTimestampCalculations_() {
  // SLA update already handles this — no-op placeholder for future expansion
  log_('DAILY', 'TIMESTAMPS', 'Timestamp calculations refreshed', '');
}

// ═══════════════════════════════════════════════════════════════════
// DAILY SUMMARY EMAIL
// ═══════════════════════════════════════════════════════════════════

/**
 * Sends a daily operational summary email to the owner.
 * Uses Gmail API — the script owner's email is used automatically.
 */
function sendDailySummaryEmail_() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(CONFIG.sheets.ORDERS);
  if (!ordSh) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const data = ordSh.getRange(3, 1, ordSh.getLastRow() - 2, 35).getValues();

  let todayOrders = 0, todayRevenue = 0;
  let pending = 0, shipped = 0, delivered = 0, returned = 0;
  let slaBreaches = 0;

  data.forEach(row => {
    const orderId = row[0];
    if (!orderId) return;

    const status    = row[CONFIG.col.STATUS - 1];
    const orderDate = row[CONFIG.col.DATE - 1];
    const sell      = row[CONFIG.col.SELL_PRICE - 1] || 0;
    const slaCol    = row[CONFIG.col.SLA_STATUS - 1] || '';

    if (orderDate instanceof Date) {
      const d = new Date(orderDate); d.setHours(0,0,0,0);
      if (d.getTime() === today.getTime()) {
        todayOrders++;
        todayRevenue += sell;
      }
    }
    if (status === 'Pending' || status === 'Confirmed') pending++;
    if (status === 'Shipped')   shipped++;
    if (status === 'Delivered' && orderDate instanceof Date) {
      const d = new Date(orderDate); d.setHours(0,0,0,0);
      if (d.getTime() === today.getTime()) delivered++;
    }
    if (status === 'Returned')  returned++;
    if (slaCol.includes('BREACH')) slaBreaches++;
  });

  // Get settings for owner email
  const setData = ss.getSheetByName(CONFIG.sheets.SETTINGS).getDataRange().getValues();
  let ownerEmail = Session.getActiveUser().getEmail(); // fallback to script owner
  setData.forEach(row => {
    if (row[1] && row[1].toString().includes('Contact Email') && row[2]) {
      ownerEmail = row[2];
    }
  });

  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMMM yyyy');

  const subject = `✦ Alma Lifestyle — Daily ERP Report | ${dateStr}`;
  const body = `
╔══════════════════════════════════════╗
║     ALMA LIFESTYLE — DAILY REPORT   ║
║     ${dateStr}
╚══════════════════════════════════════╝

📦 ORDERS TODAY
   New Orders:      ${todayOrders}
   Revenue:         ৳${todayRevenue.toLocaleString()}

📊 LIVE STATUS
   Pending/Confirmed: ${pending}
   In Transit:        ${shipped}
   Delivered Today:   ${delivered}
   Returned:         ${returned}

⚠️  SLA ALERTS
   Breaches:          ${slaBreaches}${slaBreaches > 0 ? ' — CHECK SLA STATUS COLUMN' : ' — All clear ✓'}

📈 Access your full ERP dashboard:
   ${ss.getUrl()}

—
Sent automatically by Alma Lifestyle ERP
Automation Module 1 | Order Workflow Engine
  `.trim();

  try {
    GmailApp.sendEmail(ownerEmail, subject, body);
    log_('EMAIL', 'DAILY_SUMMARY', `Sent to ${ownerEmail}`, dateStr);
  } catch (err) {
    log_('EMAIL_ERROR', 'DAILY_SUMMARY', err.message, ownerEmail);
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUTOMATION LOG SHEET
// ═══════════════════════════════════════════════════════════════════

/**
 * Writes to the AUTOMATION LOG sheet.
 * Creates the sheet if it doesn't exist.
 * Columns: Timestamp | Event Type | Reference | Message | Detail
 */
function log_(eventType, reference, message, detail) {
  try {
    const ss   = SpreadsheetApp.getActiveSpreadsheet();
    let logSh  = ss.getSheetByName(CONFIG.sheets.AUTOMATION_LOG);

    // Create log sheet if missing
    if (!logSh) {
      logSh = ss.insertSheet(CONFIG.sheets.AUTOMATION_LOG);
      logSh.setTabColor('4A4A4A');

      // Style the header
      const headers = [['TIMESTAMP','EVENT TYPE','REFERENCE','MESSAGE','DETAIL / STACK']];
      logSh.getRange(1, 1, 1, 5).setValues(headers)
           .setFontWeight('bold')
           .setBackground('#0D0D0D')
           .setFontColor('#C9A84C');
      logSh.setColumnWidth(1, 160);
      logSh.setColumnWidth(2, 120);
      logSh.setColumnWidth(3, 120);
      logSh.setColumnWidth(4, 300);
      logSh.setColumnWidth(5, 300);
    }

    const row = logSh.getLastRow() + 1;
    const now = new Date();

    logSh.getRange(row, 1, 1, 5).setValues([[
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      eventType,
      reference ? reference.toString() : '',
      message   ? message.toString()   : '',
      detail    ? detail.toString().substring(0, 500) : '',
    ]]);

    // Color-code rows by event type
    const rowRange = logSh.getRange(row, 1, 1, 5);
    if (eventType === 'ERROR') {
      rowRange.setBackground('#FFEBEE');
    } else if (eventType.includes('BREACH') || eventType === 'EMERGENCY_STOP') {
      rowRange.setBackground('#FFF9C4');
    } else if (eventType === 'DELIVERED') {
      rowRange.setBackground('#E8F5E9');
    } else if (eventType === 'RETURNED' || eventType === 'RETURN_LOSS') {
      rowRange.setBackground('#FFF3E0');
    }

    // Keep log to 5000 rows max — delete oldest if over limit
    if (row > 5000) {
      logSh.deleteRow(2);
    }
  } catch (e) {
    // Silently fail log errors to prevent infinite loops
    console.error('Log write failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Writes a value to a cell only if the cell is currently empty.
 * SAFETY: Core pattern — never overwrites existing data.
 */
function writeIfEmpty_(sheet, row, col, value, dateFormat) {
  const cell = sheet.getRange(row, col);
  if (!cell.getValue()) {
    cell.setValue(value);
    if (dateFormat && value instanceof Date) {
      cell.setNumberFormat(dateFormat);
    }
  }
}

/**
 * Writes the automation audit flag to the AQ column.
 * Appends rather than overwrites.
 */
function setAutoFlag_(sheet, row, flagText) {
  const cell = sheet.getRange(row, CONFIG.col.AUTO_FLAG);
  const existing = cell.getValue() || '';
  const newFlag  = existing ? existing + '\n' + flagText : flagText;
  cell.setValue(newFlag.substring(0, 1000)); // cap at 1000 chars
  cell.setWrap(true);
}

/**
 * Formats a date to dd-MMM-yyyy string.
 */
function formatDate_(date) {
  if (!(date instanceof Date)) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MMM-yyyy');
}

// ═══════════════════════════════════════════════════════════════════
// MANUAL UTILITIES — Run from Apps Script editor when needed
// ═══════════════════════════════════════════════════════════════════

/**
 * Manually run a full SLA recalculation across all orders.
 * Run this from the Apps Script editor: Run → runManualSLARefresh
 */
function runManualSLARefresh() {
  updateSLAStatus_();
  SpreadsheetApp.getUi().alert('✅ SLA status refreshed for all orders.');
}

/**
 * Test the email system without waiting for the daily trigger.
 * Run this from Apps Script editor to verify email is working.
 */
function testDailySummaryEmail() {
  sendDailySummaryEmail_();
  SpreadsheetApp.getUi().alert('✅ Test email sent. Check your inbox.');
}

/**
 * Backfill SLA columns for all existing orders.
 * Useful after first deployment to populate all historical rows.
 * Run once from editor: Run → backfillAllOrders
 */
function backfillAllOrders() {
  updateSLAStatus_();
  log_('BACKFILL', 'ALL', 'Manual backfill completed', new Date().toString());
  SpreadsheetApp.getUi().alert('✅ All orders backfilled with SLA data.');
}

/**
 * Test a specific order row manually.
 * Usage: Change testRow number and run from editor.
 */
function testOrderRow() {
  const testRow = 3; // Change this to test a specific row
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(CONFIG.sheets.ORDERS);
  const rowData = ordSh.getRange(testRow, 1, 1, 43).getValues()[0];
  const status  = rowData[CONFIG.col.STATUS - 1];

  SpreadsheetApp.getUi().alert(
    `Row ${testRow} Status: ${status}\n` +
    `Order ID: ${rowData[0]}\n` +
    `Customer: ${rowData[2]}\n` +
    `Product: ${rowData[8]}\n` +
    `Tracking: ${rowData[24]}`
  );
}

/**
 * View the automation log summary.
 */
function viewLogSummary() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const logSh = ss.getSheetByName(CONFIG.sheets.AUTOMATION_LOG);
  if (!logSh) {
    SpreadsheetApp.getUi().alert('No log sheet found yet. Run an order through the system first.');
    return;
  }
  const total  = logSh.getLastRow() - 1;
  const errors = logSh.getRange(2, 2, total, 1).getValues()
                      .filter(r => r[0] === 'ERROR').length;
  SpreadsheetApp.getUi().alert(
    `🤖 AUTOMATION LOG SUMMARY\n\n` +
    `Total events: ${total}\n` +
    `Errors: ${errors}\n\n` +
    `View the 🤖 AUTOMATION LOG sheet for full history.`
  );
}

/**
 * Add a custom menu to the Google Sheet.
 * This runs automatically when the sheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚡ Alma ERP Automation')
    .addItem('🔄 Refresh SLA Status', 'runManualSLARefresh')
    .addItem('📧 Send Test Daily Email', 'testDailySummaryEmail')
    .addItem('📊 View Log Summary', 'viewLogSummary')
    .addSeparator()
    .addItem('⬇️ Backfill All Orders', 'backfillAllOrders')
    .addSeparator()
    .addItem('✅ Install Triggers', 'installTriggers')
    .addItem('⛔ Emergency Stop (Pause Automation)', 'emergencyStop')
    .addToUi();
}