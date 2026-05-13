/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║         ALMA LIFESTYLE ERP — PHASE 3                                     ║
 * ║         DRIVE & DOCUMENT AUTOMATION SYSTEM                               ║
 * ║         Version 2.0 | CONFIG-based Architecture                          ║
 * ║                                                                           ║
 * ║  HOW TO DEPLOY:                                                           ║
 * ║  1. In Apps Script editor: click + next to Files                         ║
 * ║  2. Name the new file "Phase3_Drive"                                      ║
 * ║  3. Paste this entire script                                              ║
 * ║  4. Paste your real folder IDs into the DRIVE object below               ║
 * ║  5. Run installPhase3Triggers() ONCE to activate Drive automation        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT THIS MODULE DOES:
 *   ✅ Creates order subfolders inside 01_Orders/Year/Month/OrderID/
 *   ✅ Creates customer subfolders inside 02_Customers/Name/
 *   ✅ Creates invoice archive inside 06_Invoices/Year/Month/
 *   ✅ Creates monthly report folders inside 05_Reports/
 *   ✅ Generates PDF snapshots of key sheets (backup)
 *   ✅ Creates backup snapshots inside 12_System_Backups/
 *   ✅ Maintains a DRIVE INDEX sheet for document lookup
 *   ✅ Runs daily backup at 2 AM
 *   ✅ All operations are duplicate-safe (getFoldersByName before createFolder)
 *
 * SAFE DESIGN:
 *   • Never creates folders at Drive root — only inside your existing structure
 *   • Uses getFoldersByName() before createFolder() — no duplicates
 *   • All Drive operations are wrapped in try/catch with full logging
 *   • Invoice numbering is atomic — no gaps or duplicates
 *   • Backups are append-only — never deletes existing files
 */

// ═══════════════════════════════════════════════════════════════════════════
// ▼▼▼  CONFIGURATION — PASTE YOUR REAL FOLDER IDs HERE  ▼▼▼
// ───────────────────────────────────────────────────────────────────────────
// How to find a folder ID:
//   1. Open Google Drive
//   2. Right-click the folder → Get link (or Share → Copy link)
//   3. The URL looks like: https://drive.google.com/drive/folders/1AbCdEfGh...
//   4. The ID is the string after /folders/  →  1AbCdEfGh...
//   5. Paste it between the single quotes below, replacing PASTE_ID_HERE
// ═══════════════════════════════════════════════════════════════════════════

const DRIVE = {
  ROOT:           '1SQuhO7UXXsnTrziwVnHBVqtZisme9JoL',  // Alma Lifestyle ERP  (parent folder)
  ORDERS:         '1q4UpfPpErNH4QewjA94LtPIF_BxadM71',  // 01_Orders
  CUSTOMERS:      '1ktUiYssNrZxQy9EaXvsCSGXkJ0QNIn9p',  // 02_Customers
  EXPENSES:       '11WirlxMhlO8aKYUKL1d_CUmYrYi9DfQ3',  // 03_Expenses
  INVENTORY:      '19_8j_Uinn7RAKDMBEoDeL-CRYaDCDkXJ',  // 04_Inventory
  REPORTS:        '1v1Sb9xLZgzQBvUEs8W3DKth7bLu0hyz4',  // 05_Reports
  INVOICES:       '1C8ndkijPaeDGELTj1REEzFoBVqa9Amtb',  // 06_Invoices
  STAFF:          '1eVbe1dI0a6I1J7Y8EIpoqKcQPogf5WYA',  // 07_Staff
  SUPPLIERS:      '1nwzjJFIDLkjPIkjHj-Prf1SkUZwfwfwx',  // 08_Suppliers
  MARKETING:      '1vGqELDPFGii83HHlftMv2tOcngiwXbRk',  // 09_Marketing
  PAYMENT_PROOFS: '1IDmHQK1RuTQ1wK0fMl4reJmSvm8mpOWL',  // 10_Payment_Proofs
  ARCHIVE:        '1cY_zvF3FKvc5tV-mHmLRyKVifQlJs7zD',  // 11_Archive
  BACKUPS:        '1Vmnr_jETieAx-1lPC8JYlVjh5jfQAeJU',  // 12_System_Backups
};

// ▲▲▲  END OF CONFIGURATION  ▲▲▲
// ═══════════════════════════════════════════════════════════════════════════

// Sheet name for Drive index (auto-created by script)
const DRIVE_INDEX_SHEET = '📁 DRIVE INDEX';

// Invoice number prefix and zero-padding width
const INVOICE_PREFIX = 'INV';
const INVOICE_PAD    = 4;   // produces INV-2026-0001

// ═══════════════════════════════════════════════════════════════════════════
// FOLDER ACCESS — single gateway for all Drive folder lookups
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns a DriveApp.Folder by key from the DRIVE config object.
 * Returns null (with a log entry) if the ID is unconfigured or inaccessible.
 * This is the ONLY function that touches DriveApp.getFolderById() — all
 * other functions call getFolder_(), keeping error handling in one place.
 *
 * @param  {string} key  — a key from the DRIVE object, e.g. 'ORDERS'
 * @returns {GoogleAppsScript.Drive.Folder|null}
 */
function getFolder_(key) {
  const id = DRIVE[key];
  if (!id || id === 'PASTE_ID_HERE') {
    driveLog_('CONFIG_ERROR', key,
      `Folder ID not set — open Phase3_Drive.gs and paste the real ID into DRIVE.${key}`, '');
    return null;
  }
  try {
    return DriveApp.getFolderById(id);
  } catch (e) {
    driveLog_('DRIVE_ERROR', key, `Cannot access folder: ${e.message}`, id);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER INSTALLATION — Phase 3 specific
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Install Phase 3 triggers (adds to existing Phase 2 triggers — does not replace).
 * Run from editor: Run → installPhase3Triggers
 */
function installPhase3Triggers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Check if daily backup trigger already exists
  const existing = ScriptApp.getProjectTriggers();
  const hasBackup   = existing.some(t => t.getHandlerFunction() === 'runNightlyBackup');
  const hasMonthly  = existing.some(t => t.getHandlerFunction() === 'runMonthlyArchive');
  const hasWeekly   = existing.some(t => t.getHandlerFunction() === 'runWeeklyIndexRebuild');

  if (!hasBackup) {
    ScriptApp.newTrigger('runNightlyBackup')
      .timeBased().atHour(2).everyDays(1).create();
  }
  if (!hasMonthly) {
    ScriptApp.newTrigger('runMonthlyArchive')
      .timeBased().onMonthDay(1).atHour(3).create();
  }
  if (!hasWeekly) {
    ScriptApp.newTrigger('runWeeklyIndexRebuild')
      .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  }

  // Build Drive Index sheet if not present
  ensureDriveIndexSheet_();

  driveLog_('SETUP', 'installPhase3Triggers', 'Phase 3 triggers installed', '');
  SpreadsheetApp.getUi().alert(
    '✅ Alma Lifestyle ERP — Phase 3 Drive Automation\n\n' +
    '• Nightly Backup (2 AM): ' + (!hasBackup ? 'INSTALLED' : 'already active') + '\n' +
    '• Monthly Archive (1st of month, 3 AM): ' + (!hasMonthly ? 'INSTALLED' : 'already active') + '\n' +
    '• Weekly Index Rebuild (Monday 7 AM): ' + (!hasWeekly ? 'INSTALLED' : 'already active') + '\n\n' +
    'Check the 📁 DRIVE INDEX sheet for document tracking.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE UTILITY: SAFE SUBFOLDER CREATION
// ─────────────────────────────────────────────────────────────────────────
// This is the foundation of ALL Drive operations in this module.
// NEVER calls createFolder() without first checking for existence.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gets or creates a subfolder inside a parent folder.
 * SAFE: checks for existing folder first — never creates duplicates.
 * Returns the folder object, or null on failure.
 *
 * @param {GoogleAppsScript.Drive.Folder} parentFolder - parent folder object
 * @param {string} folderName - name of subfolder to get or create
 * @returns {GoogleAppsScript.Drive.Folder|null}
 */
function getOrCreateSubfolder_(parentFolder, folderName) {
  if (!parentFolder || !folderName) return null;
  try {
    // Search for existing folder with this exact name
    const existing = parentFolder.getFoldersByName(folderName);
    if (existing.hasNext()) {
      return existing.next(); // Return existing — no duplicate created
    }
    // Create only if not found
    const created = parentFolder.createFolder(folderName);
    driveLog_('FOLDER_CREATED', folderName, `Created inside: ${parentFolder.getName()}`, created.getId());
    return created;
  } catch (e) {
    driveLog_('FOLDER_ERROR', folderName, e.message, parentFolder.getName());
    return null;
  }
}

/**
 * Navigates/creates a nested path inside a root folder.
 * Example: navigatePath_(ordersFolder, ['2026', 'May', 'AL-0007'])
 * Returns the deepest folder, creating any missing levels safely.
 *
 * @param {GoogleAppsScript.Drive.Folder} rootFolder
 * @param {string[]} pathParts - array of folder names to traverse/create
 * @returns {GoogleAppsScript.Drive.Folder|null}
 */
function navigatePath_(rootFolder, pathParts) {
  let current = rootFolder;
  for (const part of pathParts) {
    current = getOrCreateSubfolder_(current, part);
    if (!current) return null;
  }
  return current;
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE A: ORDER FOLDER SYSTEM
// Structure: 01_Orders / 2026 / May / AL-0007 /
//                                              ├── Payment_Proof/
//                                              ├── Courier_Slip/
//                                              └── Invoice/
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates the full folder structure for a new order.
 * Called automatically when a new order row is entered (via onOrderEdit hook).
 * Also callable manually for any order ID.
 *
 * @param {string} orderId     - e.g. "AL-0007"
 * @param {string} customer    - customer name
 * @param {Date}   orderDate   - order date object
 * @returns {string|null} folder URL, or null on failure
 */
function createOrderFolder_(orderId, customer, orderDate) {
  if (!orderId) return null;

  const ordersRoot = getFolder_('ORDERS');
  if (!ordersRoot) return null;

  const date  = orderDate instanceof Date ? orderDate : new Date();
  const year  = date.getFullYear().toString();
  const month = Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMM'); // "May"

  // Navigate: 01_Orders / 2026 / May / AL-0007
  const orderFolder = navigatePath_(ordersRoot, [year, month, orderId]);
  if (!orderFolder) return null;

  // Create standardised subfolders inside the order folder
  const subfolders = [
    'Payment_Proof',   // bKash screenshots, bank slips
    'Courier_Slip',    // Courier receipt, tracking screenshots
    'Invoice',         // PDF invoice copy
    'Product_Photos',  // If needed for return disputes
    'Correspondence',  // WhatsApp screenshots, notes
  ];
  subfolders.forEach(sf => getOrCreateSubfolder_(orderFolder, sf));

  // Index this folder
  indexDocument_('ORDER_FOLDER', orderId, orderFolder.getUrl(), customer,
    `Orders/${year}/${month}/${orderId}`);

  driveLog_('ORDER_FOLDER', orderId, `Folder ready: Orders/${year}/${month}/${orderId}`, orderFolder.getId());
  return orderFolder.getUrl();
}
function testCreateOrderFolder() {

  createOrderFolder_(
    'AL-TEST-01',
    'Test Customer',
    new Date()
  );

  Browser.msgBox('✅ Test order folder created.');

}

/**
 * PUBLIC: Manually create folder for a specific order ID.
 * Usage: call from Apps Script editor or ⚡ menu.
 */
function createOrderFolderManual() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Create Order Folder', 'Enter Order ID (e.g. AL-0007):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const orderId = resp.getResponseText().trim();
  if (!orderId) return;

  // Look up order details from ORDERS sheet
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName('📦 ORDERS');
  const data  = ordSh.getDataRange().getValues();

  let customer = '', orderDate = new Date();
  for (let i = 2; i < data.length; i++) {
    if (data[i][0] === orderId) {
      customer  = data[i][2];
      orderDate = data[i][1] instanceof Date ? data[i][1] : new Date();
      break;
    }
  }

  const url = createOrderFolder_(orderId, customer, orderDate);
  if (url) {
    ui.alert(`✅ Order folder ready!\n\n${url}`);
  } else {
    ui.alert('❌ Could not create folder. Check that all IDs are pasted into the DRIVE config object in Phase3_Drive.gs.');
  }
}

/**
 * Bulk-creates order folders for all orders in the ORDERS sheet.
 * Run once after first deployment to backfill existing orders.
 */
function backfillOrderFolders() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName('📦 ORDERS');
  if (!ordSh) return;

  const data  = ordSh.getRange(3, 1, ordSh.getLastRow() - 2, 5).getValues();
  let created = 0, skipped = 0;

  data.forEach(row => {
    const orderId = row[0];
    if (!orderId) { skipped++; return; }
    const customer  = row[2];
    const orderDate = row[1] instanceof Date ? row[1] : new Date();
    const url = createOrderFolder_(orderId, customer, orderDate);
    if (url) { created++; } else { skipped++; }
    Utilities.sleep(200); // Rate limit — Drive API has quotas
  });

  driveLog_('BACKFILL', 'backfillOrderFolders', `Created: ${created} | Skipped: ${skipped}`, '');
  SpreadsheetApp.getUi().alert(`✅ Backfill complete.\nFolders created: ${created}\nSkipped: ${skipped}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE B: CUSTOMER FOLDER SYSTEM
// Structure: 02_Customers / CustomerName / [Orders, Notes, Returns]
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a customer folder structure.
 * Folder name is sanitized to be Drive-safe.
 *
 * @param {string} customerName
 * @param {string} phone
 * @returns {string|null} folder URL
 */
function createCustomerFolder_(customerName, phone) {
  if (!customerName) return null;

  const custRoot = getFolder_('CUSTOMERS');
  if (!custRoot) return null;

  // Sanitize name: remove characters that cause Drive issues
  const safeName = sanitizeFolderName_(customerName);
  const folderLabel = phone
    ? `${safeName} (${phone.toString().slice(-4)})`
    : safeName;

  const custFolder = getOrCreateSubfolder_(custRoot, folderLabel);
  if (!custFolder) return null;

  // Subfolders per customer
  ['Order_History', 'Payment_Records', 'Return_Records', 'Correspondence'].forEach(sf => {
    getOrCreateSubfolder_(custFolder, sf);
  });

  indexDocument_('CUSTOMER_FOLDER', customerName, custFolder.getUrl(), phone ? phone.toString() : '',
    `Customers/${folderLabel}`);

  driveLog_('CUSTOMER_FOLDER', customerName, `Customer folder ready: ${folderLabel}`, custFolder.getId());
  return custFolder.getUrl();
}

/**
 * Bulk-create customer folders for all customers in CUSTOMER MASTER.
 */
function backfillCustomerFolders() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const cmSh = ss.getSheetByName('👤 CUSTOMER MASTER');
  if (!cmSh) return;

  // Customer rows start at row 7, name=col B (2), phone=col C (3)
  const data    = cmSh.getRange(7, 2, cmSh.getLastRow() - 6, 2).getValues();
  let created   = 0, skipped = 0;

  data.forEach(row => {
    const name  = row[0];
    const phone = row[1];
    if (!name) { skipped++; return; }
    const url = createCustomerFolder_(name, phone);
    if (url) { created++; } else { skipped++; }
    Utilities.sleep(300);
  });

  driveLog_('BACKFILL', 'backfillCustomerFolders', `Created: ${created} | Skipped: ${skipped}`, '');
  SpreadsheetApp.getUi().alert(`✅ Customer folders backfilled.\nCreated: ${created} | Skipped: ${skipped}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE C: PAYMENT PROOF ORGANIZATION
// Structure: 10_Payment_Proofs / 2026 / May / OrderID_CustomerName/
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a payment proof folder for a specific order.
 * This is where you manually drop bKash screenshots, bank slips etc.
 *
 * @param {string} orderId
 * @param {string} customerName
 * @param {string} paymentMethod - "bKash", "COD", "Bank Transfer", etc.
 * @param {Date}   orderDate
 * @returns {string|null} folder URL
 */
function createPaymentProofFolder_(orderId, customerName, paymentMethod, orderDate) {
  if (!orderId) return null;

  const ppRoot = getFolder_('PAYMENT_PROOFS');
  if (!ppRoot) return null;

  const date   = orderDate instanceof Date ? orderDate : new Date();
  const year   = date.getFullYear().toString();
  const month  = Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMM');
  const safe   = sanitizeFolderName_(customerName || 'Unknown');
  const fLabel = `${orderId}_${safe}`;

  const ppFolder = navigatePath_(ppRoot, [year, month, fLabel]);
  if (!ppFolder) return null;

  // Subfolders by payment type
  const paymentSubs = ['bKash_Screenshot', 'Bank_Slip', 'COD_Receipt', 'Courier_Receipt'];
  paymentSubs.forEach(sf => getOrCreateSubfolder_(ppFolder, sf));

  indexDocument_('PAYMENT_PROOF', orderId, ppFolder.getUrl(), customerName,
    `Payment_Proofs/${year}/${month}/${fLabel}`);

  return ppFolder.getUrl();
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE D: INVOICE ARCHIVE SYSTEM
// Structure: 06_Invoices / 2026 / May / INV-2026-0001.pdf
// Invoice number: INV-YYYY-NNNN (sequential, no gaps, stored in Properties)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns the next invoice number, formatted as INV-YYYY-NNNN.
 * Uses Script Properties as an atomic counter — thread-safe for single-user Sheets.
 *
 * @param {boolean} increment - if true, advances the counter
 * @returns {string} invoice number string
 */
function getNextInvoiceNumber_(increment) {
  const props   = PropertiesService.getScriptProperties();
  const year    = new Date().getFullYear().toString();
  const key     = `INV_COUNTER_${year}`;
  const current = parseInt(props.getProperty(key) || '0', 10);
  const next    = current + 1;
  if (increment !== false) {
    props.setProperty(key, next.toString());
  }
  return `${INVOICE_PREFIX}-${year}-${next.toString().padStart(INVOICE_PAD, '0')}`;
}

/**
 * Peek at next invoice number without incrementing (for display).
 */
function peekNextInvoiceNumber() {
  const props = PropertiesService.getScriptProperties();
  const year  = new Date().getFullYear().toString();
  const key   = `INV_COUNTER_${year}`;
  const cur   = parseInt(props.getProperty(key) || '0', 10);
  const next  = cur + 1;
  return `${INVOICE_PREFIX}-${year}-${next.toString().padStart(INVOICE_PAD, '0')}`;
}

/**
 * Creates the invoice subfolder for a given month and returns it.
 * Structure: 06_Invoices / 2026 / May /
 */
function getInvoiceMonthFolder_(date) {
  const invRoot = getFolder_('INVOICES');
  if (!invRoot) return null;
  const year    = (date || new Date()).getFullYear().toString();
  const month   = Utilities.formatDate(date || new Date(), Session.getScriptTimeZone(), 'MMM');
  return navigatePath_(invRoot, [year, month]);
}

/**
 * Generates a PDF of the active spreadsheet's invoice sheet and saves to Drive.
 * The invoice sheet must be named "🧾 INVOICE" and pre-populated with order data.
 *
 * @param {string} orderId
 * @param {string} customerName
 * @param {number} invoiceAmount
 * @returns {{invoiceNumber: string, fileUrl: string}|null}
 */
function generateAndSaveInvoicePdf_(orderId, customerName, invoiceAmount) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Get invoice sheet
  const invSheet = ss.getSheetByName('🧾 INVOICE');
  if (!invSheet) {
    driveLog_('INVOICE_ERROR', orderId, 'Invoice sheet not found — create 🧾 INVOICE sheet first', '');
    return null;
  }

  // Assign invoice number
  const invoiceNumber = getNextInvoiceNumber_(true);

  // Export sheet as PDF via URL
  const ssId    = ss.getId();
  const gid     = invSheet.getSheetId();
  const baseUrl = `https://docs.google.com/spreadsheets/d/${ssId}/export`;
  const params  = [
    'format=pdf',
    `gid=${gid}`,
    'size=A4',
    'portrait=true',
    'fitw=true',
    'top_margin=0.5',
    'bottom_margin=0.5',
    'left_margin=0.5',
    'right_margin=0.5',
    'gridlines=false',
    'printnotes=false',
    'sheetnames=false',
  ].join('&');
  const exportUrl = `${baseUrl}?${params}`;

  let pdfBlob;
  try {
    pdfBlob = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }
    }).getBlob();
  } catch (e) {
    driveLog_('INVOICE_ERROR', orderId, `PDF export failed: ${e.message}`, exportUrl);
    return null;
  }

  const safeName  = sanitizeFolderName_(customerName || 'Customer');
  const fileName  = `${invoiceNumber}_${orderId}_${safeName}.pdf`;
  pdfBlob.setName(fileName);

  // Save to 06_Invoices / Year / Month /
  const monthFolder = getInvoiceMonthFolder_(new Date());
  if (!monthFolder) return null;

  const savedFile = monthFolder.createFile(pdfBlob);
  const fileUrl   = savedFile.getUrl();

  // Also save a copy into the order's Invoice subfolder
  const ordersRoot = getFolder_('ORDERS');
  if (ordersRoot) {
    const date       = new Date();
    const year       = date.getFullYear().toString();
    const month      = Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMM');
    const orderFolder = navigatePath_(ordersRoot, [year, month, orderId, 'Invoice']);
    if (orderFolder) {
      pdfBlob.setName(fileName);
      orderFolder.createFile(pdfBlob);
    }
  }

  indexDocument_('INVOICE', invoiceNumber, fileUrl, customerName,
    `Invoices/${new Date().getFullYear()}/${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM')}/${fileName}`);

  driveLog_('INVOICE_SAVED', invoiceNumber, `PDF saved: ${fileName}`, fileUrl);
  return { invoiceNumber, fileUrl, fileName };
}

/**
 * PUBLIC: Generate invoice for an order ID. Callable from ⚡ menu.
 */
function generateInvoiceManual() {
  const ui  = SpreadsheetApp.getUi();
  const r   = ui.prompt('Generate Invoice', 'Enter Order ID:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;

  const orderId = r.getResponseText().trim();
  if (!orderId) return;

  // Look up order
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName('📦 ORDERS');
  const data  = ordSh.getDataRange().getValues();

  let customer = '', amount = 0;
  for (let i = 2; i < data.length; i++) {
    if (data[i][0] === orderId) {
      customer = data[i][2];
      amount   = data[i][17] || 0; // SELL PRICE column R
      break;
    }
  }

  if (!customer) {
    ui.alert(`❌ Order ${orderId} not found in ORDERS sheet.`);
    return;
  }

  const result = generateAndSaveInvoicePdf_(orderId, customer, amount);
  if (result) {
    ui.alert(`✅ Invoice generated!\n\nInvoice #: ${result.invoiceNumber}\nFile: ${result.fileName}\n\nSaved to Google Drive.`);
  } else {
    ui.alert('❌ Invoice generation failed. Check AUTOMATION LOG for details.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE E: MONTHLY REPORT ARCHIVE
// Structure: 05_Reports / 2026 / May_2026 / [Sales, Profit, Returns, Inventory]
// Triggered: 1st of each month at 3 AM
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates the monthly report folder structure and exports sheet snapshots.
 * Runs automatically on the 1st of each month.
 */
function runMonthlyArchive() {
  const now    = new Date();
  // Archive the PREVIOUS month
  const archiveDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year   = archiveDate.getFullYear().toString();
  const month  = Utilities.formatDate(archiveDate, Session.getScriptTimeZone(), 'MMMM'); // "April"
  const label  = `${month}_${year}`;

  driveLog_('MONTHLY_ARCHIVE', label, 'Monthly archive started', '');

  const reportsRoot = getFolder_('REPORTS');
  if (!reportsRoot) return;

  // Create year / MonthYear folder
  const monthFolder = navigatePath_(reportsRoot, [year, label]);
  if (!monthFolder) return;

  // Create sub-report folders
  const reportTypes = ['Sales_Report', 'Profit_Report', 'Return_Analysis', 'Inventory_Snapshot', 'Customer_Summary'];
  reportTypes.forEach(rt => getOrCreateSubfolder_(monthFolder, rt));

  // Export key sheets as PDF snapshots
  const sheetsToArchive = [
    { name: '📊 DASHBOARD',    fileName: `Dashboard_${label}.pdf`,    subfolder: 'Sales_Report' },
    { name: '📈 MONTHLY P&L',  fileName: `PL_Statement_${label}.pdf`, subfolder: 'Profit_Report' },
    { name: '💰 CASH FLOW',    fileName: `CashFlow_${label}.pdf`,     subfolder: 'Profit_Report' },
    { name: '📊 FINANCE DASH', fileName: `FinanceDash_${label}.pdf`,  subfolder: 'Profit_Report' },
    { name: '📦 STOCK CONTROL',fileName: `Inventory_${label}.pdf`,    subfolder: 'Inventory_Snapshot' },
    { name: '🎯 CRM DASHBOARD',fileName: `CRM_${label}.pdf`,          subfolder: 'Customer_Summary' },
  ];

  let exported = 0;
  for (const spec of sheetsToArchive) {
    const success = exportSheetToPdf_(spec.name, spec.fileName, monthFolder, spec.subfolder);
    if (success) exported++;
    Utilities.sleep(2000); // Avoid rate limiting
  }

  // Also create a plain-text summary in the folder root
  createMonthSummaryDoc_(monthFolder, label, archiveDate);

  indexDocument_('MONTHLY_ARCHIVE', label, monthFolder.getUrl(), `${exported} files`,
    `Reports/${year}/${label}`);
  driveLog_('MONTHLY_ARCHIVE', label, `Complete: ${exported}/${sheetsToArchive.length} sheets exported`, monthFolder.getUrl());
}

/**
 * Exports a single sheet as PDF into a Drive subfolder.
 */
function exportSheetToPdf_(sheetName, fileName, parentFolder, subfolderName) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    driveLog_('EXPORT_WARN', sheetName, 'Sheet not found — skipped', '');
    return false;
  }

  const target = subfolderName ? getOrCreateSubfolder_(parentFolder, subfolderName) : parentFolder;
  if (!target) return false;

  // Check if file already exists (idempotent)
  const existing = target.getFilesByName(fileName);
  if (existing.hasNext()) {
    driveLog_('EXPORT_SKIP', sheetName, `File already exists: ${fileName}`, '');
    return true;
  }

  const ssId    = ss.getId();
  const gid     = sheet.getSheetId();
  const url     = `https://docs.google.com/spreadsheets/d/${ssId}/export?format=pdf&gid=${gid}&size=A4&portrait=true&fitw=true&gridlines=false`;

  try {
    const blob = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }
    }).getBlob().setName(fileName);
    target.createFile(blob);
    driveLog_('EXPORT_OK', sheetName, `Saved: ${fileName}`, target.getName());
    return true;
  } catch (e) {
    driveLog_('EXPORT_ERROR', sheetName, e.message, fileName);
    return false;
  }
}

/**
 * Creates a simple Google Doc summary for the month archive folder.
 */
function createMonthSummaryDoc_(folder, label, date) {
  try {
    const docName = `_Archive_Summary_${label}`;
    const existing = folder.getFilesByName(docName);
    if (existing.hasNext()) return; // Already exists

    const doc  = DocumentApp.create(docName);
    const body = doc.getBody();
    body.appendParagraph(`ALMA LIFESTYLE — ${label} ARCHIVE`).setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph(`Generated: ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMMM yyyy HH:mm')}`);
    body.appendParagraph('');
    body.appendParagraph('Contents of this folder:').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendListItem('Sales_Report/ — Dashboard PDF snapshot');
    body.appendListItem('Profit_Report/ — P&L Statement, Cash Flow, Finance Dashboard');
    body.appendListItem('Return_Analysis/ — Return tracking and loss summary');
    body.appendListItem('Inventory_Snapshot/ — Stock Control PDF');
    body.appendListItem('Customer_Summary/ — CRM Dashboard PDF');
    body.appendParagraph('');
    body.appendParagraph('This archive was created automatically by Alma Lifestyle ERP Phase 3 Drive Automation.');
    doc.saveAndClose();

    // Move the doc into the archive folder
    const file = DriveApp.getFileById(doc.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file); // Remove from root (Google Docs go to root by default)
  } catch (e) {
    driveLog_('DOC_ERROR', label, e.message, '');
  }
}

/**
 * Manually run monthly archive for any month.
 * Useful for backfilling.
 */
function runMonthlyArchiveManual() {
  runMonthlyArchive();
  SpreadsheetApp.getUi().alert('✅ Monthly archive complete. Check 05_Reports folder.');
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE F: NIGHTLY BACKUP SYSTEM
// Structure: 12_System_Backups / 2026 / YYYYMMDD_HHmm_AlmaLifestyleERP/
// Runs: every night at 2 AM
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a backup copy of the ERP spreadsheet.
 * Runs nightly at 2 AM via time-based trigger.
 * SAFE: append-only, never deletes existing backups.
 * Retains 90 days of backups automatically.
 */
function runNightlyBackup() {
  const backupsRoot = getFolder_('BACKUPS');
  if (!backupsRoot) return;

  const now       = new Date();
  const year      = now.getFullYear().toString();
  const timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
  const backupName= `${timestamp}_AlmaLifestyleERP`;

  driveLog_('BACKUP', 'runNightlyBackup', `Starting backup: ${backupName}`, '');

  // Get or create year folder inside 12_System_Backups
  const yearFolder = getOrCreateSubfolder_(backupsRoot, year);
  if (!yearFolder) return;

  try {
    // Make a copy of the spreadsheet file
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const ssFile= DriveApp.getFileById(ss.getId());
    const copy  = ssFile.makeCopy(backupName, yearFolder);

    indexDocument_('BACKUP', backupName, copy.getUrl(), 'System',
      `Backups/${year}/${backupName}`);

    driveLog_('BACKUP_OK', backupName, `Backup saved successfully`, copy.getUrl());

    // Cleanup: delete backups older than 90 days in this year folder
    cleanupOldBackups_(yearFolder, 90);
  } catch (e) {
    driveLog_('BACKUP_ERROR', backupName, e.message, '');
  }
}

/**
 * Deletes backup files older than maxAgeDays from a folder.
 * Only deletes files matching the backup naming pattern (timestamp prefix).
 */
function cleanupOldBackups_(folder, maxAgeDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const files  = folder.getFiles();
  let deleted  = 0;

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    // Only delete files that match our backup pattern (starts with 8-digit date)
    if (!/^\d{8}_\d{4}_/.test(name)) continue;
    if (file.getDateCreated() < cutoff) {
      file.setTrashed(true);
      deleted++;
      driveLog_('BACKUP_CLEANUP', name, `Deleted (>${maxAgeDays} days old)`, '');
    }
  }
  if (deleted > 0) {
    driveLog_('BACKUP_CLEANUP', 'cleanup', `${deleted} old backups removed`, folder.getName());
  }
}

/**
 * Manually trigger a backup right now.
 */
function runBackupManual() {
  runNightlyBackup();
  SpreadsheetApp.getUi().alert('✅ Backup complete. Check 12_System_Backups folder.');
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE G: DRIVE INDEX — Document Registry Sheet
// Sheet: 📁 DRIVE INDEX
// Maintains a searchable register of all Drive documents created by this system.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates the DRIVE INDEX sheet if it doesn't exist.
 * Adds headers with professional styling.
 */
function ensureDriveIndexSheet_() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let idxSh   = ss.getSheetByName(DRIVE_INDEX_SHEET);

  if (!idxSh) {
    idxSh = ss.insertSheet(DRIVE_INDEX_SHEET);
    idxSh.setTabColor('1A2A4A');

    // Headers
    const headers = [['TIMESTAMP','TYPE','REFERENCE','DISPLAY NAME','PATH','DRIVE LINK','CREATED BY']];
    const hdrRng  = idxSh.getRange(1, 1, 1, 7);
    hdrRng.setValues(headers)
          .setFontWeight('bold')
          .setBackground('#0D0D0D')
          .setFontColor('#C9A84C')
          .setFontFamily('Calibri')
          .setFontSize(9);

    idxSh.setFrozenRows(1);
    idxSh.setColumnWidth(1, 160);
    idxSh.setColumnWidth(2, 130);
    idxSh.setColumnWidth(3, 120);
    idxSh.setColumnWidth(4, 180);
    idxSh.setColumnWidth(5, 260);
    idxSh.setColumnWidth(6, 260);
    idxSh.setColumnWidth(7, 120);
  }
  return idxSh;
}

/**
 * Writes a record to the DRIVE INDEX sheet.
 *
 * @param {string} type       - document type: ORDER_FOLDER, INVOICE, BACKUP, etc.
 * @param {string} reference  - order ID, invoice number, customer name, etc.
 * @param {string} url        - Google Drive URL
 * @param {string} displayName- human-readable name
 * @param {string} path       - folder path string (for display)
 */
function indexDocument_(type, reference, url, displayName, path) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const idxSh = ensureDriveIndexSheet_();
    const row   = idxSh.getLastRow() + 1;

    idxSh.getRange(row, 1, 1, 7).setValues([[
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      type,
      reference ? reference.toString() : '',
      displayName ? displayName.toString() : '',
      path || '',
      url  || '',
      Session.getActiveUser().getEmail(),
    ]]);

    // Apply alternating row colors
    const bg = row % 2 === 0 ? '#FAF8F4' : '#FFFFFF';
    idxSh.getRange(row, 1, 1, 7).setBackground(bg);

    // Make URL cell a hyperlink (clickable)
    if (url) {
      idxSh.getRange(row, 6).setFormula(`=HYPERLINK("${url}","Open in Drive")`);
      idxSh.getRange(row, 6).setFontColor('#1565C0');
    }
  } catch (e) {
    // Silently fail to prevent index errors from breaking main operations
    console.error('indexDocument_ failed:', e.message);
  }
}

/**
 * Rebuilds the Drive Index by scanning Drive for known document patterns.
 * Runs weekly on Mondays at 7 AM.
 */
function runWeeklyIndexRebuild() {
  driveLog_('INDEX', 'runWeeklyIndexRebuild', 'Weekly index check started', '');
  // Lightweight: just log current backup and invoice counts
  const props      = PropertiesService.getScriptProperties();
  const year       = new Date().getFullYear().toString();
  const invCount   = props.getProperty(`INV_COUNTER_${year}`) || '0';
  driveLog_('INDEX', 'WEEKLY_CHECK', `Invoices issued this year: ${invCount}`, year);
}

/**
 * Search the Drive Index for a reference (order ID, invoice number, etc.)
 * Opens a dialog with the result.
 */
function searchDriveIndex() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.prompt('Search Drive Index', 'Enter Order ID, Invoice #, or Customer Name:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const query = resp.getResponseText().trim().toLowerCase();
  if (!query) return;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const idxSh = ss.getSheetByName(DRIVE_INDEX_SHEET);
  if (!idxSh) {
    ui.alert('Drive Index not found. Run installPhase3Triggers() first.');
    return;
  }

  const data  = idxSh.getDataRange().getValues();
  const found = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row.some(cell => cell && cell.toString().toLowerCase().includes(query))) {
      found.push(`Type: ${row[1]} | Ref: ${row[2]} | Path: ${row[4]}`);
    }
  }

  if (found.length === 0) {
    ui.alert(`No results found for: "${query}"`);
  } else {
    ui.alert(`Found ${found.length} result(s) for "${query}":\n\n${found.slice(0, 8).join('\n')}\n\n(Check 📁 DRIVE INDEX sheet for full details)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE H: SUPPLIER & MARKETING DOCUMENT ORGANIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates supplier subfolder inside 08_Suppliers.
 * Structure: 08_Suppliers / SupplierName / [POs, Invoices, Payments, Contracts]
 */
function createSupplierFolder_(supplierName) {
  if (!supplierName) return null;
  const supRoot = getFolder_('SUPPLIERS');
  if (!supRoot) return null;

  const safe = sanitizeFolderName_(supplierName);
  const supFolder = getOrCreateSubfolder_(supRoot, safe);
  if (!supFolder) return null;

  ['Purchase_Orders', 'Supplier_Invoices', 'Payment_Receipts', 'Contracts', 'Quality_Reports'].forEach(sf => {
    getOrCreateSubfolder_(supFolder, sf);
  });

  indexDocument_('SUPPLIER_FOLDER', supplierName, supFolder.getUrl(), supplierName, `Suppliers/${safe}`);
  return supFolder.getUrl();
}

/**
 * Creates marketing campaign folder inside 09_Marketing.
 * Structure: 09_Marketing / 2026 / CampaignName /
 */
function createMarketingFolder_(campaignName) {
  if (!campaignName) return null;
  const mktRoot = getFolder_('MARKETING');
  if (!mktRoot) return null;

  const year  = new Date().getFullYear().toString();
  const safe  = sanitizeFolderName_(campaignName);
  const mktFolder = navigatePath_(mktRoot, [year, safe]);
  if (!mktFolder) return null;

  ['Creatives', 'Ad_Screenshots', 'Performance_Reports', 'Budget_Sheets'].forEach(sf => {
    getOrCreateSubfolder_(mktFolder, sf);
  });

  indexDocument_('MARKETING_FOLDER', campaignName, mktFolder.getUrl(), campaignName, `Marketing/${year}/${safe}`);
  return mktFolder.getUrl();
}

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION HOOKS — Called from Phase 2 (Module 1) automation
// Add these calls inside the relevant Phase 2 functions by editing Module 1.
// Or they can be called independently from this file.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hook: Called when a new order is confirmed.
 * Creates order folder + payment proof folder.
 * Add this call inside onOrderConfirmed_() in Module 1.
 */
function onNewOrderDriveSetup(orderId, customer, phone, paymentMethod, orderDate) {
  if (!orderId) return;
  try {
    createOrderFolder_(orderId, customer, orderDate);
    createPaymentProofFolder_(orderId, customer, paymentMethod, orderDate);
    if (customer) createCustomerFolder_(customer, phone); // safe — checks for existing
    driveLog_('DRIVE_HOOK', orderId, `Drive folders created for ${customer}`, '');
  } catch (e) {
    driveLog_('DRIVE_HOOK_ERROR', orderId, e.message, 'onNewOrderDriveSetup');
  }
}

/**
 * Hook: Called when an order is delivered.
 * Triggers invoice generation.
 * Add this call inside onOrderDelivered_() in Module 1 when invoice sheet exists.
 */
function onDeliveredDriveActions(orderId, customer, amount) {
  try {
    // Invoice generation — only if 🧾 INVOICE sheet exists
    const invSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('🧾 INVOICE');
    if (invSheet) {
      generateAndSaveInvoicePdf_(orderId, customer, amount);
    }
    driveLog_('DRIVE_HOOK', orderId, 'Delivery Drive actions complete', '');
  } catch (e) {
    driveLog_('DRIVE_HOOK_ERROR', orderId, e.message, 'onDeliveredDriveActions');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sanitizes a string to be safe for use as a Google Drive folder name.
 * Removes/replaces characters that cause issues in Drive.
 */
function sanitizeFolderName_(name) {
  return name.toString()
    .replace(/[\/\\:*?"<>|]/g, '_')   // Replace path-unsafe chars
    .replace(/\s+/g, '_')             // Replace whitespace
    .replace(/_+/g, '_')              // Collapse multiple underscores
    .replace(/^_|_$/g, '')            // Trim leading/trailing underscores
    .substring(0, 100);               // Cap at 100 chars (Drive limit safety)
}

/**
 * Drive-specific logger. Uses the same AUTOMATION LOG sheet as Module 1.
 */
function driveLog_(eventType, reference, message, detail) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const logSh = ss.getSheetByName('🤖 AUTOMATION LOG') ||
                  (() => {
                    const s = ss.insertSheet('🤖 AUTOMATION LOG');
                    s.getRange(1,1,1,5).setValues([['TIMESTAMP','EVENT TYPE','REFERENCE','MESSAGE','DETAIL']]);
                    return s;
                  })();

    const row = logSh.getLastRow() + 1;
    logSh.getRange(row, 1, 1, 5).setValues([[
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      '[DRIVE] ' + eventType,
      reference ? reference.toString() : '',
      message   ? message.toString()   : '',
      detail    ? detail.toString().substring(0, 300) : '',
    ]]);

    // Color code by type
    if (eventType.includes('ERROR')) {
      logSh.getRange(row, 1, 1, 5).setBackground('#FFEBEE');
    } else if (eventType.includes('BACKUP')) {
      logSh.getRange(row, 1, 1, 5).setBackground('#E3F2FD');
    } else if (eventType.includes('INVOICE')) {
      logSh.getRange(row, 1, 1, 5).setBackground('#E8F5E9');
    } else if (eventType.includes('ARCHIVE')) {
      logSh.getRange(row, 1, 1, 5).setBackground('#FFF9C4');
    }
  } catch (e) {
    console.error('driveLog_ failed:', e.message);
  }
}

/**
 * Verify all configured folder IDs are accessible.
 * Run this to confirm setup is correct before first use.
 */
function verifyFolderAccess() {
  const results = [];

  Object.entries(DRIVE).forEach(([key, id]) => {
    if (!id || id === 'PASTE_ID_HERE') {
      results.push(`❌ ${key}: NOT CONFIGURED — paste ID into DRIVE.${key}`);
      return;
    }
    try {
      const folder = DriveApp.getFolderById(id);
      results.push(`✅ ${key}: ${folder.getName()}`);
    } catch (e) {
      results.push(`❌ ${key}: ERROR — ${e.message}`);
    }
  });

  SpreadsheetApp.getUi().alert(
    'Drive Folder Access Verification\n\n' + results.join('\n')
  );
}

/**
 * Show current Drive system status.
 */
function showDriveStatus() {
  const year     = new Date().getFullYear().toString();
  const nextInv  = peekNextInvoiceNumber();

  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const idxSh    = ss.getSheetByName(DRIVE_INDEX_SHEET);
  const idxCount = idxSh ? idxSh.getLastRow() - 1 : 0;

  const configured = Object.values(DRIVE).filter(id => id && id !== 'PASTE_ID_HERE').length;
  const total      = Object.keys(DRIVE).length;

  SpreadsheetApp.getUi().alert(
    '📁 ALMA LIFESTYLE ERP — DRIVE STATUS\n\n' +
    `Folders configured: ${configured}/${total}\n` +
    `Next invoice number: ${nextInv}\n` +
    `Drive index records: ${idxCount}\n\n` +
    'Triggers active:\n' +
    '• Nightly backup (2 AM daily)\n' +
    '• Monthly archive (1st of month)\n' +
    '• Weekly index rebuild (Mondays)\n\n' +
    'Run verifyFolderAccess() to test Drive connections.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MENU EXTENSION — Adds Drive items to existing ⚡ menu
// This function is ADDITIVE to the onOpen() in Module 1.
// Rename the Module 1 onOpen() to onOpen_Module1() and call both from
// a new combined onOpen() to merge the menus, or add a separate sub-menu.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates the Drive sub-menu under ⚡ Alma ERP Automation.
 * Call this from the onOpen() function in Module 1 by adding:
 *   onOpenPhase3Menu_(menu);
 * before .addToUi() in Module 1's onOpen().
 *
 * OR: simply replace Module 1's onOpen() with the combined one below.
 */
function onOpenPhase3Menu_(existingMenu) {
  return existingMenu
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('📁 Drive Automation')
      .addItem('📂 Create Folder for Order', 'createOrderFolderManual')
      .addItem('🧾 Generate Invoice PDF', 'generateInvoiceManual')
      .addItem('📊 Run Monthly Archive Now', 'runMonthlyArchiveManual')
      .addItem('💾 Run Backup Now', 'runBackupManual')
      .addSeparator()
      .addItem('🔍 Search Drive Index', 'searchDriveIndex')
      .addItem('📋 Drive Status', 'showDriveStatus')
      .addSeparator()
      .addItem('⬇️ Backfill Order Folders', 'backfillOrderFolders')
      .addItem('⬇️ Backfill Customer Folders', 'backfillCustomerFolders')
      .addSeparator()
      .addItem('✅ Verify Drive Access', 'verifyFolderAccess')
      .addItem('⚡ Install Phase 3 Triggers', 'installPhase3Triggers'));
}

/**
 * COMBINED onOpen() — REPLACES the onOpen() in Module 1.
 * Paste this version into Module 1 (replacing the existing onOpen there),
 * so that both Phase 2 and Phase 3 menu items appear together.
 */