import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { hostOf, sameSite } from './vault.ts';

export type QuoteItem = { name: string; quantity: number; unitPriceCents: number };
export type Quote = {
  items: QuoteItem[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  shippingMethod: string;
  deliveryEstimate: string;
  address: string;
  paymentMethod: string;
  notes?: string;
};

export type OrderStatus = 'awaiting_approval' | 'approved' | 'rejected' | 'submitted' | 'confirmed' | 'failed' | 'cancelled';

export type Order = {
  id: string;
  status: OrderStatus;
  storeName: string;
  storeUrl: string;
  storeHost: string;
  currency: string;
  quote: Quote;
  totalCents: number;
  approvalEvidence?: string;
  approvedAt?: number;
  submittedAt?: number;
  confirmedAt?: number;
  storeOrderNumber?: string;
  paidTotalCents?: number;
  failure?: string;
  createdAt: number;
};

export function money(cents: number, currency = 'USD') {
  try { return (cents / 100).toLocaleString(process.env.LANG?.split('.')[0]?.replace('_', '-') || undefined, { style: 'currency', currency }); }
  catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

/** Ways a checkout page may print this amount: "1.234,56", "1234,56", "1,234.56", "1234.56". */
export function moneyVariants(cents: number) {
  const units = Math.floor(cents / 100);
  const c = String(cents % 100).padStart(2, '0');
  const variants = [
    `${units.toLocaleString('pt-BR')},${c}`, `${units},${c}`, `${units}.${c}`, `${units.toLocaleString('en-US')}.${c}`,
    `${units.toLocaleString('de-CH')}.${c}`, `${units.toLocaleString('fr-FR').replace(/\s/g, '')},${c}`,
  ];
  if (c === '00') variants.push(`${units.toLocaleString('en-US')}`, `${units.toLocaleString('pt-BR')}`);
  return [...new Set(variants.map(v => v.replace(/\s/g, '')))];
}

function rowToOrder(r: any): Order {
  return {
    id: r.id, status: r.status, storeName: r.store_name, storeUrl: r.store_url, storeHost: r.store_host,
    currency: r.currency, quote: JSON.parse(r.quote), totalCents: r.total_cents,
    approvalEvidence: r.approval_evidence ?? undefined, approvedAt: r.approved_at ?? undefined,
    submittedAt: r.submitted_at ?? undefined, confirmedAt: r.confirmed_at ?? undefined,
    storeOrderNumber: r.store_order_number ?? undefined, paidTotalCents: r.paid_total_cents ?? undefined,
    failure: r.failure ?? undefined, createdAt: r.created_at,
  };
}

/**
 * The purchase gate. The agent can only click a final "place order" button for an order the human
 * approved on the approval page, on the approved store, with the approved total visible on the page.
 */
export class Purchases {
  /** Approval-page tokens live only in daemon memory; the model never receives them. */
  private approvalTokens = new Map<string, string>();

  constructor(private db: Db) {}

  get(id: string) {
    const row = this.db.sql.prepare('select * from orders where id = ?').get(id);
    return row ? rowToOrder(row) : undefined;
  }

  list(limit = 20) {
    return (this.db.sql.prepare('select * from orders order by created_at desc limit ?').all(limit) as any[]).map(rowToOrder);
  }

  active(pageUrl: string) {
    return this.list(10).find(o => (o.status === 'awaiting_approval' || o.status === 'approved') && sameSite(o.storeUrl, pageUrl));
  }

  private update(id: string, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    this.db.sql.prepare(`update orders set ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? where id = ?`)
      .run(...keys.map(k => fields[k] as any), Date.now(), id);
    this.db.audit('order.update', { id, ...fields });
    return this.get(id)!;
  }

  propose(storeName: string, storeUrl: string, currency: string, quote: Quote) {
    const host = hostOf(storeUrl);
    if (!host) throw new Error('Invalid store_url');
    if (!quote.items.length) throw new Error('List the items.');
    const computed = quote.subtotalCents + quote.shippingCents + quote.taxCents - quote.discountCents;
    if (Math.abs(computed - quote.totalCents) > 1) {
      throw new Error(`Total does not add up: subtotal ${money(quote.subtotalCents, currency)} + shipping ${money(quote.shippingCents, currency)} + tax ${money(quote.taxCents, currency)} - discount ${money(quote.discountCents, currency)} = ${money(computed, currency)}, but total is ${money(quote.totalCents, currency)}. Re-read the page.`);
    }
    this.db.sql.prepare(`update orders set status = 'cancelled', failure = 'replaced by a newer proposal', updated_at = ? where status in ('awaiting_approval', 'approved') and store_host = ?`).run(Date.now(), host);
    const id = 'ord_' + randomBytes(5).toString('hex');
    const now = Date.now();
    this.db.sql.prepare(`insert into orders (id, status, store_name, store_url, store_host, currency, quote, total_cents, created_at, updated_at)
      values (?, 'awaiting_approval', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, storeName, storeUrl, host, currency.toUpperCase(), JSON.stringify(quote), quote.totalCents, now, now);
    this.db.audit('order.proposed', { id, storeName, host, totalCents: quote.totalCents, currency });
    return { order: this.get(id)!, token: this.issueToken(id) };
  }

  /** A fresh approval-page token for an order still awaiting approval. */
  issueToken(id: string) {
    const token = randomBytes(24).toString('base64url');
    this.approvalTokens.set(token, id);
    return token;
  }

  orderForToken(token: string) {
    const id = this.approvalTokens.get(token);
    return id ? this.get(id) : undefined;
  }

  /** Called by the approval page, a native Codex approval prompt, or purchase_approve with the user's chat reply. */
  decide(id: string, approve: boolean, evidence: string) {
    const order = this.get(id);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'awaiting_approval') throw new Error(`Order is ${order.status}, not awaiting approval.`);
    for (const [token, orderId] of this.approvalTokens) if (orderId === id) this.approvalTokens.delete(token);
    return approve
      ? this.update(id, { status: 'approved', approval_evidence: evidence.slice(0, 300), approved_at: Date.now() })
      : this.update(id, { status: 'rejected', approval_evidence: evidence.slice(0, 300) });
  }

  /** Checks the gate before the final purchase click. */
  checkSubmit(id: string, pageUrl: string, pageText: string) {
    const order = this.get(id);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'approved') throw new Error(`Order ${id} is "${order.status}". Only orders the user approved can be placed.`);
    if (!sameSite(order.storeUrl, pageUrl)) throw new Error(`The current page (${hostOf(pageUrl)}) is not the approved store (${order.storeHost}).`);
    const flat = pageText.replace(/\s+/g, '');
    if (!moneyVariants(order.totalCents).some(v => flat.includes(v))) {
      throw new Error(`The approved total (${money(order.totalCents, order.currency)}) is not on the page. If the price changed, call purchase_propose again.`);
    }
    return order;
  }

  markSubmitted(id: string) {
    return this.update(id, { status: 'submitted', submitted_at: Date.now() });
  }

  confirm(id: string, storeOrderNumber: string, paidTotalCents: number, pageText: string) {
    const order = this.get(id);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'submitted') throw new Error(`Order is "${order.status}". Only orders placed with purchase_submit can be confirmed.`);
    if (!pageText.replace(/\s+/g, '').includes(storeOrderNumber.replace(/\s+/g, ''))) {
      throw new Error(`Order number "${storeOrderNumber}" is not on the current page. Open the confirmation page or the store's order history first.`);
    }
    return this.update(id, { status: 'confirmed', store_order_number: storeOrderNumber, paid_total_cents: paidTotalCents, confirmed_at: Date.now() });
  }

  fail(id: string, reason: string) {
    const order = this.get(id);
    if (!order) throw new Error('Order not found');
    if (order.status === 'confirmed') throw new Error('Order already confirmed.');
    return this.update(id, { status: order.status === 'submitted' ? 'failed' : 'cancelled', failure: reason.slice(0, 500) });
  }
}
