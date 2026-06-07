import { aggregateDashboardMetrics } from '../src/lib/order-analytics.ts'
import {
  expandOrderProductLines,
  formatGroupSizeLine,
  normalizeProductCode,
} from '../src/lib/product-size-breakdown.ts'
import type { Order } from '../src/types/index.ts'

function order(partial: Partial<Order> & Pick<Order, 'id' | 'product' | 'status'>): Order {
  return {
    id: partial.id,
    date: partial.date ?? '2026-05-01',
    customer: 'Test',
    phone: '01700000000',
    address: 'Dhaka',
    payment: 'COD',
    source: 'FB',
    status: partial.status,
    product: partial.product,
    category: partial.category ?? 'Men',
    size: partial.size ?? '',
    qty: partial.qty ?? 1,
    unit_price: 1500,
    discount: 0,
    add_discount: 0,
    adv_cost: 0,
    adv_platform: '',
    sell_price: partial.sell_price ?? 1500,
    shipping_fee: 0,
    cogs: 800,
    courier_charge: 0,
    other_costs: 0,
    profit: partial.profit ?? 700,
    courier: '',
    tracking_id: '',
    tracking_status: '',
    est_delivery: '',
    actual_delivery: '',
    return_reason: '',
    return_date: '',
    return_status: '',
    notes: '',
    sku: partial.sku ?? '',
    handled_by: '',
    sla_status: '',
    days_pending: 0,
    days_in_transit: 0,
    auto_flag: '',
    invoice_num: '',
    margin_pct: 0,
    items: partial.items,
    realizedProfit: partial.realizedProfit,
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(normalizeProductCode('133 ADULT + 2 more') === '133', 'code normalize failed')

const multi = expandOrderProductLines(order({
  id: 'AL-1',
  product: '133 ADULT + 1 more',
  status: 'Delivered',
  items: [
    { line_no: 1, product: '133 ADULT', product_code: '133', size_group: 'ADULT', size: '42', qty: 2, unit_price: 1500, subtotal: 3000, sku: '133-42' },
    { line_no: 2, product: '133 KIDS', product_code: '133', size_group: 'KIDS', size: '24', qty: 1, unit_price: 1200, subtotal: 1200, sku: '133-24' },
  ],
}))
assert(multi.length === 2 && multi[0].groupLabel === 'ADULT' && multi[0].specificSize === '42', 'multi-item expand failed')

const orders: Order[] = []
const adultSizes = ['40', '42', '42', '44', '42']
for (let i = 0; i < 150; i++) {
  const size = adultSizes[i % adultSizes.length]
  orders.push(order({
    id: `AL-D-${i}`,
    product: '133 ADULT',
    status: 'Delivered',
    sell_price: 1600,
    realizedProfit: 700,
    items: [{ line_no: 1, product: '133 ADULT', product_code: '133', size_group: 'ADULT', size, qty: 1, unit_price: 1600, subtotal: 1600, sku: `133-${size}` }],
  }))
}
const kidSizes = ['22', '24', '24', '26']
for (let i = 0; i < 80; i++) {
  const size = kidSizes[i % kidSizes.length]
  orders.push(order({
    id: `AL-K-${i}`,
    product: '133 KIDS',
    status: i % 4 === 0 ? 'Pending' : 'Delivered',
    sell_price: 1400,
    realizedProfit: 600,
    items: [{ line_no: 1, product: '133 KIDS', product_code: '133', size_group: 'KIDS', size, qty: 1, unit_price: 1400, subtotal: 1400, sku: `133-${size}` }],
  }))
}
for (let i = 0; i < 50; i++) {
  orders.push(order({
    id: `AL-M-${i}`,
    product: '133 ADULT + 1 more',
    status: 'Delivered',
    sell_price: 3000,
    realizedProfit: 1200,
    items: [
      { line_no: 1, product: '133 ADULT', product_code: '133', size_group: 'ADULT', size: '42', qty: 1, unit_price: 1600, subtotal: 1600, sku: '133-42' },
      { line_no: 2, product: '133 KIDS', product_code: '133', size_group: 'KIDS', size: '24', qty: 1, unit_price: 1400, subtotal: 1400, sku: '133-24' },
    ],
  }))
}

const metrics = aggregateDashboardMetrics(orders)
const top133 = metrics.top_products.find(p => p.product === '133')
assert(!!top133, '133 missing from top products')
assert(top133!.pieces === 330, `expected 330 pcs, got ${top133!.pieces}`)

const adult = top133!.group_details.find(g => g.group === 'ADULT')
const kids = top133!.group_details.find(g => g.group === 'KIDS')
assert(!!adult && adult.pieces === 200, 'ADULT group pieces mismatch')
assert(!!kids && kids.pieces === 130, 'KIDS group pieces mismatch')
assert(adult!.top_size?.label === '42', `expected top adult size 42, got ${adult!.top_size?.label}`)
assert(kids!.top_size?.label === '24', `expected top kids size 24, got ${kids!.top_size?.label}`)

console.log('OK: group + specific size aggregation passed')
console.log('ADULT line:', formatGroupSizeLine(adult!))
console.log('KIDS line:', formatGroupSizeLine(kids!))
