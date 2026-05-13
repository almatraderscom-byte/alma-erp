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
 *   • Saves to Drive: 06_Invoices / Year / Month / AL-INV-YYYY-NNNN.pdf
 *   • Also copies into the order's own Drive folder (Orders/Year/Month/OrderID/Invoice/)
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
 *   • All errors caught and logged — never throws to caller
 *
 * @param {number} row         - 1-based row number in ORDERS sheet
 * @param {Array}  rowData     - full row values array (0-indexed)
 * @returns {{invoiceNumber:string, fileUrl:string}|null}
 */
function generateInvoice(row, rowData) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ordSh = ss.getSheetByName(INV_CONFIG.sheet);
  if (!ordSh) return null;

  const c       = INV_CONFIG.col;
  const orderId = rowData[c.ORDER_ID - 1];
  if (!orderId) return null;

  // ── Duplicate protection ─────────────────────────────────────────────────
  const existing = existingInvoiceNumber_(ordSh, row);
  if (existing) {
    invLog_('SKIP', orderId, `Invoice already exists: ${existing}`, `Row ${row}`);
    return { invoiceNumber: existing, fileUrl: '', fileName: '' };
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
  };

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
    // Roll back counter on failure
    const year = issuedDate.getFullYear().toString();
    const key  = INV_CONFIG.counterKey + year;
    const cur  = parseInt(PropertiesService.getScriptProperties().getProperty(key) || '1', 10);
    PropertiesService.getScriptProperties().setProperty(key, (cur - 1).toString());
    return null;
  }

  // ── Save to Drive ─────────────────────────────────────────────────────────
  const safeName  = sanitizeForFileName_(order.customer);
  const fileName  = `${invoiceNumber}_${order.id}_${safeName}.pdf`;
  pdfBlob.setName(fileName);

  const fileUrl   = savePdfToDrive_(pdfBlob, fileName, order, issuedDate);
  if (!fileUrl) {
    invLog_('SAVE_ERROR', orderId, 'PDF save to Drive failed', invoiceNumber);
    return null;
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

  return { invoiceNumber, fileUrl, fileName };
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
  const hasDiscount = order.discount > 0 || order.addDiscount > 0;
  const totalDiscount = order.discount + order.addDiscount;

  const metaParts = [];
  if (order.sku)      metaParts.push(order.sku);
  if (order.size)     metaParts.push('Size ' + order.size);
  if (order.category) metaParts.push(order.category);
  const productMeta = metaParts.join('   /   ');

  const BLK  = '#0D0D0D';
  const GOLD = '#C9A84C';
  const GLD2 = '#8B6914';
  const WHT  = '#FFFFFF';
  const GRY1 = '#F7F6F3';
  const GRY2 = '#EBEBEB';
  const GRY3 = '#888888';
  const GRY4 = '#444444';

  const css = `
    @page { size: A4; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 10pt;
      color: ${BLK};
      background-color: ${WHT};
      width: 210mm;
    }
    .hd { background-color: ${BLK}; padding: 32px 44px 28px 44px; }
    .hd-inner { display: table; width: 100%; }
    .hd-logo-cell { display: table-cell; vertical-align: middle; width: 55%; }
    .hd-inv-cell { display: table-cell; vertical-align: bottom; text-align: right; }
    .logo-img { height: 60px; width: auto; }
    .brand-name-text { font-family: Georgia, serif; font-size: 22pt; font-weight: bold; color: ${GOLD}; letter-spacing: 0.05em; }
    .brand-tagline { font-family: Georgia, serif; font-size: 7.5pt; color: #A08840; letter-spacing: 0.20em; text-transform: uppercase; margin-top: 5px; }
    .inv-word { font-family: Georgia, serif; font-size: 8pt; font-weight: bold; color: ${GOLD}; letter-spacing: 0.30em; text-transform: uppercase; }
    .inv-number { font-family: 'Courier New', Courier, monospace; font-size: 15pt; font-weight: bold; color: ${WHT}; letter-spacing: 0.04em; margin-top: 4px; }
    .inv-date { font-family: Georgia, serif; font-size: 7.5pt; color: #888; margin-top: 4px; font-style: italic; }
    .gold-bar { height: 2px; background-color: ${GOLD}; }
    .contact-row { background-color: ${GRY1}; padding: 10px 44px; border-bottom: 1px solid ${GRY2}; }
    .contact-inner { display: table; width: 100%; }
    .contact-cell { display: table-cell; vertical-align: middle; font-size: 7.5pt; color: ${GRY4}; letter-spacing: 0.04em; }
    .contact-label { font-size: 6.5pt; color: ${GLD2}; letter-spacing: 0.14em; text-transform: uppercase; font-weight: bold; display: block; margin-bottom: 1px; }
    .body { padding: 32px 44px; }
    .info-table { width: 100%; border-collapse: collapse; margin-bottom: 32px; }
    .info-bill-cell { width: 52%; vertical-align: top; padding-right: 24px; }
    .info-order-cell { width: 48%; vertical-align: top; }
    .info-section-label { font-size: 6.5pt; font-weight: bold; color: ${GLD2}; letter-spacing: 0.22em; text-transform: uppercase; padding-bottom: 6px; border-bottom: 1px solid ${GOLD}; margin-bottom: 10px; display: block; }
    .info-name { font-family: Georgia, serif; font-size: 13pt; font-weight: bold; color: ${BLK}; margin-top: 10px; margin-bottom: 8px; }
    .info-row { display: table; width: 100%; margin-bottom: 4px; }
    .info-key { display: table-cell; font-size: 7.5pt; color: ${GRY3}; width: 80px; vertical-align: top; padding-top: 1px; }
    .info-val { display: table-cell; font-size: 8.5pt; color: ${BLK}; font-weight: bold; vertical-align: top; }
    .info-val-mono { display: table-cell; font-family: 'Courier New', Courier, monospace; font-size: 8pt; color: ${BLK}; font-weight: bold; vertical-align: top; }
    .items-label { font-size: 6.5pt; font-weight: bold; color: ${GLD2}; letter-spacing: 0.22em; text-transform: uppercase; display: block; padding-bottom: 6px; border-bottom: 1px solid ${GOLD}; margin-bottom: 0; }
    .items-tbl { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
    .items-tbl thead tr { border-bottom: 1px solid ${GRY2}; }
    .items-tbl thead th { font-size: 7pt; font-weight: bold; color: ${GRY3}; letter-spacing: 0.12em; text-transform: uppercase; padding: 10px 8px 8px 8px; text-align: left; }
    .items-tbl thead th.r { text-align: right; }
    .items-tbl tbody tr { border-bottom: 1px solid ${GRY2}; }
    .items-tbl tbody td { padding: 14px 8px; font-size: 9pt; color: ${BLK}; vertical-align: top; }
    .items-tbl tbody td.r { text-align: right; }
    .prod-name { font-size: 10pt; font-weight: bold; color: ${BLK}; display: block; }
    .prod-meta { font-size: 7.5pt; color: ${GRY3}; display: block; margin-top: 3px; letter-spacing: 0.06em; }
    .totals-outer { display: table; width: 100%; margin-top: 4px; margin-bottom: 28px; }
    .totals-spacer { display: table-cell; width: 55%; }
    .totals-inner { display: table-cell; width: 45%; vertical-align: top; }
    .tot-row { display: table; width: 100%; border-bottom: 1px solid ${GRY2}; }
    .tot-lbl { display: table-cell; font-size: 8pt; color: ${GRY4}; padding: 7px 0; }
    .tot-val { display: table-cell; font-size: 8.5pt; font-weight: bold; color: ${BLK}; text-align: right; padding: 7px 0; }
    .tot-val-red { display: table-cell; font-size: 8.5pt; font-weight: bold; color: #B71C1C; text-align: right; padding: 7px 0; }
    .tot-grand { background-color: ${BLK}; display: table; width: 100%; margin-top: 6px; padding: 14px 16px; }
    .tot-grand-lbl { display: table-cell; font-size: 7.5pt; font-weight: bold; color: ${GOLD}; letter-spacing: 0.18em; text-transform: uppercase; vertical-align: middle; }
    .tot-grand-val { display: table-cell; font-family: Georgia, serif; font-size: 18pt; font-weight: bold; color: ${WHT}; text-align: right; vertical-align: middle; }
    .pay-strip { background-color: ${GRY1}; border-top: 1px solid ${GRY2}; border-bottom: 1px solid ${GRY2}; padding: 14px 16px; margin-bottom: 24px; display: table; width: 100%; }
    .pay-cell { display: table-cell; vertical-align: middle; padding-right: 24px; }
    .pay-cell-last { display: table-cell; vertical-align: middle; }
    .pay-lbl { font-size: 6.5pt; color: ${GRY3}; letter-spacing: 0.14em; text-transform: uppercase; display: block; margin-bottom: 3px; }
    .pay-val { font-family: Georgia, serif; font-size: 11pt; font-weight: bold; color: ${BLK}; }
    .pay-paid { font-size: 8pt; font-weight: bold; color: ${GLD2}; letter-spacing: 0.06em; }
    .pay-divider { display: table-cell; width: 1px; background-color: ${GRY2}; padding: 0 12px; vertical-align: middle; }
    .notes-wrap { border-top: 1px solid ${GRY2}; padding-top: 12px; margin-bottom: 24px; }
    .notes-label { font-size: 6.5pt; font-weight: bold; color: ${GLD2}; letter-spacing: 0.18em; text-transform: uppercase; display: block; margin-bottom: 5px; }
    .notes-text { font-size: 8.5pt; color: ${GRY4}; font-style: italic; }
    .footer-top { border-top: 1px solid ${GRY2}; padding: 20px 44px 0 44px; text-align: center; }
    .footer-brand { font-family: Georgia, serif; font-size: 13pt; font-weight: bold; color: ${BLK}; letter-spacing: 0.12em; text-transform: uppercase; }
    .footer-rule { height: 1px; background-color: ${GOLD}; width: 48px; margin: 12px auto; }
    .footer-policy { font-size: 7.5pt; color: ${GRY3}; margin-bottom: 4px; }
    .footer-bottom { background-color: ${BLK}; padding: 14px 44px; margin-top: 20px; text-align: center; }
    .footer-tagline { font-family: Georgia, serif; font-size: 8pt; color: #888; font-style: italic; }
    .footer-meta { font-size: 6.5pt; color: #555; margin-top: 5px; letter-spacing: 0.06em; }
  `;

  const logoBlock = hasLogo
    ? `<img src="${b.logoUrl}" class="logo-img" alt="${b.name}" />`
    : `<span class="brand-name-text">${b.name}</span>`;

  const trackingRow = order.trackingId
    ? `<div class="info-row"><span class="info-key">Tracking</span><span class="info-val-mono">${escapeHtml_(order.trackingId)}</span></div>`
    : '';

  const discountRow = hasDiscount
    ? `<div class="tot-row"><span class="tot-lbl">Discount</span><span class="tot-val-red">-\u09F3${fmtNum_(totalDiscount)}</span></div>`
    : '';

  const shippingRow = order.shippingFee > 0
    ? `<div class="tot-row"><span class="tot-lbl">Delivery Charge</span><span class="tot-val">\u09F3${fmtNum_(order.shippingFee)}</span></div>`
    : '';

  const notesBlock = order.notes
    ? `<div class="notes-wrap"><span class="notes-label">Notes</span><span class="notes-text">${escapeHtml_(order.notes.toString())}</span></div>`
    : '';

  const discountTh = hasDiscount ? `<th class="r" style="width:16%;">Discount</th>` : '';
  const discountTd = hasDiscount ? `<td class="r"><span style="color:#B71C1C;">-\u09F3${fmtNum_(totalDiscount)}</span></td>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${invoiceNumber}</title><style>${css}</style></head>
<body>
<div class="hd">
  <div class="hd-inner">
    <div class="hd-logo-cell">${logoBlock}<div class="brand-tagline">${b.tagline}</div></div>
    <div class="hd-inv-cell">
      <div class="inv-word">Invoice</div>
      <div class="inv-number">${invoiceNumber}</div>
      <div class="inv-date">Issued ${issuedStr}</div>
    </div>
  </div>
</div>
<div class="gold-bar"></div>
<div class="contact-row">
  <div class="contact-inner">
    <div class="contact-cell"><span class="contact-label">Phone</span>${b.phone}</div>
    <div class="contact-cell"><span class="contact-label">Email</span>${b.email}</div>
    <div class="contact-cell"><span class="contact-label">Facebook</span>${b.facebook}</div>
  </div>
</div>
<div class="body">
  <table class="info-table"><tr>
    <td class="info-bill-cell">
      <span class="info-section-label">Bill To</span>
      <div class="info-name">${escapeHtml_(order.customer)}</div>
      <div class="info-row"><span class="info-key">Phone</span><span class="info-val-mono">${escapeHtml_(order.phone.toString())}</span></div>
      <div class="info-row"><span class="info-key">Address</span><span class="info-val">${escapeHtml_(order.address)}</span></div>
    </td>
    <td class="info-order-cell">
      <span class="info-section-label">Order Details</span>
      <div class="info-row" style="margin-top:10px;"><span class="info-key">Order ID</span><span class="info-val-mono">${order.id}</span></div>
      <div class="info-row"><span class="info-key">Order Date</span><span class="info-val">${orderDate}</span></div>
      <div class="info-row"><span class="info-key">Delivered</span><span class="info-val">${delivDate}</span></div>
      <div class="info-row"><span class="info-key">Courier</span><span class="info-val">${escapeHtml_(order.courier) || '\u2014'}</span></div>
      ${trackingRow}
    </td>
  </tr></table>
  <span class="items-label">Items Ordered</span>
  <table class="items-tbl">
    <thead><tr>
      <th style="width:44%;">Product</th>
      <th class="r" style="width:16%;">Unit Price</th>
      <th class="r" style="width:8%;">Qty</th>
      <th class="r" style="width:16%;">Subtotal</th>
      ${discountTh}
    </tr></thead>
    <tbody><tr>
      <td>
        <span class="prod-name">${escapeHtml_(order.product)}</span>
        ${productMeta ? `<span class="prod-meta">${productMeta}</span>` : ''}
      </td>
      <td class="r">\u09F3${fmtNum_(order.unitPrice)}</td>
      <td class="r">${order.qty}</td>
      <td class="r">\u09F3${fmtNum_(order.unitPrice * order.qty)}</td>
      ${discountTd}
    </tr></tbody>
  </table>
  <div class="totals-outer">
    <div class="totals-spacer"></div>
    <div class="totals-inner">
      <div class="tot-row"><span class="tot-lbl">Item Total</span><span class="tot-val">\u09F3${fmtNum_(order.unitPrice * order.qty)}</span></div>
      ${discountRow}
      ${shippingRow}
      <div class="tot-grand">
        <span class="tot-grand-lbl">Total Payable</span>
        <span class="tot-grand-val">\u09F3${fmtNum_(grandTotal)}</span>
      </div>
    </div>
  </div>
  <div class="pay-strip">
    <div class="pay-cell"><span class="pay-lbl">Payment Method</span><span class="pay-val">${escapeHtml_(order.payment)}</span></div>
    <div class="pay-divider">&nbsp;</div>
    <div class="pay-cell"><span class="pay-lbl">Status</span><span class="pay-paid">PAID</span></div>
    <div class="pay-divider">&nbsp;</div>
    <div class="pay-cell-last"><span class="pay-lbl">Amount Received</span><span class="pay-val">\u09F3${fmtNum_(grandTotal)}</span></div>
  </div>
  ${notesBlock}
</div>
<div class="footer-top">
  <div class="footer-brand">${b.name}</div>
  <div class="footer-rule"></div>
  <div class="footer-policy">${f.policy}</div>
</div>
<div class="footer-bottom">
  <div class="footer-tagline">${f.thankYou}</div>
  <div class="footer-meta">${f.note} &middot; ${invoiceNumber} &middot; ${issuedStr}</div>
</div>
</body></html>`;
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
  // Create a temporary Google Doc from the HTML
  const tempFileName = `__TEMP_INVOICE_${invoiceNumber}`;
  const blob = Utilities.newBlob(html, MimeType.HTML, tempFileName + '.html');

  // Upload as a Google Doc (auto-converts HTML)
  const file = Drive.Files.insert(
    { title: tempFileName, mimeType: MimeType.GOOGLE_DOCS },
    blob,
    { convert: true }
  );

  // Export the Google Doc as PDF
  Utilities.sleep(3000);

  const pdfBlob = DriveApp.getFileById(file.id)
    .getAs(MimeType.PDF)
    .copyBlob();

  // Delete the temporary Google Doc
  Drive.Files.remove(file.id);

  return pdfBlob;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRIVE SAVE LOGIC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Saves the PDF blob to two Drive locations:
 *   1. 06_Invoices / Year / Month / filename.pdf  (primary archive)
 *   2. Orders / Year / Month / OrderID / Invoice / filename.pdf  (order copy)
 *
 * Returns the primary file URL, or null on failure.
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

  let primaryUrl = null;

  // ── 1. Primary: 06_Invoices / Year / Month ────────────────────────────────
  try {
    const invRootFolder = getFolder_('INVOICES');
    if (invRootFolder) {
      const monthFolder = navigatePath_(invRootFolder, [year, month]);
      if (monthFolder) {
        pdfBlob.setName(fileName);
        const saved = monthFolder.createFile(pdfBlob);
        primaryUrl  = saved.getUrl();

        // Index in Drive Index sheet
        if (typeof indexDocument_ === 'function') {
          indexDocument_('INVOICE', order.id, primaryUrl, order.customer,
            `Invoices/${year}/${month}/${fileName}`);
        }
        invLog_('SAVED_INVOICES', order.id, `Saved to Invoices/${year}/${month}/`, primaryUrl);
      }
    }
  } catch (e) {
    invLog_('SAVE_ERROR_INVOICES', order.id, e.message, fileName);
  }

  // ── 2. Copy: Orders / Year / Month / OrderID / Invoice ────────────────────
  try {
    const ordersRootFolder = getFolder_('ORDERS');
    if (ordersRootFolder) {
      const orderDate = order.date instanceof Date ? order.date : issuedDate;
      const oYear  = orderDate.getFullYear().toString();
      const oMonth = Utilities.formatDate(orderDate, Session.getScriptTimeZone(), 'MMM');
      const orderInvFolder = navigatePath_(ordersRootFolder, [oYear, oMonth, order.id, 'Invoice']);
      if (orderInvFolder) {
        pdfBlob.setName(fileName);
        orderInvFolder.createFile(pdfBlob);
        invLog_('SAVED_ORDER_COPY', order.id, `Copy saved to Orders/${oYear}/${oMonth}/${order.id}/Invoice/`, '');
      }
    }
  } catch (e) {
    invLog_('SAVE_ERROR_ORDER_COPY', order.id, e.message, '');
    // Non-fatal — primary save succeeded
  }

  return primaryUrl;
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

  if (!result) {
    ui.alert('❌ Invoice generation failed. Check 🤖 AUTOMATION LOG for details.');
  } else if (result.fileUrl === '') {
    ui.alert(`ℹ️ Invoice already exists for ${target}.\nInvoice #: ${result.invoiceNumber}`);
  } else {
    ui.alert(`✅ Invoice generated!\n\nInvoice #: ${result.invoiceNumber}\nFile: ${result.fileName}\n\nSaved to Google Drive.`);
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
    if (!result) { errors++; }
    else if (result.fileUrl === '') { skipped++; }  // already had one
    else { generated++; }

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