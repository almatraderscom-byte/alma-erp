/**
 * Creative Digital IT — billing, projects, payments, invoices (sheet-backed).
 */

var CDIT_SHEETS = {
  CLIENTS:  '💼 CDIT CLIENTS',
  PROJECTS: '💼 CDIT PROJECTS',
  INVOICES: '💼 CDIT INVOICES',
  PAYMENTS: '💼 CDIT PAYMENTS',
};

var CDIT_BIZ = 'CREATIVE_DIGITAL_IT';
var CDIT_DATA_START = 3;

var CDIT_HDR_CLIENTS = [
  'CLIENT_ID','NAME','COMPANY','PHONE','EMAIL','COUNTRY','SERVICE_TYPE','LEAD_SOURCE',
  'NOTES','TAGS','BUSINESS_ID','CREATED_AT','CREATED_BY','UPDATED_AT',
];

var CDIT_HDR_PROJECTS = [
  'PROJECT_ID','CLIENT_ID','BUSINESS_ID','SERVICE_TYPE','PROJECT_NAME','TOTAL_AMOUNT','CURRENCY',
  'START_DATE','DEADLINE','STATUS','NOTES','ASSIGNED_TO','PRIORITY','FILES_URL','CLIENT_NAME',
  'CREATED_AT','CREATED_BY','UPDATED_AT',
];

var CDIT_HDR_INVOICES = [
  'INVOICE_ID','CLIENT_ID','PROJECT_ID','CLIENT_NAME','INVOICE_TYPE','AMOUNT','STATUS',
  'DUE_DATE','ISSUED_DATE','RECURRING_INTERVAL','PDF_URL','NOTES','BUSINESS_ID',
  'CREATED_AT','CREATED_BY','UPDATED_AT',
];

var CDIT_HDR_PAYMENTS = [
  'PAYMENT_ID','PROJECT_ID','CLIENT_ID','INVOICE_ID','AMOUNT','PAYMENT_METHOD','TRANSACTION_ID',
  'PAYMENT_DATE','NOTE','CLIENT_NAME','PAYMENT_TYPE','CATEGORY','BUSINESS_ID',
  'CREATED_AT','CREATED_BY',
];

function ensureCditSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, 3).merge().setValue(name).setFontWeight('bold');
    sh.getRange(2, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(2);
  } else {
    var cur = sh.getLastColumn();
    if (cur < headers.length) {
      sh.getRange(2, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }
  }
  return sh;
}

function cditPad4_(n) {
  var s = String(n);
  while (s.length < 4) s = '0' + s;
  return s;
}

function cditNextId_(prefix, sh) {
  var last = sh.getLastRow();
  var n = Math.max(0, last - CDIT_DATA_START + 1) + 1;
  return prefix + '-' + cditPad4_(n);
}

function cditNow_() { return new Date(); }

function cditActor_(body) {
  return String((body && body.created_by) || (body && body.actor) || 'system');
}

function cditPaymentStatus_(totalAmount, totalPaid) {
  var total = Number(totalAmount || 0);
  var paid = Number(totalPaid || 0);
  if (paid <= 0) return 'Unpaid';
  if (paid >= total - 0.001) return 'Paid';
  return 'Partial Paid';
}

function cditFinance_(totalAmount, totalPaid) {
  var total = Number(totalAmount || 0);
  var paid = Math.min(Number(totalPaid || 0), total);
  var due = Math.max(0, total - paid);
  var pct = total > 0 ? Math.round((paid / total) * 1000) / 10 : 0;
  return {
    total_amount: total,
    total_paid: paid,
    due_amount: due,
    payment_percentage: pct,
    payment_status: cditPaymentStatus_(total, paid),
  };
}

function cditReadData_(sh, colCount) {
  var last = sh.getLastRow();
  if (last < CDIT_DATA_START) return [];
  return sh.getRange(CDIT_DATA_START, 1, last - CDIT_DATA_START + 1, colCount).getValues();
}

/** Legacy project row (TITLE col) vs v2 (PROJECT_NAME + BUSINESS_ID col 3) */
function cditRowToProject_(r) {
  if (!r[0]) return null;
  var bizCol = String(r[2] || '');
  var isLegacy = bizCol !== CDIT_BIZ && bizCol !== 'ALMA_LIFESTYLE';
  if (isLegacy) {
    return {
      id: String(r[0]), client_id: String(r[1]), client_name: String(r[2]),
      project_name: String(r[3]), service_type: String(r[4]), status: String(r[5] || 'Lead'),
      deadline: fmtDate_(r[6]), assigned_to: String(r[7]), priority: String(r[8] || 'Medium'),
      files_url: String(r[9]), notes: String(r[10] || ''), business_id: String(r[11] || CDIT_BIZ),
      created_at: fmtDate_(r[12]), total_amount: Number(r[13] || 0), currency: String(r[14] || 'BDT'),
      start_date: fmtDate_(r[15]), created_by: String(r[17] || ''), updated_at: fmtDate_(r[18]),
    };
  }
  return {
    id: String(r[0]), client_id: String(r[1]), business_id: String(r[2] || CDIT_BIZ),
    service_type: String(r[3]), project_name: String(r[4]), total_amount: Number(r[5] || 0),
    currency: String(r[6] || 'BDT'), start_date: fmtDate_(r[7]), deadline: fmtDate_(r[8]),
    status: String(r[9] || 'Lead'), notes: String(r[10] || ''), assigned_to: String(r[11]),
    priority: String(r[12] || 'Medium'), files_url: String(r[13]), client_name: String(r[14]),
    created_at: fmtDate_(r[15]), created_by: String(r[16] || ''), updated_at: fmtDate_(r[17]),
  };
}

function cditRowToPayment_(r) {
  if (!r[0]) return null;
  var id = String(r[0]);
  var methodOrType = String(r[5] || '');
  var isV2 = methodOrType !== '' && methodOrType !== 'income' && methodOrType !== 'expense' && !isNaN(Number(r[4]));
  if (isV2 || String(r[1] || '').indexOf('CDIT-P') === 0) {
    return {
      id: id, project_id: String(r[1] || ''), client_id: String(r[2] || ''),
      invoice_id: String(r[3] || ''), amount: Number(r[4] || 0),
      payment_method: String(r[5] || ''), transaction_id: String(r[6] || ''),
      payment_date: fmtDate_(r[7]), note: String(r[8] || ''), client_name: String(r[9] || ''),
      payment_type: String(r[10] || 'income'), category: String(r[11] || ''),
      business_id: String(r[12] || CDIT_BIZ), created_at: fmtDate_(r[13]),
      created_by: String(r[14] || ''),
    };
  }
  return {
    id: id, invoice_id: String(r[1] || ''), client_name: String(r[2] || ''),
    amount: Number(r[3] || 0), payment_type: String(r[4] || 'income'),
    category: String(r[5] || ''), payment_date: fmtDate_(r[6]), note: String(r[7] || ''),
    business_id: String(r[8] || CDIT_BIZ), project_id: '', client_id: '',
    payment_method: '', transaction_id: '', created_at: fmtDate_(r[6]), created_by: '',
  };
}

function cditRowToInvoice_(r) {
  if (!r[0]) return null;
  var invTypeAt3 = String(r[3] || '') === 'one-time' || String(r[3] || '') === 'recurring';
  if (invTypeAt3) {
    return {
      id: String(r[0]), client_id: String(r[1] || ''), project_id: '',
      client_name: String(r[2] || ''), invoice_type: String(r[3] || 'one-time'),
      amount: Number(r[4] || 0), status: String(r[5] || 'Draft'),
      due_date: fmtDate_(r[6]), issued_date: fmtDate_(r[7]),
      recurring_interval: String(r[8] || ''), pdf_url: String(r[9] || ''),
      notes: String(r[10] || ''), business_id: String(r[11] || CDIT_BIZ),
      created_at: '', created_by: '', updated_at: '',
    };
  }
  return {
    id: String(r[0]), client_id: String(r[1] || ''), project_id: String(r[2] || ''),
    client_name: String(r[3] || ''), invoice_type: String(r[4] || 'one-time'),
    amount: Number(r[5] || 0), status: String(r[6] || 'Draft'),
    due_date: fmtDate_(r[7]), issued_date: fmtDate_(r[8]),
    recurring_interval: String(r[9] || ''), pdf_url: String(r[10] || ''),
    notes: String(r[11] || ''), business_id: String(r[12] || CDIT_BIZ),
    created_at: fmtDate_(r[13]), created_by: String(r[14] || ''), updated_at: fmtDate_(r[15]),
  };
}

function cditSumPayments_(payments, filter) {
  filter = filter || function() { return true; };
  var sum = 0;
  payments.forEach(function(p) {
    if (p.payment_type === 'expense') return;
    if (filter(p)) sum += Number(p.amount || 0);
  });
  return sum;
}

function cditEnrichProject_(project, payments) {
  var paid = cditSumPayments_(payments, function(p) {
    return p.project_id === project.id;
  });
  var fin = cditFinance_(project.total_amount, paid);
  return Object.assign({}, project, fin);
}

function cditEnrichInvoice_(invoice, payments) {
  var paid = cditSumPayments_(payments, function(p) {
    return p.invoice_id === invoice.id;
  });
  var fin = cditFinance_(invoice.amount, paid);
  return Object.assign({}, invoice, fin);
}

function cditAllPayments_() {
  var sh = ensureCditSheet_(CDIT_SHEETS.PAYMENTS, CDIT_HDR_PAYMENTS);
  return cditReadData_(sh, CDIT_HDR_PAYMENTS.length)
    .map(cditRowToPayment_).filter(Boolean);
}

function cditRecalcInvoiceRow_(invoiceId) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CDIT_SHEETS.INVOICES);
  if (!sh) return;
  var rowIdx = findCditRow_(sh, invoiceId);
  if (!rowIdx) return;
  var inv = cditRowToInvoice_(sh.getRange(rowIdx, 1, 1, CDIT_HDR_INVOICES.length).getValues()[0]);
  var payments = cditAllPayments_();
  var enriched = cditEnrichInvoice_(inv, payments);
  var status = enriched.payment_status === 'Paid' ? 'Paid'
    : enriched.payment_status === 'Partial Paid' ? 'Partial Paid'
    : inv.status;
  if (status === 'Draft') status = inv.status;
  sh.getRange(rowIdx, 7).setValue(status);
  sh.getRange(rowIdx, CDIT_HDR_INVOICES.length).setValue(cditNow_());
}

// ── Clients ───────────────────────────────────────────────────────────────────

function getCditClients_(p) {
  var sh = ensureCditSheet_(CDIT_SHEETS.CLIENTS, CDIT_HDR_CLIENTS);
  var rows = cditReadData_(sh, CDIT_HDR_CLIENTS.length);
  var search = (p.search || '').toLowerCase();
  var clients = rows.map(function(r) {
    return {
      id: String(r[0]), name: String(r[1]), company: String(r[2]), phone: String(r[3]),
      email: String(r[4]), country: String(r[5]), service_type: String(r[6]),
      lead_source: String(r[7]), notes: String(r[8]), tags: String(r[9]),
      business_id: String(r[10] || CDIT_BIZ), created_at: fmtDate_(r[11]),
      created_by: String(r[12] || ''), updated_at: fmtDate_(r[13]),
    };
  }).filter(function(c) {
    if (!c.id) return false;
    if (search) return [c.name, c.company, c.phone, c.email].some(function(v) {
      return String(v).toLowerCase().indexOf(search) !== -1;
    });
    return true;
  });
  return { clients: clients, total: clients.length };
}

function getCditClientDetail_(p) {
  var clientId = String(p.id || p.client_id || '').trim();
  if (!clientId) return { error: 'client id required' };

  var clients = getCditClients_({}).clients;
  var client = null;
  for (var i = 0; i < clients.length; i++) {
    if (clients[i].id === clientId) { client = clients[i]; break; }
  }
  if (!client) return { error: 'client not found: ' + clientId };

  var payments = cditAllPayments_();
  var projects = getCditProjects_({ client_id: clientId }).projects;
  var invoices = getCditInvoices_({ client_id: clientId }).invoices;

  var totalValue = 0, totalPaid = 0;
  projects.forEach(function(pr) {
    totalValue += pr.total_amount;
    totalPaid += pr.total_paid;
  });
  invoices.forEach(function(inv) {
    if (!inv.project_id) {
      totalValue += inv.amount;
      totalPaid += inv.total_paid;
    }
  });

  var summary = cditFinance_(totalValue, totalPaid);
  var timeline = payments.filter(function(pay) {
    return pay.client_id === clientId ||
      projects.some(function(pr) { return pr.id === pay.project_id; }) ||
      invoices.some(function(inv) { return inv.id === pay.invoice_id; });
  }).sort(function(a, b) {
    return String(b.payment_date).localeCompare(String(a.payment_date));
  });

  return {
    client: client,
    summary: summary,
    projects: projects,
    invoices: invoices,
    payments: timeline,
    timeline: timeline,
  };
}

function createCditClient_(body) {
  body = body || {};
  try {
    var sh = ensureCditSheet_(CDIT_SHEETS.CLIENTS, CDIT_HDR_CLIENTS);
    var name = String(body.name || '').trim();
    if (!name) return { ok: false, error: 'name is required' };
    var biz = String(body.business_id || CDIT_BIZ).trim() || CDIT_BIZ;
    var actor = cditActor_(body);
    var now = cditNow_();
    var id = cditNextId_('CLI', sh);
    sh.appendRow([
      id, name, String(body.company || ''), String(body.phone || ''), String(body.email || ''),
      String(body.country || 'Bangladesh'), String(body.service_type || ''),
      String(body.lead_source || ''), String(body.notes || ''), String(body.tags || ''),
      biz, now, actor, now,
    ]);
    return {
      ok: true, client_id: id,
      client: {
        id: id, name: name, business_id: biz, created_at: fmtDate_(now),
        created_by: actor, updated_at: fmtDate_(now),
      },
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ── Projects ──────────────────────────────────────────────────────────────────

function getCditProjects_(p) {
  var sh = ensureCditSheet_(CDIT_SHEETS.PROJECTS, CDIT_HDR_PROJECTS);
  var rows = cditReadData_(sh, CDIT_HDR_PROJECTS.length);
  var payments = cditAllPayments_();
  var statusF = p.status || '', search = (p.search || '').toLowerCase();
  var clientF = p.client_id || '';

  var projects = rows.map(cditRowToProject_).filter(Boolean).map(function(pr) {
    return cditEnrichProject_(pr, payments);
  }).filter(function(pr) {
    if (clientF && pr.client_id !== clientF) return false;
    if (statusF && pr.status !== statusF) return false;
    if (search) return [pr.project_name, pr.client_name, pr.id].some(function(v) {
      return String(v).toLowerCase().indexOf(search) !== -1;
    });
    return true;
  });
  return { projects: projects, total: projects.length };
}

function createCditProject_(body) {
  body = body || {};
  var title = String(body.project_name || body.title || '').trim();
  if (!title) return { ok: false, error: 'project_name is required' };
  var sh = ensureCditSheet_(CDIT_SHEETS.PROJECTS, CDIT_HDR_PROJECTS);
  var id = cditNextId_('CDIT-P', sh);
  var actor = cditActor_(body);
  var now = cditNow_();
  var biz = String(body.business_id || CDIT_BIZ);
  sh.appendRow([
    id, body.client_id || '', biz, body.service_type || '', title,
    Number(body.total_amount || 0), String(body.currency || 'BDT'),
    body.start_date ? new Date(body.start_date) : '', body.deadline ? new Date(body.deadline) : '',
    body.status || 'Lead', String(body.notes || body.comments || ''),
    body.assigned_to || '', body.priority || 'Medium', body.files_url || '',
    body.client_name || '', now, actor, now,
  ]);
  var payments = cditAllPayments_();
  var project = cditEnrichProject_(cditRowToProject_(sh.getRange(sh.getLastRow(), 1, 1, CDIT_HDR_PROJECTS.length).getValues()[0]), payments);
  return { ok: true, project_id: id, project: project };
}

function updateCditProject_(body) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CDIT_SHEETS.PROJECTS);
  if (!sh || !body.id) return { error: 'project not found' };
  var rowIdx = findCditRow_(sh, body.id);
  if (!rowIdx) return { error: 'project not found: ' + body.id };
  if (body.status) sh.getRange(rowIdx, 10).setValue(body.status);
  if (body.priority) sh.getRange(rowIdx, 13).setValue(body.priority);
  if (body.assigned_to) sh.getRange(rowIdx, 12).setValue(body.assigned_to);
  if (body.notes !== undefined) sh.getRange(rowIdx, 11).setValue(body.notes);
  if (body.total_amount !== undefined) sh.getRange(rowIdx, 6).setValue(Number(body.total_amount));
  if (body.deadline) sh.getRange(rowIdx, 9).setValue(new Date(body.deadline));
  sh.getRange(rowIdx, CDIT_HDR_PROJECTS.length).setValue(cditNow_());
  return { ok: true };
}

// ── Invoices ──────────────────────────────────────────────────────────────────

function getCditInvoices_(p) {
  var sh = ensureCditSheet_(CDIT_SHEETS.INVOICES, CDIT_HDR_INVOICES);
  var rows = cditReadData_(sh, CDIT_HDR_INVOICES.length);
  var payments = cditAllPayments_();
  var statusF = p.status || '', clientF = p.client_id || '';

  var invoices = rows.map(cditRowToInvoice_).filter(Boolean).map(function(inv) {
    return cditEnrichInvoice_(inv, payments);
  }).filter(function(inv) {
    if (clientF && inv.client_id !== clientF) return false;
    if (statusF && inv.status !== statusF && inv.payment_status !== statusF) return false;
    return true;
  });
  return { invoices: invoices, total: invoices.length };
}

function createCditInvoice_(body) {
  body = body || {};
  if (!body.client_name || !body.amount) return { ok: false, error: 'client_name and amount required' };
  var sh = ensureCditSheet_(CDIT_SHEETS.INVOICES, CDIT_HDR_INVOICES);
  var id = cditNextId_('CDIT-INV', sh);
  var actor = cditActor_(body);
  var now = cditNow_();
  sh.appendRow([
    id, body.client_id || '', body.project_id || '', body.client_name,
    body.invoice_type || 'one-time', Number(body.amount),
    body.status || 'Sent', body.due_date ? new Date(body.due_date) : '',
    body.issued_date ? new Date(body.issued_date) : now,
    body.recurring_interval || '', body.pdf_url || '', body.notes || '',
    String(body.business_id || CDIT_BIZ), now, actor, now,
  ]);
  var inv = cditEnrichInvoice_(cditRowToInvoice_(sh.getRange(sh.getLastRow(), 1, 1, CDIT_HDR_INVOICES.length).getValues()[0]), cditAllPayments_());
  return { ok: true, invoice_id: id, invoice: inv };
}

function updateCditInvoiceStatus_(body) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CDIT_SHEETS.INVOICES);
  if (!sh || !body.id) return { error: 'invoice not found' };
  var rowIdx = findCditRow_(sh, body.id);
  if (!rowIdx) return { error: 'invoice not found' };
  if (body.status) sh.getRange(rowIdx, 7).setValue(body.status);
  sh.getRange(rowIdx, CDIT_HDR_INVOICES.length).setValue(cditNow_());
  return { ok: true };
}

// ── Payments ──────────────────────────────────────────────────────────────────

function getCditPayments_(p) {
  var payments = cditAllPayments_();
  if (p.client_id) payments = payments.filter(function(pay) { return pay.client_id === p.client_id; });
  if (p.project_id) payments = payments.filter(function(pay) { return pay.project_id === p.project_id; });
  if (p.invoice_id) payments = payments.filter(function(pay) { return pay.invoice_id === p.invoice_id; });
  return { payments: payments };
}

function createCditPayment_(body) {
  body = body || {};
  var amount = Number(body.amount || 0);
  if (amount <= 0) return { ok: false, error: 'amount must be positive' };

  var sh = ensureCditSheet_(CDIT_SHEETS.PAYMENTS, CDIT_HDR_PAYMENTS);
  var id = cditNextId_('CDIT-PAY', sh);
  var actor = cditActor_(body);
  var now = cditNow_();
  var payDate = body.payment_date ? new Date(body.payment_date) : (body.date ? new Date(body.date) : now);

  sh.appendRow([
    id, body.project_id || '', body.client_id || '', body.invoice_id || '',
    amount, String(body.payment_method || 'Bank Transfer'),
    String(body.transaction_id || ''), payDate, String(body.note || body.notes || ''),
    body.client_name || '', body.payment_type || 'income', body.category || 'client_payment',
    String(body.business_id || CDIT_BIZ), now, actor,
  ]);

  if (body.invoice_id) cditRecalcInvoiceRow_(body.invoice_id);

  var payment = cditRowToPayment_(sh.getRange(sh.getLastRow(), 1, 1, CDIT_HDR_PAYMENTS.length).getValues()[0]);
  return { ok: true, payment_id: id, payment: payment };
}

// ── Dashboard & finance ───────────────────────────────────────────────────────

function getCditDashboard_(p) {
  var clients = getCditClients_({}).clients;
  var projects = getCditProjects_({}).projects;
  var invoices = getCditInvoices_({}).invoices;
  var payments = cditAllPayments_();

  var activeProjects = projects.filter(function(pr) {
    return pr.status === 'Active' || pr.status === 'Review';
  }).length;

  var mrr = 0, revenue = 0, expenses = 0, totalReceivable = 0;
  var unpaidInvoices = 0, partialProjects = 0, collectedThisMonth = 0;
  var monthKey = fmtDate_(new Date()).slice(0, 7);
  var today = fmtDate_(new Date());

  projects.forEach(function(pr) {
    totalReceivable += pr.due_amount;
    if (pr.payment_status === 'Partial Paid') partialProjects++;
  });

  invoices.forEach(function(inv) {
    if (inv.invoice_type === 'recurring' && inv.payment_status === 'Paid') mrr += inv.amount;
    totalReceivable += inv.due_amount;
    if (inv.payment_status === 'Unpaid' || inv.payment_status === 'Partial Paid') unpaidInvoices++;
    if (inv.payment_status === 'Paid') revenue += inv.amount;
  });

  payments.forEach(function(pay) {
    if (pay.payment_type === 'income') {
      revenue += pay.amount;
      if ((pay.payment_date || '').slice(0, 7) === monthKey) collectedThisMonth += pay.amount;
    } else expenses += pay.amount;
  });

  var byService = {}, byStatus = {};
  projects.forEach(function(pr) {
    byService[pr.service_type || 'Other'] = (byService[pr.service_type || 'Other'] || 0) + 1;
    byStatus[pr.status] = (byStatus[pr.status] || 0) + 1;
  });

  return {
    kpis: {
      total_clients: clients.length,
      active_projects: activeProjects,
      mrr: mrr,
      recurring_revenue: mrr,
      total_revenue: revenue,
      total_expenses: expenses,
      net_profit: revenue - expenses,
      total_receivable: totalReceivable,
      collected_this_month: collectedThisMonth,
      unpaid_invoices: unpaidInvoices,
      partially_paid_projects: partialProjects,
      overdue_invoices: invoices.filter(function(inv) {
        return inv.due_amount > 0 && inv.due_date && inv.due_date < today;
      }).length,
    },
    by_service: byService,
    by_status: byStatus,
    recent_invoices: invoices.slice(-8).reverse(),
    recent_projects: projects.slice(-6).reverse(),
    partial_projects: projects.filter(function(pr) {
      return pr.payment_status === 'Partial Paid';
    }).slice(0, 8),
  };
}

function getFinancialReport_(p) {
  var bid = resolveBusinessId_(p.business_id || '');
  if (bid === CDIT_BIZ) return getCditFinancialReport_(p);
  return getAlmaFinancialReport_(p);
}

function getCditFinancialReport_(p) {
  var inv = getCditInvoices_({}).invoices;
  var pay = cditAllPayments_();
  var projects = getCditProjects_({}).projects;
  var monthly = {};

  pay.forEach(function(pay) {
    if (pay.payment_type !== 'income') return;
    var d = pay.payment_date;
    if (!d) return;
    var key = d.slice(0, 7);
    if (!monthly[key]) monthly[key] = { month: key, revenue: 0, profit: 0, expenses: 0 };
    monthly[key].revenue += pay.amount;
    monthly[key].profit += pay.amount;
  });

  pay.forEach(function(pay) {
    if (pay.payment_type !== 'expense') return;
    var d = pay.payment_date;
    if (!d) return;
    var key = d.slice(0, 7);
    if (!monthly[key]) monthly[key] = { month: key, revenue: 0, profit: 0, expenses: 0 };
    monthly[key].expenses += pay.amount;
    monthly[key].profit -= pay.amount;
  });

  var months = Object.keys(monthly).sort();
  var rev = 0, exp = 0, receivable = 0;
  months.forEach(function(k) { rev += monthly[k].revenue; exp += monthly[k].expenses; });
  projects.forEach(function(pr) { receivable += pr.due_amount; });
  inv.forEach(function(i) { receivable += i.due_amount; });

  var clv = {};
  pay.filter(function(p) { return p.payment_type === 'income'; }).forEach(function(p) {
    var name = p.client_name || p.client_id || 'Unknown';
    if (!clv[name]) clv[name] = { name: name, revenue: 0, orders: 0 };
    clv[name].revenue += p.amount;
    clv[name].orders++;
  });

  return {
    business_id: CDIT_BIZ,
    period_label: 'All time',
    total_receivable: receivable,
    monthly_revenue: months.map(function(k) { return monthly[k]; }),
    yearly_growth_pct: 0,
    profit_loss: {
      revenue: rev, cogs: 0, expenses: exp, net_profit: rev - exp,
      margin_pct: rev > 0 ? Math.round((rev - exp) / rev * 100) : 0,
    },
    cashflow: { inflow: rev, outflow: exp, net: rev - exp },
    invoice_history: inv.slice(-20).reverse().map(function(i) {
      return {
        id: i.id, client: i.client_name, amount: i.amount, status: i.payment_status || i.status,
        date: i.issued_date, total_paid: i.total_paid, due_amount: i.due_amount,
      };
    }),
    top_clients_clv: Object.values(clv).sort(function(a, b) { return b.revenue - a.revenue; }).slice(0, 10),
  };
}

// ── CDIT Invoice PDF ──────────────────────────────────────────────────────────

function generateCditInvoicePdf_(body) {
  body = body || {};
  var invoiceId = String(body.id || body.invoice_id || '').trim();
  if (!invoiceId) return { ok: false, error: 'invoice id required' };

  var invoices = getCditInvoices_({}).invoices;
  var inv = null;
  for (var i = 0; i < invoices.length; i++) {
    if (invoices[i].id === invoiceId) { inv = invoices[i]; break; }
  }
  if (!inv) return { ok: false, error: 'invoice not found' };

  var payments = cditAllPayments_().filter(function(p) { return p.invoice_id === invoiceId; });
  var html = cditInvoiceHtml_(inv, payments);
  var folderName = 'CDIT Invoices';
  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  var fileName = 'CDIT-Invoice-' + invoiceId + '.pdf';

  var pdfBlob;
  try {
    if (typeof Drive !== 'undefined' && Drive.Files && Drive.Files.insert) {
      var blob = Utilities.newBlob(html, 'text/html', 'invoice.html');
      var temp = Drive.Files.insert({ title: 'temp-' + invoiceId, mimeType: 'application/vnd.google-apps.document' }, blob, { convert: true });
      Utilities.sleep(800);
      pdfBlob = DriveApp.getFileById(temp.id).getAs(MimeType.PDF);
      try { DriveApp.getFileById(temp.id).setTrashed(true); } catch (e2) {}
    } else {
      pdfBlob = HtmlService.createHtmlOutput(html).getAs(MimeType.PDF);
    }
  } catch (e) {
    try {
      pdfBlob = HtmlService.createHtmlOutput(html).getAs(MimeType.PDF);
    } catch (e2) {
      return { ok: false, error: 'PDF failed: ' + e2.message };
    }
  }

  var existing = folder.getFilesByName(fileName);
  while (existing.hasNext()) existing.next().setTrashed(true);
  var file = folder.createFile(pdfBlob).setName(fileName);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = 'https://drive.google.com/file/d/' + file.getId() + '/view';

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CDIT_SHEETS.INVOICES);
  if (sh) {
    var rowIdx = findCditRow_(sh, invoiceId);
    if (rowIdx) sh.getRange(rowIdx, 11).setValue(url);
  }

  return { ok: true, pdf_url: url, invoice_id: invoiceId };
}

function cditInvoiceHtml_(inv, payments) {
  var cfg = typeof getBrandConfigForBusiness_ === 'function'
    ? getBrandConfigForBusiness_('CREATIVE_DIGITAL_IT')
    : { brand: { name: 'Creative Digital IT', logoUrl: '' }, footer: {}, colors: { gold: '#c9a84c' } };
  var b = cfg.brand;
  var f = cfg.footer || {};
  var gold = (cfg.colors && cfg.colors.gold) ? cfg.colors.gold : '#c9a84c';
  var hasLogo = b.logoUrl && b.logoUrl.indexOf('http') === 0;
  var logoBlock = hasLogo
    ? '<img src="' + b.logoUrl + '" alt="" style="max-height:56px;margin-bottom:12px" />'
    : '';
  var rows = payments.map(function(p) {
    return '<tr><td>' + p.payment_date + '</td><td>' + p.payment_method + '</td><td>৳' +
      Number(p.amount).toLocaleString() + '</td><td>' + (p.transaction_id || '—') + '</td></tr>';
  }).join('');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;700&display=swap" rel="stylesheet"><style>' +
    '@page{size:A4;margin:0}body{width:210mm;min-height:297mm;font-family:"Noto Sans Bengali","Inter","Hind Siliguri",sans-serif;background:#0a0a0a;color:#f5f0e8;padding:40px;margin:0}' +
    'h1{color:' + gold + ';font-size:28px;margin:0}table{width:100%;border-collapse:collapse;margin-top:20px}' +
    'th,td{border-bottom:1px solid #333;padding:10px;text-align:left;font-size:13px}' +
    '.gold{color:' + gold + '}.muted{color:#888}.footer{margin-top:32px;font-size:11px;color:#888}' +
    '</style></head><body>' +
    logoBlock +
    '<p class="muted">' + (b.name || 'Creative Digital IT') + '</p>' +
    '<p class="muted" style="font-size:11px">' + (b.tagline || '') + '</p>' +
    (b.phone ? '<p class="muted">' + b.phone + ' · ' + (b.email || '') + '</p>' : '') +
    '<h1>INVOICE ' + inv.id + '</h1>' +
    '<p><strong>Client:</strong> ' + inv.client_name + '</p>' +
    '<p><strong>Issued:</strong> ' + (inv.issued_date || '—') + ' · <strong>Due:</strong> ' + (inv.due_date || '—') + '</p>' +
    '<p class="gold"><strong>Amount:</strong> ৳' + Number(inv.amount).toLocaleString() +
    ' · <strong>Paid:</strong> ৳' + Number(inv.total_paid || 0).toLocaleString() +
    ' · <strong>Due:</strong> ৳' + Number(inv.due_amount || 0).toLocaleString() +
    ' · <strong>Status:</strong> ' + (inv.payment_status || inv.status) + '</p>' +
    '<h3 style="color:#c9a84c;margin-top:32px">Payment history</h3>' +
    '<table><thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>Reference</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="4">No payments recorded</td></tr>') +
    '</tbody></table>' +
    '<div class="footer"><p>' + (f.thankYou || '') + '</p><p>' + (f.policy || '') + '</p><p>' + (f.note || '') + '</p></div>' +
    '</body></html>';
}

function getAlmaFinancialReport_(p) {
  p = p || {};
  var start = p.startDate ? String(p.startDate).slice(0, 10) : '';
  var end = p.endDate ? String(p.endDate).slice(0, 10) : '';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.ORDERS);
  var last = sh.getLastRow();
  var monthly = {}, clv = {};
  var rev = 0, cogs = 0, exp = 0;
  if (last >= ORDERS_DATA_START) {
    var rows = sh.getRange(ORDERS_DATA_START, 1, last - ORDERS_DATA_START + 1, TOTAL_COLS).getValues();
    rows.filter(function(r) { return r[OC.ORDER_ID - 1]; }).map(rowToOrder_).forEach(function(o) {
      if (!orderMatchesBusiness_(o, 'ALMA_LIFESTYLE')) return;
      if (start && (!o.date || o.date < start)) return;
      if (end && (!o.date || o.date > end)) return;
      rev += o.sell_price; cogs += o.cogs;
      var key = (o.date || '').slice(0, 7);
      if (key) {
        if (!monthly[key]) monthly[key] = { month: key, revenue: 0, profit: 0, expenses: 0 };
        monthly[key].revenue += o.sell_price;
        monthly[key].profit += o.profit;
      }
      if (!clv[o.customer]) clv[o.customer] = { name: o.customer, revenue: 0, orders: 0 };
      clv[o.customer].revenue += o.sell_price;
      clv[o.customer].orders++;
    });
  }
  var fin = getFinance_({ business_id: 'ALMA_LIFESTYLE', startDate: start, endDate: end });
  exp = fin.total_expenses || 0;
  var months = Object.keys(monthly).sort();
  var period_label = start && end ? (start + ' → ' + end) : 'All time';
  return {
    business_id: 'ALMA_LIFESTYLE',
    period_label: period_label,
    monthly_revenue: months.map(function(k) { return monthly[k]; }),
    yearly_growth_pct: months.length >= 2
      ? Math.round((monthly[months[months.length - 1]].revenue - monthly[months[months.length - 2]].revenue)
        / Math.max(1, monthly[months[months.length - 2]].revenue) * 100) : 0,
    profit_loss: {
      revenue: rev, cogs: cogs, expenses: exp, net_profit: rev - cogs - exp,
      margin_pct: rev > 0 ? Math.round((rev - cogs - exp) / rev * 100) : 0,
    },
    cashflow: { inflow: rev, outflow: cogs + exp, net: rev - cogs - exp },
    invoice_history: [],
    top_clients_clv: Object.values(clv).sort(function(a, b) { return b.revenue - a.revenue; }).slice(0, 10),
  };
}

function findCditRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < CDIT_DATA_START) return null;
  var ids = sh.getRange(CDIT_DATA_START, 1, last - CDIT_DATA_START + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return CDIT_DATA_START + i;
  }
  return null;
}

function resolveBusinessId_(raw) {
  return raw === 'CREATIVE_DIGITAL_IT' ? 'CREATIVE_DIGITAL_IT' : 'ALMA_LIFESTYLE';
}

function orderMatchesBusiness_(o, bid) {
  var ob = String(o.business_id || '').trim();
  if (!ob) return bid === 'ALMA_LIFESTYLE';
  return ob === bid;
}
