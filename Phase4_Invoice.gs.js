/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ALMA LIFESTYLE ERP — PHASE 4                                          ║
 * ║   PROFESSIONAL BRANDED PDF INVOICE SYSTEM                               ║
 * ║   Version 1.0                                                           ║
 * ║                                                                          ║
 * ║   DEPLOY: Add as a new file "Phase4_Invoice" in the same Apps Script   ║
 * ║   project. Do NOT replace Phase 2 or Phase 3 files.                    ║
 * ║                                                                          ║
 * ║   ACTIVATION (one-time):                                                ║
 * ║   1. Paste logo URL into INV_CONFIG.brand.logoUrl below                 ║
 * ║   2. Run activateInvoiceSystem() from the editor                        ║
 * ║   3. Done — invoices auto-generate on Status = Delivered                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * HOW IT WORKS:
 *   • Reads order data directly from the 📦 ORDERS sheet (no invoice sheet needed)
 *   • Builds a fully branded HTML document in memory
 *   • Converts it to PDF using the Drive API
 *   • Saves PDF to Drive folder "Alma ERP Invoices" (auto-created) as Invoice-{ORDER_ID}.pdf
 *   • Link sharing: anyone with the link can view (for WhatsApp / clients)
 *   • Also copies into legacy 06_Invoices path and the order folder when Phase 3 paths exist
 *   • Writes the invoice number back to the ORDERS sheet for reference
 *   • Duplicate protection: checks for an existing invoice before generating
 *
 * INTEGRATION:
 *   • Phase 2 (Code.gs): add one call inside onOrderDelivered_() — see HOOK section
 *   • Phase 3 (Phase3_Drive.gs): uses getFolder_() and INV_COUNTER from that file
 *   • ORDERS sheet col AQ (AUTO_FLAG) receives the invoice number and Drive URL
 */

// ═══════════════════════════════════════════════════════════════════════════
// ▼▼▼  INVOICE CONFIGURATION — UPDATE BEFORE FIRST USE  ▼▼▼
// ═══════════════════════════════════════════════════════════════════════════

const INV_CONFIG = {

  // ── Invoice numbering ────────────────────────────────────────────────────
  number: {
    prefix:  'AL-INV',   // produces AL-INV-2026-0001
    pad:     4,          // zero-padding width
  },

  // ── Brand identity ───────────────────────────────────────────────────────
  brand: {
    name:    'Alma Lifestyle',
    tagline: 'Premium Fashion · Crafted with Care',
    phone:   '0130-77777-33',
    email:   'almatraders.com@gmail.com',
    facebook:'facebook.com/AlmaLifestyle',

    // Paste your logo's public Drive or web URL here.
    // To get a public Drive URL:
    //   1. Upload logo PNG to Google Drive
    //   2. Right-click → Share → Anyone with the link → Viewer
    //   3. Copy the link, extract the FILE ID from it
    //   4. Build URL: https://drive.google.com/uc?export=view&id
    logoUrl: 'https://drive.google.com/uc?export=view&id=1PLl-LCbxv4h_A4znlrt0U5pQqMG5XNpc',
  },

  // ── Design tokens (match ERP palette exactly) ────────────────────────────
  colors: {
    black:    '#0D0D0D',
    gold:     '#C9A84C',
    goldDark: '#8B6914',
    goldLight:'#F0D080',
    white:    '#FFFFFF',
    cream:    '#FAF8F4',
    gray:     '#F5F5F5',
    grayMid:  '#888888',
    grayDark: '#444444',
  },

  // ── Footer message ───────────────────────────────────────────────────────
  footer: {
    thankYou: 'Thank you for choosing Alma Lifestyle.',
    policy:   'Exchange within 3 days of delivery. Item must be unused and in original packaging.',
    note:     'This is a computer-generated invoice and does not require a physical signature.',
  },

  // ── ORDERS sheet column map (mirrors CONFIG.col in Phase 2 exactly) ──────
  col: {
    ORDER_ID:        1,  // A
    DATE:            2,  // B
    CUSTOMER:        3,  // C
    PHONE:           4,  // D
    ADDRESS:         5,  // E
    PAYMENT:         6,  // F
    SOURCE:          7,  // G
    STATUS:          8,  // H
    PRODUCT:         9,  // I
    CATEGORY:        10, // J
    SIZE:            11, // K
    QTY:             12, // L
    UNIT_PRICE:      13, // M
    DISCOUNT:        14, // N
    ADD_DISCOUNT:    15, // O
    SELL_PRICE:      18, // R
    SHIP_COLLECTED:  19, // S
    COURIER_CHARGE:  21, // U
    COURIER:         24, // X
    TRACKING_ID:     25, // Y
    ACTUAL_DELIVERY: 28, // AB
    NOTES:           32, // AF
    SKU:             33, // AG
    AUTO_FLAG:       43, // AQ — script writes invoice ref here
  },

  // ── Dedicated shareable invoice archive (My Drive → auto-created) ────────
  almaInvoicesFolderName:        'Alma ERP Invoices',
  scriptPropAlmaInvoicesFolderId: 'ALMA_ERP_INVOICES_FOLDER_ID',

  // ── Sheet name ───────────────────────────────────────────────────────────
  sheet: '📦 ORDERS',

  // ── Invoice number storage key in Script Properties ──────────────────────
  // NOTE: Phase 3 uses INV_COUNTER_YYYY. This system uses AL_INV_YYYY
  // to keep the two counters independent (different prefix = different sequence).
  counterKey: 'AL_INV_COUNTER_',
};

// ═══════════════════════════════════════════════════════════════════════════
// ONE-TIME ACTIVATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run once from the Apps Script editor after pasting this file.
 * Validates config, sets up the invoice column header, and logs activation.
 */
function activateInvoiceSystem() {
  const ui  = SpreadsheetApp.getUi();
  const checks = [];

  // Check logo
  if (INV_CONFIG.brand.logoUrl === 'PASTE_LOGO_URL_HERE') {
    checks.push('⚠️  Logo URL not set — invoices will show brand name as text instead');
  } else {
    checks.push('✅ Logo URL configured');
  }

  // Check Phase 3 DRIVE config is accessible
  try {
    const testFn = this['getFolder_'];
    checks.push(testFn ? '✅ Phase 3 Drive functions accessible' : '⚠️  Phase 3 not loaded — save Drive folder to order folder will be skipped');
  } catch(e) {
    checks.push('⚠️  Phase 3 not loaded — ensure Phase3_Drive.gs is in the same project');
  }

  // Add INVOICE # column header to ORDERS if not present
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(INV_CONFIG.sheet);
  if (ordSh) {
    const invColHeader = ordSh.getRange(2, 44);
    if (!invColHeader.getValue()) {
      invColHeader.setValue('INVOICE #')
                  .setBackground('#0D0D0D')
                  .setFontColor('#C9A84C')
                  .setFontWeight('bold')
                  .setFontSize(8)
                  .setHorizontalAlignment('center')
                  .setVerticalAlignment('middle')
                  .setWrap(true);
      ordSh.setColumnWidth(44, 130);
      checks.push('✅ INVOICE # column (AR) added to ORDERS sheet');
    } else {
      checks.push('✅ INVOICE # column already present');
    }
  }

  invLog_('SYSTEM', 'activateInvoiceSystem', 'Invoice system activated', checks.join(' | '));
  ui.alert('✅ Alma Lifestyle Invoice System\n\nActivation complete:\n\n' + checks.join('\n') +
    '\n\nTo generate invoices automatically, add the hook call to onOrderDelivered_() in Code.gs.\n' +
    'See HOOK INTEGRATION comment in Phase4_Invoice.gs for instructions.');
}

// ═══════════════════════════════════════════════════════════════════════════
// INVOICE NUMBER ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns the next invoice number as "AL-INV-YYYY-NNNN".
 * Uses Script Properties as an atomic counter — safe for single-user Sheets.
 * Each calendar year resets to 0001 automatically.
 *
 * @param {boolean} [increment=true]  pass false to peek without advancing
 * @returns {string}
 */
function getNextAlInvoiceNumber_(increment) {
  const year  = new Date().getFullYear().toString();
  const key   = INV_CONFIG.counterKey + year;
  const props = PropertiesService.getScriptProperties();
  const cur   = parseInt(props.getProperty(key) || '0', 10);
  const next  = cur + 1;
  if (increment !== false) props.setProperty(key, next.toString());
  const seq   = next.toString().padStart(INV_CONFIG.number.pad, '0');
  return `${INV_CONFIG.number.prefix}-${year}-${seq}`;
}

/**
 * Peek at the next invoice number without incrementing.
 */
function peekAlInvoiceNumber() {
  const year  = new Date().getFullYear().toString();
  const key   = INV_CONFIG.counterKey + year;
  const cur   = parseInt(PropertiesService.getScriptProperties().getProperty(key) || '0', 10);
  const seq   = (cur + 1).toString().padStart(INV_CONFIG.number.pad, '0');
  return `${INV_CONFIG.number.prefix}-${year}-${seq}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE PROTECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Checks whether an invoice has already been generated for this order.
 * Reads column AR (44) in the ORDERS sheet — if non-empty, invoice exists.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} ordSh
 * @param {number} row
 * @returns {string|false}  existing invoice number, or false if none
 */
function existingInvoiceNumber_(ordSh, row) {
  const val = ordSh.getRange(row, 44).getValue();
  return val ? val.toString() : false;
}

/**
 * Validates minimum row data required for a legal invoice (matches ERP + GAS).
 * @param {Object} order — normalized order object from rowData
 * @param {string} orderIdStr
 * @returns {{ok:true}|{ok:false,missing:string}}
 */
function validateOrderForInvoice_(order, orderIdStr) {
  const customer = String(order.customer || '').trim()
  const phone = String(order.phone || '').replace(/\D/g, '').trim()
  const address = String(order.address || '').trim()
  const product = String(order.product || '').trim()
  const payment = String(order.payment || '').trim()
  const qty = Number(order.qty || 0)
  let sell = Number(order.sellPrice || 0)
  if (!(sell > 0)) {
    sell =
      Number(order.unitPrice || 0) * Number(order.qty || 0) -
      Number(order.discount || 0) -
      Number(order.addDiscount || 0)
  }
  const missing = []
  if (!String(orderIdStr || '').trim()) missing.push('order_id')
  if (!customer) missing.push('customer')
  if (!phone) missing.push('phone')
  if (!address) missing.push('address')
  if (!product) missing.push('product')
  if (!(qty > 0)) missing.push('qty')
  if (!(sell > 0)) missing.push('sell_price')
  if (!payment) missing.push('payment')
  return missing.length ? { ok: false, missing: missing.join(', ') } : { ok: true }
}

/** Public web view URL for a Drive file (PDF opens in browser, shareable). */
function buildDriveViewShareUrl_(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view?usp=sharing'
}

/** Safe segment for Invoice-ORDER_ID.pdf filename. */
function sanitizeInvoicePdfBaseName_(orderId) {
  const s = String(orderId || 'ORDER').replace(/[^a-zA-Z0-9\-_.]/g, '')
  return (s || 'ORDER').substring(0, 64)
}

function getOrCreateAlmaErpInvoicesFolder_() {
  const props = PropertiesService.getScriptProperties()
  const key = INV_CONFIG.scriptPropAlmaInvoicesFolderId || 'ALMA_ERP_INVOICES_FOLDER_ID'
  const existingId = props.getProperty(key)
  if (existingId) {
    try {
      const f = DriveApp.getFolderById(existingId)
      return f
    } catch (e) {
      invLog_('INVOICE_FOLDER', '', 'Cached Alma ERP Invoices folder invalid — recreating. ' + e.message, existingId)
      props.deleteProperty(key)
    }
  }
  const root = DriveApp.getRootFolder()
  const name = INV_CONFIG.almaInvoicesFolderName || 'Alma ERP Invoices'
  const it = root.getFoldersByName(name)
  if (it.hasNext()) {
    const folder = it.next()
    props.setProperty(key, folder.getId())
    invLog_('INVOICE_FOLDER', name, 'Found existing folder', folder.getId())
    return folder
  }
  const created = root.createFolder(name)
  props.setProperty(key, created.getId())
  invLog_('INVOICE_FOLDER', name, 'Created folder in My Drive root', created.getId())
  return created
}

/** Anyone with the link can view (required for WhatsApp / external share). */
function applyAnyoneWithLinkView_(file) {
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
  } catch (e) {
    invLog_('SHARE_WARN', file.getName(), e.message, file.getId())
  }
}

/** If a PDF already exists for this order, return a fresh share URL (duplicate flow). */
function findShareUrlForInvoicePdf_(orderId) {
  try {
    const folder = getOrCreateAlmaErpInvoicesFolder_()
    const name = 'Invoice-' + sanitizeInvoicePdfBaseName_(orderId) + '.pdf'
    const files = folder.getFilesByName(name)
    if (files.hasNext()) {
      const f = files.next()
      applyAnyoneWithLinkView_(f)
      return buildDriveViewShareUrl_(f.getId())
    }
  } catch (e) {
    invLog_('INVOICE_LOOKUP', String(orderId), e.message, '')
  }
  return ''
}

// ═══════════════════════════════════════════════════════════════════════════
// MASTER INVOICE GENERATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates, saves, and indexes a branded PDF invoice for a delivered order.
 *
 * SAFE:
 *   • Reads rowData directly — no sheet re-fetch
 *   • Duplicate check before issuing invoice number
 *   • Invoice number only increments after successful PDF save
 *   • On failure returns { error: string } (never throws)
 *
 * @param {number} row         - 1-based row number in ORDERS sheet
 * @param {Array}  rowData     - full row values array (0-indexed)
 * @returns {{invoiceNumber:string, fileUrl:string, fileName:string}|{error:string}}
 */
function generateInvoice(row, rowData) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(INV_CONFIG.sheet);
  if (!ordSh) {
    const msg = 'Orders sheet not found: ' + INV_CONFIG.sheet;
    invLog_('CONFIG', '', msg, '');
    return { error: msg };
  }

  const c       = INV_CONFIG.col;
  const orderId = rowData[c.ORDER_ID - 1];
  if (!orderId) {
    const msg = 'Order row has no ORDER_ID (column A) — fix the sheet formula or refresh.';
    invLog_('VALIDATION', '', msg, 'row ' + row);
    return { error: msg };
  }

  // ── Duplicate protection ─────────────────────────────────────────────────
  const existing = existingInvoiceNumber_(ordSh, row)
  if (existing) {
    const reuseUrl = findShareUrlForInvoicePdf_(String(orderId))
    invLog_('SKIP', orderId, 'Invoice already exists: ' + existing + ' | pdfUrl=' + (reuseUrl || 'none'), 'Row ' + row)
    return {
      invoiceNumber: existing,
      fileUrl:       reuseUrl,
      fileName:      'Invoice-' + sanitizeInvoicePdfBaseName_(String(orderId)) + '.pdf',
      duplicate:     true,
    }
  }

  // ── Extract order fields ─────────────────────────────────────────────────
  const order = {
    id:           orderId,
    date:         rowData[c.DATE - 1],
    customer:     rowData[c.CUSTOMER - 1]      || '',
    phone:        rowData[c.PHONE - 1]         || '',
    address:      rowData[c.ADDRESS - 1]       || '',
    payment:      rowData[c.PAYMENT - 1]       || '',
    product:      rowData[c.PRODUCT - 1]       || '',
    category:     rowData[c.CATEGORY - 1]      || '',
    size:         rowData[c.SIZE - 1]          || '',
    sku:          rowData[c.SKU - 1]           || '',
    qty:          rowData[c.QTY - 1]           || 1,
    unitPrice:    rowData[c.UNIT_PRICE - 1]    || 0,
    discount:     rowData[c.DISCOUNT - 1]      || 0,
    addDiscount:  rowData[c.ADD_DISCOUNT - 1]  || 0,
    sellPrice:    rowData[c.SELL_PRICE - 1]    || 0,
    shippingFee:  rowData[c.SHIP_COLLECTED - 1]|| 0,
    courier:      rowData[c.COURIER - 1]       || '',
    trackingId:   rowData[c.TRACKING_ID - 1]   || '',
    deliveryDate: rowData[c.ACTUAL_DELIVERY - 1]|| new Date(),
    notes:        rowData[c.NOTES - 1]         || '',
    status:       String(rowData[c.STATUS - 1] || '').trim() || 'Pending',
  }

  const check = validateOrderForInvoice_(order, String(orderId));
  if (!check.ok) {
    invLog_('VALIDATION', orderId, 'Missing: ' + check.missing, '');
    return { error: 'Missing invoice data: ' + check.missing };
  }

  // ── Issue invoice number ──────────────────────────────────────────────────
  const invoiceNumber = getNextAlInvoiceNumber_(true);
  const issuedDate    = new Date();

  // ── Build HTML ────────────────────────────────────────────────────────────
  const html = buildInvoiceHtml_(order, invoiceNumber, issuedDate);

  // ── Convert to PDF blob ───────────────────────────────────────────────────
  let pdfBlob;
  try {
    pdfBlob = htmlToPdfBlob_(html, invoiceNumber);
  } catch (e) {
    invLog_('PDF_ERROR', orderId, e.message, invoiceNumber);
    const year = issuedDate.getFullYear().toString();
    const key  = INV_CONFIG.counterKey + year;
    const cur  = parseInt(PropertiesService.getScriptProperties().getProperty(key) || '1', 10);
    PropertiesService.getScriptProperties().setProperty(key, (cur - 1).toString());
    return {
      error:
        'PDF conversion failed: ' +
        e.message +
        ' — Enable Apps Script “Drive API” advanced service, or check execution log (PDF_DRIVE_API / PDF_HTMLSERVICE).',
    };
  }

  // ── Save to Drive ─────────────────────────────────────────────────────────
  const fileName = 'Invoice-' + sanitizeInvoicePdfBaseName_(String(order.id)) + '.pdf';
  pdfBlob.setName(fileName);

  const fileUrl = savePdfToDrive_(pdfBlob, fileName, order, issuedDate);
  if (!fileUrl) {
    const detail =
      'Could not save PDF to Google Drive. Check script execution permissions, Drive quota, and 🤖 AUTOMATION LOG (SAVE_ERROR_ALMA / SAVE_FATAL).';
    invLog_('SAVE_ERROR', orderId, detail, invoiceNumber);
    const year = issuedDate.getFullYear().toString();
    const key  = INV_CONFIG.counterKey + year;
    const cur  = parseInt(PropertiesService.getScriptProperties().getProperty(key) || '1', 10);
    PropertiesService.getScriptProperties().setProperty(key, (cur - 1).toString());
    return { error: detail };
  }

  // ── Write invoice number back to ORDERS row ───────────────────────────────
  ordSh.getRange(row, 44).setValue(invoiceNumber)
       .setFontColor('#8B6914')
       .setFontWeight('bold')
       .setHorizontalAlignment('center');

  // ── Log ───────────────────────────────────────────────────────────────────
  invLog_('GENERATED', invoiceNumber,
    `${order.customer} | ৳${order.sellPrice + order.shippingFee} | ${order.id}`,
    fileUrl);

  return { invoiceNumber, fileUrl, fileName, duplicate: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML INVOICE BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds the complete HTML document for the invoice.
 * Uses inline CSS throughout — required for PDF rendering via Drive API.
 */
function buildInvoiceHtml_(order, invoiceNumber, issuedDate) {
  const b = INV_CONFIG.brand;
  const f = INV_CONFIG.footer;

  const subTotal    = (order.unitPrice * order.qty) - order.discount - order.addDiscount;
  const grandTotal  = subTotal + order.shippingFee;
  const hasLogo     = b.logoUrl && b.logoUrl !== 'PASTE_LOGO_URL_HERE';
  const delivDate   = order.deliveryDate instanceof Date
    ? formatDateStr_(order.deliveryDate) : order.deliveryDate || '\u2014';
  const orderDate   = order.date instanceof Date
    ? formatDateStr_(order.date) : order.date || '\u2014';
  const issuedStr   = formatDateStr_(issuedDate);
  const generatedAt = formatDateTimeStr_(issuedDate);
  const hasDiscount = order.discount > 0 || order.addDiscount > 0;
  const totalDiscount = order.discount + order.addDiscount;

  const statusLabel = String(order.status || 'Pending').trim() || 'Pending';
  const st = statusLabel.toLowerCase();
  const badgeExtra =
    /delivered|complete|paid/.test(st) ? 'badge-delivered' :
      /cancel|refund/.test(st) ? 'badge-cancelled' : 'badge-pending';

  const metaParts = [];
  if (order.sku)      metaParts.push(order.sku);
  if (order.size)     metaParts.push('Size ' + order.size);
  if (order.category) metaParts.push(order.category);
  const productMeta = metaParts.join(' / ');

  const BG   = '#060608';
  const CARD = '#101018';
  const GOLD = '#c9a84c';
  const GOLD2 = '#8b7340';
  const MUTED = '#9a968c';
  const TEXT = '#f2f0ea';
  const LINE = 'rgba(201, 168, 76, 0.22)';

  const css = `
    @page { size: A4; margin: 12mm; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Georgia, serif;
      font-size: 10pt;
      color: ${TEXT};
      background: ${BG};
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .wrap { max-width: 190mm; margin: 0 auto; }
    .rim { border: 1px solid ${LINE}; border-radius: 12px; overflow: hidden; background: ${CARD}; }
    .hb {
      display: table; width: 100%;
      background: linear-gradient(135deg, #0b0b10 0%, #14101a 55%, #101018 100%);
      padding: 22px 26px;
    }
    .hbl { display: table-cell; width: 58%; vertical-align: middle; }
    .hbr { display: table-cell; vertical-align: bottom; text-align: right; }
    .logo { max-height: 52px; width: auto; }
    .bn { font-size: 20pt; font-weight: 700; color: ${GOLD}; letter-spacing: 0.06em; }
    .tg { font-size: 7pt; color: ${GOLD2}; text-transform: uppercase; letter-spacing: 0.22em; margin-top: 6px; }
    .lw { font-size: 7pt; color: ${MUTED}; text-transform: uppercase; letter-spacing: 0.25em; }
    .inv { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 16pt; font-weight: 700; color: ${TEXT}; margin-top: 4px; }
    .dt { font-size: 8pt; color: ${MUTED}; margin-top: 6px; }
    .gen { font-size: 7.5pt; color: ${GOLD2}; margin-top: 4px; }
    .badge {
      display: inline-block; margin-top: 10px; padding: 5px 12px; border-radius: 999px;
      font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em;
      border: 1px solid ${LINE};
    }
    .badge-pending { background: rgba(201, 168, 76, 0.12); color: ${GOLD}; }
    .badge-delivered { background: rgba(34, 160, 107, 0.15); color: #7dffc4; }
    .badge-cancelled { background: rgba(220, 80, 80, 0.14); color: #ffb4b4; }
    .bar { height: 3px; background: linear-gradient(90deg, ${GOLD}, rgba(201, 168, 76, 0.25)); }
    .cont { padding: 22px 26px 26px; }
    .grid { display: table; width: 100%; margin-bottom: 22px; }
    .gc { display: table-cell; vertical-align: top; width: 50%; padding-right: 14px; }
    .gc2 { display: table-cell; vertical-align: top; width: 50%; padding-left: 14px; }
    .lbl {
      font-size: 6.5pt; font-weight: 700; color: ${GOLD2}; letter-spacing: 0.18em; text-transform: uppercase;
      margin-bottom: 10px; display: block; border-bottom: 1px solid ${LINE}; padding-bottom: 6px;
    }
    .nm { font-size: 14pt; font-weight: 700; margin: 10px 0 10px; color: ${TEXT}; }
    .row { display: table; width: 100%; margin-bottom: 5px; font-size: 8.5pt; }
    .k { display: table-cell; width: 92px; color: ${MUTED}; vertical-align: top; }
    .v { display: table-cell; font-weight: 600; color: ${TEXT}; vertical-align: top; }
    .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
    .tbl { width: 100%; border-collapse: collapse; margin-top: 8px; margin-bottom: 14px; }
    .tbl th {
      font-size: 6.5pt; text-transform: uppercase; letter-spacing: 0.12em; color: ${MUTED};
      text-align: left; padding: 10px 8px; border-bottom: 1px solid ${LINE};
    }
    .tbl th.r, .tbl td.r { text-align: right; }
    .tbl td {
      padding: 12px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 9.5pt; vertical-align: top; color: ${TEXT};
    }
    .pn { font-weight: 700; font-size: 10.5pt; }
    .pm { font-size: 7.5pt; color: ${MUTED}; margin-top: 4px; display: block; }
    .tot { display: table; width: 100%; }
    .tsp { display: table-cell; width: 52%; }
    .tin { display: table-cell; width: 48%; vertical-align: top; }
    .tr { display: table; width: 100%; font-size: 8.5pt; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
    .tl { display: table-cell; padding: 7px 0; color: ${MUTED}; }
    .tv { display: table-cell; padding: 7px 0; text-align: right; font-weight: 700; }
    .tv-red { color: #ff8a8a; }
    .grand {
      margin-top: 10px; padding: 14px 16px;
      background: linear-gradient(90deg, rgba(201, 168, 76, 0.18), rgba(201, 168, 76, 0.05));
      border: 1px solid ${LINE}; border-radius: 10px; display: table; width: 100%;
    }
    .gl { display: table-cell; font-size: 7pt; font-weight: 800; color: ${GOLD}; letter-spacing: 0.18em; text-transform: uppercase; vertical-align: middle; }
    .gv { display: table-cell; text-align: right; font-size: 17pt; font-weight: 800; color: ${TEXT}; vertical-align: middle; }
    .pay {
      margin-top: 18px; padding: 14px 16px; border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.25); display: table; width: 100%;
    }
    .pc { display: table-cell; vertical-align: top; width: 34%; padding-right: 10px; }
    .ps { font-size: 6.5pt; color: ${MUTED}; text-transform: uppercase; letter-spacing: 0.14em; }
    .pv { font-size: 10.5pt; font-weight: 700; margin-top: 4px; color: ${TEXT}; }
    .foot {
      padding: 18px 26px 22px; border-top: 1px solid ${LINE}; text-align: center; background: rgba(0, 0, 0, 0.35);
    }
    .fb { font-weight: 700; color: ${GOLD}; letter-spacing: 0.12em; text-transform: uppercase; font-size: 11pt; }
    .fp { font-size: 7.5pt; color: ${MUTED}; margin-top: 6px; max-width: 140mm; margin-left: auto; margin-right: auto; }
    .fm { font-size: 6.5pt; color: ${GOLD2}; margin-top: 10px; }
  `;

  const logoBlock = hasLogo
    ? `<img src="${b.logoUrl}" class="logo" alt="${escapeHtml_(b.name)}" />`
    : `<span class="bn">${escapeHtml_(b.name)}</span>`;

  const trackingRow = order.trackingId
    ? `<div class="row"><span class="k">Tracking</span><span class="v mono">${escapeHtml_(String(order.trackingId))}</span></div>`
    : '';

  const discountRow = hasDiscount
    ? `<div class="tr"><span class="tl">Discount</span><span class="tv tv-red">\u2212\u09F3${fmtNum_(totalDiscount)}</span></div>`
    : '';

  const shippingRow = order.shippingFee > 0
    ? `<div class="tr"><span class="tl">Delivery</span><span class="tv mono">\u09F3${fmtNum_(order.shippingFee)}</span></div>`
    : '';

  const notesBlock = order.notes
    ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid ${LINE}"><div class="lbl" style="border:0;padding:0;margin-bottom:6px">Notes</div><div style="font-size:8.5pt;color:${MUTED};font-style:italic">${escapeHtml_(order.notes.toString())}</div></div>`
    : '';

  const discountTh = hasDiscount ? `<th class="r" style="width:15%">Discount</th>` : '';
  const discountTd = hasDiscount
    ? `<td class="r"><span class="tv-red">\u2212\u09F3${fmtNum_(totalDiscount)}</span></td>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml_(invoiceNumber)}</title>
  <style>${css}</style>
</head>
<body>
<div class="wrap">
  <div class="rim">
    <div class="hb">
      <div class="hbl">${logoBlock}<div class="tg">${escapeHtml_(b.tagline)}</div></div>
      <div class="hbr">
        <div class="lw">Invoice</div>
        <div class="inv">${escapeHtml_(invoiceNumber)}</div>
        <div class="dt">Issued ${escapeHtml_(issuedStr)}</div>
        <div class="gen">Generated ${escapeHtml_(generatedAt)}</div>
        <span class="badge ${badgeExtra}">${escapeHtml_(statusLabel)}</span>
      </div>
    </div>
    <div class="bar"></div>
    <div class="cont">
      <div class="grid">
        <div class="gc">
          <span class="lbl">Bill to</span>
          <div class="nm">${escapeHtml_(order.customer)}</div>
          <div class="row"><span class="k">Phone</span><span class="v mono">${escapeHtml_(order.phone.toString())}</span></div>
          <div class="row"><span class="k">Address</span><span class="v">${escapeHtml_(order.address)}</span></div>
        </div>
        <div class="gc2">
          <span class="lbl">Order</span>
          <div class="row" style="margin-top:10px"><span class="k">Order ID</span><span class="v mono">${escapeHtml_(String(order.id))}</span></div>
          <div class="row"><span class="k">Order date</span><span class="v">${escapeHtml_(String(orderDate))}</span></div>
          <div class="row"><span class="k">Delivered</span><span class="v">${escapeHtml_(String(delivDate))}</span></div>
          <div class="row"><span class="k">Courier</span><span class="v">${escapeHtml_(order.courier) || '\u2014'}</span></div>
          ${trackingRow}
        </div>
      </div>
      <span class="lbl">Line items</span>
      <table class="tbl">
        <thead><tr>
          <th style="width:46%">Product</th>
          <th class="r">Unit</th>
          <th class="r">Qty</th>
          <th class="r">Subtotal</th>
          ${discountTh}
        </tr></thead>
        <tbody><tr>
          <td>
            <span class="pn">${escapeHtml_(order.product)}</span>
            ${productMeta ? `<span class="pm">${escapeHtml_(productMeta)}</span>` : ''}
          </td>
          <td class="r mono">\u09F3${fmtNum_(order.unitPrice)}</td>
          <td class="r mono">${order.qty}</td>
          <td class="r mono">\u09F3${fmtNum_(order.unitPrice * order.qty)}</td>
          ${discountTd}
        </tr></tbody>
      </table>
      <div class="tot">
        <div class="tsp"></div>
        <div class="tin">
          <div class="tr"><span class="tl">Item total</span><span class="tv mono">\u09F3${fmtNum_(order.unitPrice * order.qty)}</span></div>
          ${discountRow}
          ${shippingRow}
          <div class="grand">
            <span class="gl">Total payable</span>
            <span class="gv mono">\u09F3${fmtNum_(grandTotal)}</span>
          </div>
        </div>
      </div>
      <div class="pay">
        <div class="pc"><div class="ps">Payment method</div><div class="pv">${escapeHtml_(order.payment)}</div></div>
        <div class="pc"><div class="ps">Order status</div><div class="pv">${escapeHtml_(statusLabel)}</div></div>
        <div class="pc"><div class="ps">Amount received</div><div class="pv mono">\u09F3${fmtNum_(grandTotal)}</div></div>
      </div>
      ${notesBlock}
    </div>
    <div class="foot">
      <div class="fb">${escapeHtml_(b.name)}</div>
      <div class="fp">${escapeHtml_(f.policy)}</div>
      <div class="fm">${escapeHtml_(f.thankYou)} · ${escapeHtml_(f.note)} · ${escapeHtml_(invoiceNumber)} · ${escapeHtml_(generatedAt)}</div>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF CONVERSION via Drive API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Converts an HTML string to a PDF blob using Google Drive's conversion API.
 * Creates a temporary Google Doc, exports it as PDF, then deletes the temp file.
 *
 * This approach preserves CSS styling better than the Sheets export method.
 *
 * @param {string} html
 * @param {string} invoiceNumber  — used as the temp file name
 * @returns {GoogleAppsScript.Base.Blob}
 */
function htmlToPdfBlob_(html, invoiceNumber) {
  const tempFileName = `__TEMP_INVOICE_${invoiceNumber}`;

  // Prefer Drive Advanced Service (better CSS fidelity) when enabled in the Apps Script project.
  if (typeof Drive !== 'undefined' && Drive.Files && typeof Drive.Files.insert === 'function') {
    try {
      const blob = Utilities.newBlob(html, MimeType.HTML, tempFileName + '.html');
      const file = Drive.Files.insert(
        { title: tempFileName, mimeType: MimeType.GOOGLE_DOCS },
        blob,
        { convert: true }
      );
      Utilities.sleep(2500);
      const pdfBlob = DriveApp.getFileById(file.id).getAs(MimeType.PDF).copyBlob();
      try {
        Drive.Files.remove(file.id);
      } catch (removeErr) {
        invLog_('PDF_WARN', '', 'Temp Doc cleanup failed: ' + removeErr.message, String(file.id));
      }
      return pdfBlob;
    } catch (e) {
      invLog_('PDF_DRIVE_API', invoiceNumber, e.message, (e.stack || '').substring(0, 500));
    }
  } else {
    invLog_('PDF_DRIVE_API', invoiceNumber, 'Drive.Files not available — enable Drive API in Services', '');
  }

  // Fallback: no Advanced Service required; works with default Apps Script + Drive.
  try {
    const pdfBlob = HtmlService.createHtmlOutput(html).getAs(MimeType.PDF);
    invLog_('PDF_HTMLSERVICE', invoiceNumber, 'PDF generated via HtmlService fallback', '');
    return pdfBlob;
  } catch (e2) {
    invLog_('PDF_HTMLSERVICE', invoiceNumber, e2.message, (e2.stack || '').substring(0, 500));
    throw new Error('PDF conversion failed (Drive API + HtmlService): ' + e2.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DRIVE SAVE LOGIC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Saves the PDF to "Alma ERP Invoices" (auto-created), applies link sharing,
 * and returns a public /view URL. Falls back to legacy invoice + order paths, then Drive root.
 *
 * @param {GoogleAppsScript.Base.Blob} pdfBlob
 * @param {string} fileName
 * @param {Object} order
 * @param {Date}   issuedDate
 * @returns {string|null}
 */
function savePdfToDrive_(pdfBlob, fileName, order, issuedDate) {
  const year  = issuedDate.getFullYear().toString();
  const month = Utilities.formatDate(issuedDate, Session.getScriptTimeZone(), 'MMM');

  let shareUrl = null;

  // ── 1. Primary: Alma ERP Invoices (shareable web view URL) ───────────────
  try {
    const folder = getOrCreateAlmaErpInvoicesFolder_();
    const blob = pdfBlob.copyBlob();
    blob.setName(fileName);
    const saved = folder.createFile(blob);
    applyAnyoneWithLinkView_(saved);
    shareUrl = buildDriveViewShareUrl_(saved.getId());
    if (typeof indexDocument_ === 'function') {
      indexDocument_('INVOICE', order.id, shareUrl, order.customer, 'Alma ERP Invoices/' + fileName);
    }
    invLog_('SAVED_ALMA_INVOICES', order.id, 'Alma ERP Invoices', shareUrl);
  } catch (e) {
    invLog_('SAVE_ERROR_ALMA', order.id, e.message, fileName);
  }

  // ── 2. Legacy archive: 06_Invoices / Year / Month (internal, optional) ─────
  if (typeof getFolder_ === 'function') {
    try {
      const invRootFolder = getFolder_('INVOICES');
      if (invRootFolder) {
        const monthFolder = navigatePath_(invRootFolder, [year, month]);
        if (monthFolder) {
          const b = pdfBlob.copyBlob();
          b.setName(fileName);
          monthFolder.createFile(b);
          invLog_('SAVED_INVOICES_LEGACY', order.id, 'Invoices/' + year + '/' + month + '/', '');
        }
      }
    } catch (e2) {
      invLog_('SAVE_ERROR_INVOICES', order.id, e2.message, fileName);
    }
  }

  // ── 3. Copy: Orders / Year / Month / OrderID / Invoice ───────────────────
  if (typeof getFolder_ === 'function') {
    try {
      const ordersRootFolder = getFolder_('ORDERS');
      if (ordersRootFolder) {
        const orderDate = order.date instanceof Date ? order.date : issuedDate;
        const oYear  = orderDate.getFullYear().toString();
        const oMonth = Utilities.formatDate(orderDate, Session.getScriptTimeZone(), 'MMM');
        const orderInvFolder = navigatePath_(ordersRootFolder, [oYear, oMonth, order.id, 'Invoice']);
        if (orderInvFolder) {
          const b2 = pdfBlob.copyBlob();
          b2.setName(fileName);
          orderInvFolder.createFile(b2);
          invLog_('SAVED_ORDER_COPY', order.id, 'Orders/' + oYear + '/' + oMonth + '/' + order.id + '/Invoice/', '');
        }
      }
    } catch (e3) {
      invLog_('SAVE_ERROR_ORDER_COPY', order.id, e3.message, '');
    }
  }

  // ── Last resort: My Drive root + link sharing ─────────────────────────────
  if (!shareUrl) {
    try {
      const emergency = pdfBlob.copyBlob();
      emergency.setName(fileName);
      const f = DriveApp.createFile(emergency);
      applyAnyoneWithLinkView_(f);
      shareUrl = buildDriveViewShareUrl_(f.getId());
      invLog_('SAVED_DRIVEAPP_ROOT', order.id, 'Fallback: My Drive root', shareUrl);
    } catch (eRoot) {
      invLog_('SAVE_FATAL', order.id, eRoot.message, fileName);
    }
  }

  return shareUrl;
}

// ═══════════════════════════════════════════════════════════════════════════
// HOOK INTEGRATION — Add this to Phase 2 (Code.gs) onOrderDelivered_()
// ═══════════════════════════════════════════════════════════════════════════
/*
  INSTRUCTIONS:
  Open Code.gs. Find onOrderDelivered_(). At the very end of that function,
  add the following two lines:

    // Phase 4 — Invoice generation
    generateInvoice(row, rowData);

  That's it. The invoice system handles everything else:
  duplicate check, PDF generation, Drive save, and writing the
  invoice number back to column AR of the ORDERS sheet.
*/

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate an invoice manually for any order ID.
 * Access via ⚡ menu → 🧾 Generate Invoice (Manual)
 */
function generateInvoiceManualPhase4() {
  const ui    = SpreadsheetApp.getUi();
  const resp  = ui.prompt('Generate Invoice', 'Enter Order ID (e.g. AL-0007):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const target = resp.getResponseText().trim();
  if (!target) return;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(INV_CONFIG.sheet);
  if (!ordSh) { ui.alert('❌ ORDERS sheet not found.'); return; }

  const data = ordSh.getDataRange().getValues();
  let foundRow = -1, rowData = null;

  for (let i = 2; i < data.length; i++) {
    if (data[i][0] === target) { foundRow = i + 1; rowData = data[i]; break; }
  }

  if (foundRow === -1) { ui.alert(`❌ Order "${target}" not found.`); return; }

  const result = generateInvoice(foundRow, rowData);

  if (result.error) {
    ui.alert('❌ ' + result.error);
  } else if (result.duplicate) {
    var dupMsg = 'ℹ️ Invoice already exists for ' + target + '.\n\nInvoice #: ' + result.invoiceNumber;
    if (result.fileUrl) dupMsg += '\n\nPDF (shareable):\n' + result.fileUrl;
    else dupMsg += '\n\n(No matching PDF in Alma ERP Invoices folder — check Drive or regenerate after fixing.)';
    ui.alert(dupMsg);
  } else {
    ui.alert('✅ Invoice generated!\n\nInvoice #: ' + result.invoiceNumber + '\nFile: ' + result.fileName + '\n\nSaved to folder "Alma ERP Invoices".\n\n' + (result.fileUrl || ''));
  }
}

/**
 * Batch-generate invoices for all Delivered orders that don't yet have one.
 * Access via ⚡ menu → ⬇️ Backfill Invoices
 */
function backfillInvoices() {
  const ui    = SpreadsheetApp.getUi();
  const conf  = ui.alert('Backfill Invoices',
    'This will generate invoices for all Delivered orders without one.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (conf !== ui.Button.YES) return;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(INV_CONFIG.sheet);
  if (!ordSh) return;

  const data = ordSh.getDataRange().getValues();
  let generated = 0, skipped = 0, errors = 0;

  for (let i = 2; i < data.length; i++) {
    const orderId = data[i][0];
    if (!orderId) continue;

    const status  = data[i][INV_CONFIG.col.STATUS - 1];
    if (status !== 'Delivered') { skipped++; continue; }

    const result = generateInvoice(i + 1, data[i]);
    if (result.error) {
      errors++;
    } else if (result.duplicate || !result.fileUrl) {
      skipped++;
    } else {
      generated++;
    }

    Utilities.sleep(1500); // Drive API rate limit
  }

  ui.alert(`✅ Backfill complete.\n\nGenerated: ${generated}\nAlready had invoice: ${skipped}\nErrors: ${errors}\n\nCheck 🤖 AUTOMATION LOG for details.`);
}

/**
 * Preview what the next invoice number will be.
 */
function previewNextInvoiceNumber() {
  SpreadsheetApp.getUi().alert(
    `Next invoice number: ${peekAlInvoiceNumber()}\n\n` +
    `(This number is assigned on the next invoice generation.)`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function fmtNum_(n) {
  const num = parseFloat(n) || 0;
  return num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDateStr_(date) {
  if (!(date instanceof Date)) return date ? date.toString() : '—';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd MMM yyyy');
}

function formatDateTimeStr_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return String(date || '\u2014');
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "dd MMM yyyy '\u00b7' HH:mm zzz");
}

function sanitizeForFileName_(str) {
  return (str || 'Customer').toString()
    .replace(/[^a-zA-Z0-9\u0980-\u09FF _-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 40);
}

function escapeHtml_(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Invoice-specific logger. Writes to 🤖 AUTOMATION LOG.
 */
function invLog_(eventType, reference, message, detail) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const logSh = ss.getSheetByName('🤖 AUTOMATION LOG');
    if (!logSh) return;

    const row = logSh.getLastRow() + 1;
    logSh.getRange(row, 1, 1, 5).setValues([[
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      '[INV] ' + eventType,
      reference ? reference.toString() : '',
      message   ? message.toString()   : '',
      detail    ? detail.toString().substring(0, 400) : '',
    ]]);
    if (eventType === 'GENERATED') logSh.getRange(row, 1, 1, 5).setBackground('#E8F5E9');
    if (eventType.includes('ERROR')) logSh.getRange(row, 1, 1, 5).setBackground('#FFEBEE');
    if (eventType === 'SKIP') logSh.getRange(row, 1, 1, 5).setBackground('#FFF9C4');
  } catch (e) { console.error('invLog_ failed:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// MENU — Replace onOpen() in Code.gs with this combined version
// OR add the sub-menu items to your existing onOpen() by including:
//   onOpenInvoiceMenu_(menu);  before  .addToUi()
// ═══════════════════════════════════════════════════════════════════════════

function onOpenInvoiceMenu_(existingMenu) {
  return existingMenu
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🧾 Invoices')
      .addItem('🧾 Generate Invoice (Manual)', 'generateInvoiceManualPhase4')
      .addItem('⬇️ Backfill All Delivered Orders', 'backfillInvoices')
      .addItem('🔢 Preview Next Invoice Number', 'previewNextInvoiceNumber')
      .addSeparator()
      .addItem('⚙️ Activate Invoice System', 'activateInvoiceSystem'));
}

/**
 * COMBINED onOpen() — paste this into Code.gs, replacing the existing one.
 * Includes Phase 2, Phase 3, and Phase 4 menu items.
 */
function onOpen() {
  const ui   = SpreadsheetApp.getUi();
  const menu = ui.createMenu('⚡ Alma ERP Automation')
    .addItem('🔄 Refresh SLA Status',       'runManualSLARefresh')
    .addItem('📧 Send Test Daily Email',     'testDailySummaryEmail')
    .addItem('📊 View Log Summary',          'viewLogSummary')
    .addSeparator()
    .addItem('⬇️ Backfill Orders (SLA)',     'backfillAllOrders')
    .addSeparator();

  if (typeof onOpenPhase3Menu_ === 'function') onOpenPhase3Menu_(menu);
  onOpenInvoiceMenu_(menu);

  menu.addSeparator()
      .addItem('✅ Install All Triggers',    'installTriggers')
      .addItem('⛔ Emergency Stop',          'emergencyStop')
      .addToUi();
}