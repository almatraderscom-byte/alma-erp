export function orderConfirmationSms(invoice: string) {
  return `ALMA: আপনার অর্ডার গ্রহণ করা হয়েছে। Invoice: ${invoice || '-'}`
}

export function invoiceReadySms(invoice: string) {
  return `ALMA: আপনার invoice প্রস্তুত। Invoice: ${invoice || '-'}`
}

export function courierUpdateSms(tracking: string) {
  return `ALMA: আপনার অর্ডার courier এ পাঠানো হয়েছে। Tracking: ${tracking || '-'}`
}

export function tradingDailySummarySms(input: { profit: number; loss: number; net: number }) {
  return `আজকের Trading Summary | Profit: ${money(input.profit)} | Loss: ${money(input.loss)} | Net: ${money(input.net)} - ALMA`
}

export function salaryReceivedSms(input: { amount: number; periodYm?: string | null }) {
  return `ALMA: আপনার salary wallet এ যোগ হয়েছে। Amount: ${money(input.amount)}${input.periodYm ? ` | Period: ${input.periodYm}` : ''}`
}

export function walletWithdrawalApprovedSms(input: { amount: number; transactionId?: string | null }) {
  const txn = input.transactionId?.trim()
  return `ALMA: আপনার withdrawal accept করা হয়েছে। Amount: ৳${money(input.amount)}${txn ? ` | TxID: ${txn}` : ''}। ধন্যবাদ — ALMA`
}

export function payrollAdvanceAlertSms() {
  return 'ALMA ALERT: নতুন salary advance request এসেছে'
}

export function lowStockAlertSms(product: string) {
  return `ALMA ALERT: Low stock detected for ${product || 'inventory'}`
}

function money(value: number) {
  return Number(value || 0).toLocaleString('en-BD', { maximumFractionDigits: 2 })
}
