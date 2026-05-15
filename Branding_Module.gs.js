/**
 * Per-business brand assets — sheet + permanent Google Drive storage.
 */

var BRANDING_SHEET = '🏷️ BRANDING';
var BRANDING_FOLDER_NAME = 'ERP Brand Assets';
var BRANDING_DATA_START = 3;

var BRANDING_HDR = [
  'BUSINESS_ID', 'COMPANY_NAME', 'TAGLINE', 'PHONE', 'EMAIL', 'WEBSITE', 'ADDRESS', 'FACEBOOK',
  'LOGO_FILE_ID', 'LOGO_URL', 'FAVICON_FILE_ID', 'FAVICON_URL',
  'COLOR_PRIMARY', 'COLOR_SECONDARY', 'COLOR_ACCENT',
  'INVOICE_FOOTER_THANKS', 'INVOICE_FOOTER_POLICY', 'INVOICE_FOOTER_NOTE',
  'INVOICE_PREFIX', 'CREATED_AT', 'UPDATED_AT', 'CREATED_BY',
];

var BRANDING_DEFAULTS = {
  ALMA_LIFESTYLE: {
    company_name: 'Alma Lifestyle',
    tagline: 'Premium Fashion · Crafted with Care',
    phone: '0130-77777-33',
    email: 'almatraders.com@gmail.com',
    website: '',
    address: 'Bangladesh',
    facebook: 'facebook.com/AlmaLifestyle',
    color_primary: '#C9A84C',
    color_secondary: '#8B6914',
    color_accent: '#F0D080',
    invoice_footer_thanks: 'Thank you for choosing Alma Lifestyle.',
    invoice_footer_policy: 'Exchange within 3 days of delivery. Item must be unused and in original packaging.',
    invoice_footer_note: 'This is a computer-generated invoice and does not require a physical signature.',
    invoice_prefix: 'AL-INV',
    logo_url: 'https://drive.google.com/uc?export=view&id=1PLl-LCbxv4h_A4znlrt0U5pQqMG5XNpc',
  },
  CREATIVE_DIGITAL_IT: {
    company_name: 'Creative Digital IT',
    tagline: 'Digital Agency · Web · Marketing',
    phone: '',
    email: '',
    website: '',
    address: 'Bangladesh',
    facebook: '',
    color_primary: '#C9A84C',
    color_secondary: '#1a1a24',
    color_accent: '#6366f1',
    invoice_footer_thanks: 'Thank you for your business.',
    invoice_footer_policy: 'Payment terms as agreed in your project proposal.',
    invoice_footer_note: 'Computer-generated invoice.',
    invoice_prefix: 'CDIT-INV',
    logo_url: '',
  },
};

function ensureBrandingSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(BRANDING_SHEET);
  if (!sh) {
    sh = ss.insertSheet(BRANDING_SHEET);
    sh.getRange(1, 1, 1, 3).merge().setValue(BRANDING_SHEET).setFontWeight('bold');
    sh.getRange(2, 1, 1, BRANDING_HDR.length).setValues([BRANDING_HDR]).setFontWeight('bold');
    sh.setFrozenRows(2);
  } else if (sh.getLastColumn() < BRANDING_HDR.length) {
    sh.getRange(2, 1, 1, BRANDING_HDR.length).setValues([BRANDING_HDR]).setFontWeight('bold');
  }
  return sh;
}

function brandingBizId_(raw) {
  return raw === 'CREATIVE_DIGITAL_IT' ? 'CREATIVE_DIGITAL_IT' : 'ALMA_LIFESTYLE';
}

function brandingDefaults_(businessId) {
  return BRANDING_DEFAULTS[businessId] || BRANDING_DEFAULTS.ALMA_LIFESTYLE;
}

function driveViewUrl_(fileId) {
  if (!fileId) return '';
  return 'https://drive.google.com/uc?export=view&id=' + fileId;
}

function getOrCreateBrandFolder_(businessId) {
  var propKey = 'BRAND_FOLDER_' + businessId;
  var cached = PropertiesService.getScriptProperties().getProperty(propKey);
  if (cached) {
    try { return DriveApp.getFolderById(cached); } catch (e) { /* recreate */ }
  }
  var rootName = BRANDING_FOLDER_NAME;
  var roots = DriveApp.getFoldersByName(rootName);
  var root = roots.hasNext() ? roots.next() : DriveApp.createFolder(rootName);
  var subs = root.getFoldersByName(businessId);
  var folder = subs.hasNext() ? subs.next() : root.createFolder(businessId);
  PropertiesService.getScriptProperties().setProperty(propKey, folder.getId());
  return folder;
}

function rowToBranding_(r) {
  if (!r[0]) return null;
  return {
    business_id: String(r[0]),
    company_name: String(r[1] || ''),
    tagline: String(r[2] || ''),
    phone: String(r[3] || ''),
    email: String(r[4] || ''),
    website: String(r[5] || ''),
    address: String(r[6] || ''),
    facebook: String(r[7] || ''),
    logo_file_id: String(r[8] || ''),
    logo_url: String(r[9] || ''),
    favicon_file_id: String(r[10] || ''),
    favicon_url: String(r[11] || ''),
    color_primary: String(r[12] || '#C9A84C'),
    color_secondary: String(r[13] || '#8B6914'),
    color_accent: String(r[14] || '#F0D080'),
    invoice_footer_thanks: String(r[15] || ''),
    invoice_footer_policy: String(r[16] || ''),
    invoice_footer_note: String(r[17] || ''),
    invoice_prefix: String(r[18] || ''),
    created_at: fmtDate_(r[19]),
    updated_at: fmtDate_(r[20]),
    created_by: String(r[21] || ''),
  };
}

function mergeBrandingDefaults_(row, businessId) {
  var d = brandingDefaults_(businessId);
  var out = {};
  Object.keys(d).forEach(function(k) { out[k] = d[k]; });
  if (!row) {
    out.business_id = businessId;
    return out;
  }
  Object.keys(row).forEach(function(k) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') out[k] = row[k];
  });
  if (row.logo_file_id && !out.logo_url) out.logo_url = driveViewUrl_(row.logo_file_id);
  if (row.favicon_file_id && !out.favicon_url) out.favicon_url = driveViewUrl_(row.favicon_file_id);
  return out;
}

function findBrandingRow_(sh, businessId) {
  var last = sh.getLastRow();
  if (last < BRANDING_DATA_START) return null;
  var ids = sh.getRange(BRANDING_DATA_START, 1, last - BRANDING_DATA_START + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === businessId) return BRANDING_DATA_START + i;
  }
  return null;
}

function getBranding_(p) {
  var businessId = brandingBizId_(p.business_id || '');
  var sh = ensureBrandingSheet_();
  var rowIdx = findBrandingRow_(sh, businessId);
  var row = rowIdx
    ? rowToBranding_(sh.getRange(rowIdx, 1, 1, BRANDING_HDR.length).getValues()[0])
    : null;
  var branding = mergeBrandingDefaults_(row, businessId);
  return { ok: true, branding: branding };
}

function getAllBranding_() {
  var out = {};
  ['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT'].forEach(function(id) {
    out[id] = getBranding_({ business_id: id }).branding;
  });
  return { ok: true, branding_by_business: out };
}

function saveBranding_(body) {
  body = body || {};
  var businessId = brandingBizId_(body.business_id || '');
  var sh = ensureBrandingSheet_();
  var d = brandingDefaults_(businessId);
  var now = new Date();
  var actor = String(body.created_by || body.actor || 'system');
  var rowIdx = findBrandingRow_(sh, businessId);
  var existing = rowIdx
    ? rowToBranding_(sh.getRange(rowIdx, 1, 1, BRANDING_HDR.length).getValues()[0])
    : null;

  var logoFileId = existing ? existing.logo_file_id : '';
  var logoUrl = existing ? existing.logo_url : (d.logo_url || '');
  var faviconFileId = existing ? existing.favicon_file_id : '';
  var faviconUrl = existing ? existing.favicon_url : '';

  var row = [
    businessId,
    String(body.company_name || d.company_name),
    String(body.tagline || d.tagline),
    String(body.phone || ''),
    String(body.email || ''),
    String(body.website || ''),
    String(body.address || d.address || ''),
    String(body.facebook || ''),
    logoFileId, logoUrl, faviconFileId, faviconUrl,
    String(body.color_primary || d.color_primary),
    String(body.color_secondary || d.color_secondary),
    String(body.color_accent || d.color_accent),
    String(body.invoice_footer_thanks || d.invoice_footer_thanks),
    String(body.invoice_footer_policy || d.invoice_footer_policy),
    String(body.invoice_footer_note || d.invoice_footer_note),
    String(body.invoice_prefix || d.invoice_prefix),
    existing && existing.created_at ? new Date(existing.created_at) : now,
    now,
    actor,
  ];

  if (rowIdx) {
    sh.getRange(rowIdx, 1, 1, BRANDING_HDR.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }

  return getBranding_({ business_id: businessId });
}

function uploadBrandAsset_(body) {
  body = body || {};
  var businessId = brandingBizId_(body.business_id || '');
  var assetType = String(body.asset_type || 'logo').toLowerCase();
  if (assetType !== 'logo' && assetType !== 'favicon') {
    return { ok: false, error: 'asset_type must be logo or favicon' };
  }

  var b64 = String(body.data || body.base64 || '');
  if (b64.indexOf('base64,') >= 0) b64 = b64.split('base64,')[1];
  if (!b64) return { ok: false, error: 'data (base64) required' };

  var mime = String(body.mime_type || 'image/png');
  var ext = mime.indexOf('png') >= 0 ? 'png' : mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0 ? 'jpg' : 'png';
  var fileName = assetType + '.' + ext;

  var bytes = Utilities.base64Decode(b64);
  var blob = Utilities.newBlob(bytes, mime, fileName);
  var folder = getOrCreateBrandFolder_(businessId);

  var existing = folder.getFilesByName(fileName);
  while (existing.hasNext()) existing.next().setTrashed(true);

  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();
  var viewUrl = driveViewUrl_(fileId);

  var sh = ensureBrandingSheet_();
  var rowIdx = findBrandingRow_(sh, businessId);
  if (!rowIdx) {
    saveBranding_({ business_id: businessId });
    rowIdx = findBrandingRow_(sh, businessId);
  }
  if (!rowIdx) return { ok: false, error: 'could not create branding row' };

  if (assetType === 'logo') {
    sh.getRange(rowIdx, 9).setValue(fileId);
    sh.getRange(rowIdx, 10).setValue(viewUrl);
  } else {
    sh.getRange(rowIdx, 11).setValue(fileId);
    sh.getRange(rowIdx, 12).setValue(viewUrl);
  }
  sh.getRange(rowIdx, 21).setValue(new Date()); // UPDATED_AT col 21

  return {
    ok: true,
    asset_type: assetType,
    file_id: fileId,
    url: viewUrl,
    branding: getBranding_({ business_id: businessId }).branding,
  };
}

/** Invoice/PDF generators — Alma + CDIT */
function getBrandConfigForBusiness_(businessId) {
  businessId = brandingBizId_(businessId);
  var b = getBranding_({ business_id: businessId }).branding;
  return {
    brand: {
      name: b.company_name,
      tagline: b.tagline,
      phone: b.phone,
      email: b.email,
      facebook: b.facebook || '',
      website: b.website || '',
      address: b.address || '',
      logoUrl: b.logo_url || '',
    },
    footer: {
      thankYou: b.invoice_footer_thanks,
      policy: b.invoice_footer_policy,
      note: b.invoice_footer_note,
    },
    colors: {
      black: '#0D0D0D',
      gold: b.color_primary || '#C9A84C',
      goldDark: b.color_secondary || '#8B6914',
      goldLight: b.color_accent || '#F0D080',
      white: '#FFFFFF',
      cream: '#FAF8F4',
      gray: '#F5F5F5',
      grayMid: '#888888',
      grayDark: '#444444',
    },
    invoice_prefix: b.invoice_prefix || '',
    favicon_url: b.favicon_url || '',
  };
}
