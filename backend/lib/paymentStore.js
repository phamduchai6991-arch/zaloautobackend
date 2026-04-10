import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const ORDERS_FILE = join(DATA_DIR, 'orders.json');
const SUBSCRIPTIONS_FILE = join(DATA_DIR, 'subscriptions.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(filePath) {
  try {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveJson(filePath, data) {
  ensureDataDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Orders ──────────────────────────────────────────────

let _orders = null;

function getOrders() {
  if (!_orders) _orders = loadJson(ORDERS_FILE);
  return _orders;
}

function saveOrders() {
  saveJson(ORDERS_FILE, _orders);
}

function isExpiredPendingOrder(order, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!order || order.status !== 'pending') return false;
  return Date.now() - new Date(order.createdAt).getTime() > maxAgeMs;
}

let _orderCounter = 0;

function generateOrderCode() {
  const ts = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).toUpperCase().slice(-1);
  _orderCounter = (_orderCounter + 1) % 100;
  return `AZ${ts}${rand}${_orderCounter.toString().padStart(2, '0')}`;
}

export function createOrder({ userId, userEmail, planKey, period, amount }) {
  const orders = getOrders();
  const code = generateOrderCode();

  const order = {
    code,
    userId,
    userEmail,
    planKey,
    period,
    amount,
    status: 'pending',
    createdAt: new Date().toISOString(),
    paidAt: null,
    transactionId: null,
  };

  orders[code] = order;
  _orders = orders;
  saveOrders();
  return order;
}

export function getOrder(code) {
  const orders = getOrders();
  const order = orders[code] || null;
  if (!order) return null;

  if (isExpiredPendingOrder(order)) {
    order.status = 'expired';
    _orders = orders;
    saveOrders();
  }

  return order;
}

export function getOrdersByUser(userId) {
  const orders = getOrders();
  return Object.values(orders)
    .filter((o) => o.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function markOrderPaid(code, transactionId) {
  const orders = getOrders();
  const order = orders[code];
  if (!order || order.status !== 'pending') return null;

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.transactionId = transactionId;
  _orders = orders;
  saveOrders();
  return order;
}

export function findPendingOrderByCode(transferContent) {
  const orders = getOrders();
  const normalized = (transferContent || '').toUpperCase().replace(/\s+/g, '');

  for (const [code, order] of Object.entries(orders)) {
    if (order.status !== 'pending') continue;
    if (normalized.includes(code.toUpperCase())) return order;
  }
  return null;
}

export function cancelExpiredOrders(maxAgeMs = 24 * 60 * 60 * 1000) {
  const orders = getOrders();
  const now = Date.now();
  let count = 0;

  for (const order of Object.values(orders)) {
    if (order.status !== 'pending') continue;
    if (now - new Date(order.createdAt).getTime() > maxAgeMs) {
      order.status = 'expired';
      count++;
    }
  }

  if (count > 0) {
    _orders = orders;
    saveOrders();
  }
  return count;
}

// ─── Subscriptions ───────────────────────────────────────

let _subs = null;

function getSubs() {
  if (!_subs) _subs = loadJson(SUBSCRIPTIONS_FILE);
  return _subs;
}

function saveSubs() {
  saveJson(SUBSCRIPTIONS_FILE, _subs);
}

const PLAN_DURATION = {
  monthly: 30,
  yearly: 365,
};

export function activateSubscription(order) {
  const subs = getSubs();
  const days = PLAN_DURATION[order.period] || 30;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const existing = subs[order.userId];

  if (existing && existing.status === 'active' && new Date(existing.expiresAt) > new Date()) {
    const tierRank = { basic: 1, plus: 2, pro: 3 };
    const newRank = tierRank[order.planKey] ?? 0;
    const oldRank = tierRank[existing.planKey] ?? 0;

    if (newRank >= oldRank) {
      existing.planKey = order.planKey;
      const currentEnd = new Date(existing.expiresAt);
      existing.expiresAt = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      existing.updatedAt = new Date().toISOString();
      existing.lastOrderCode = order.code;
      _subs = subs;
      saveSubs();
      return existing;
    } else {
      const currentEnd = new Date(existing.expiresAt);
      existing.expiresAt = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      existing.updatedAt = new Date().toISOString();
      existing.lastOrderCode = order.code;
      _subs = subs;
      saveSubs();
      return existing;
    }
  }

  const sub = {
    userId: order.userId,
    userEmail: order.userEmail,
    planKey: order.planKey,
    status: 'active',
    startedAt: new Date().toISOString(),
    expiresAt,
    updatedAt: new Date().toISOString(),
    lastOrderCode: order.code,
  };

  subs[order.userId] = sub;
  _subs = subs;
  saveSubs();
  return sub;
}

export function getSubscription(userId) {
  const subs = getSubs();
  const sub = subs[userId];
  if (!sub) return null;

  if (sub.status === 'active' && new Date(sub.expiresAt) < new Date()) {
    sub.status = 'expired';
    _subs = subs;
    saveSubs();
  }

  return sub;
}

export function getAllSubscriptions() {
  return Object.values(getSubs());
}

export function getAllOrders() {
  return Object.values(getOrders());
}
