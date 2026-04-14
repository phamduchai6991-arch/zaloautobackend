import {
  createOrder,
  getOrder,
  getOrdersByUser,
  getSubscription,
  findPendingOrderByCode,
  markOrderPaid,
  activateSubscription,
  cancelExpiredOrders,
} from './paymentStore.js';

// ─── Config ──────────────────────────────────────────────

const SEPAY_API_KEY = process.env.SEPAY_API_KEY || 'autozalo_secret_123';

const BANK_INFO = {
  bankName: 'MBBank',
  accountNumber: '007061960',
  accountHolder: 'PHAM THI MAI',
};

const VALID_PLANS = {
  basic:  { monthly: 60000,  yearly: 300000 },
  plus:   { monthly: 120000, yearly: 600000 },
  pro:    { monthly: 240000, yearly: 1200000 },
};

// ─── Helpers ─────────────────────────────────────────────

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── Handlers ────────────────────────────────────────────

const TIER_RANK = { basic: 1, plus: 2, pro: 3 };
const PLAN_LABELS = { basic: 'BASIC', plus: 'PLUS', pro: 'PRO' };

export function handleCreateOrder(req, res, body) {
  const { userId, userEmail, planKey, period } = body || {};

  if (!userId || !userEmail) {
    return writeJson(res, 400, { ok: false, error: 'Thiếu thông tin người dùng (userId, userEmail).' });
  }
  if (!VALID_PLANS[planKey]) {
    return writeJson(res, 400, { ok: false, error: 'Gói không hợp lệ.' });
  }
  if (period !== 'monthly' && period !== 'yearly') {
    return writeJson(res, 400, { ok: false, error: 'Chu kỳ không hợp lệ (monthly/yearly).' });
  }

  // ── Check current subscription: block downgrades ──
  const currentSub = getSubscription(userId, userEmail);
  let discount = 0;          // prorated credit from current plan (VNĐ)
  let originalAmount = VALID_PLANS[planKey][period];

  if (currentSub && currentSub.status === 'active' && new Date(currentSub.expiresAt) > new Date()) {
    const currentRank = TIER_RANK[currentSub.planKey] ?? 0;
    const newRank = TIER_RANK[planKey] ?? 0;

    // Block downgrade
    if (newRank < currentRank) {
      return writeJson(res, 400, {
        ok: false,
        error: `Bạn đang dùng gói ${PLAN_LABELS[currentSub.planKey]}. Không thể mua gói thấp hơn. Hãy chọn gói ${PLAN_LABELS[currentSub.planKey]} hoặc cao hơn.`,
      });
    }

    // Same plan → allow renewal (no discount)
    // Upgrade → calculate prorated credit for remaining days
    if (newRank > currentRank) {
      const now = Date.now();
      const expiresAt = new Date(currentSub.expiresAt).getTime();
      const startedAt = new Date(currentSub.startedAt).getTime();
      const totalDuration = expiresAt - startedAt;
      const remaining = expiresAt - now;

      if (totalDuration > 0 && remaining > 0) {
        const remainingRatio = remaining / totalDuration;
        // How much the user originally paid for the current plan
        const currentPlanPrice = VALID_PLANS[currentSub.planKey]
          ? (VALID_PLANS[currentSub.planKey][period] || VALID_PLANS[currentSub.planKey]['monthly'])
          : 0;
        discount = Math.round(currentPlanPrice * remainingRatio);
      }
    }
  }

  const amount = Math.max(originalAmount - discount, 0);
  const order = createOrder({ userId, userEmail, planKey, period, amount });

  writeJson(res, 200, {
    ok: true,
    order: {
      code: order.code,
      amount: order.amount,
      planKey: order.planKey,
      period: order.period,
      status: order.status,
      createdAt: order.createdAt,
    },
    bank: BANK_INFO,
    transferContent: order.code,
    upgrade: discount > 0 ? { originalAmount, discount, finalAmount: amount } : null,
  });
}

export function handleGetOrder(req, res, code) {
  if (!code) return writeJson(res, 400, { ok: false, error: 'Thiếu mã đơn hàng.' });
  const order = getOrder(code);
  if (!order) return writeJson(res, 404, { ok: false, error: 'Đơn hàng không tồn tại.' });

  writeJson(res, 200, {
    ok: true,
    order: {
      code: order.code,
      planKey: order.planKey,
      period: order.period,
      amount: order.amount,
      status: order.status,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    },
  });
}

export function handleGetUserOrders(req, res, userId) {
  if (!userId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId.' });
  const orders = getOrdersByUser(userId);
  writeJson(res, 200, {
    ok: true,
    orders: orders.map((o) => ({
      code: o.code, planKey: o.planKey, period: o.period,
      amount: o.amount, status: o.status,
      createdAt: o.createdAt, paidAt: o.paidAt,
    })),
  });
}

export function handleGetSubscription(req, res, userId) {
  if (!userId) return writeJson(res, 400, { ok: false, error: 'Thiếu userId.' });
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const userEmail = requestUrl.searchParams.get('email') || '';
  const sub = getSubscription(userId, userEmail);
  writeJson(res, 200, {
    ok: true,
    subscription: sub
      ? { planKey: sub.planKey, status: sub.status, expiresAt: sub.expiresAt, startedAt: sub.startedAt }
      : null,
  });
}

// ─── SePay Webhook ───────────────────────────────────────

export function handleSepayWebhook(req, res, body) {
  const authHeader = req.headers['authorization'] || '';
  const providedKey = authHeader.replace(/^Apikey\s+/i, '').trim();

  if (providedKey !== SEPAY_API_KEY) {
    return writeJson(res, 401, { ok: false, error: 'Invalid API key.' });
  }

  const { id: transactionId, transferType, transferAmount, content, accountNumber } = body || {};

  if (transferType !== 'in') {
    return writeJson(res, 200, { ok: true, message: 'Ignored: not an incoming transfer.' });
  }
  if (accountNumber && accountNumber !== BANK_INFO.accountNumber) {
    return writeJson(res, 200, { ok: true, message: 'Ignored: different account.' });
  }
  if (!content) {
    return writeJson(res, 200, { ok: true, message: 'Ignored: no transfer content.' });
  }

  const order = findPendingOrderByCode(content);
  if (!order) {
    console.log(`[payment] No matching order for content: "${content}"`);
    return writeJson(res, 200, { ok: true, message: 'No matching order found.' });
  }

  if (Number(transferAmount) < order.amount) {
    console.log(`[payment] Amount mismatch: got ${transferAmount}, expected ${order.amount} for ${order.code}`);
    return writeJson(res, 200, { ok: true, message: 'Amount insufficient.' });
  }

  const paidOrder = markOrderPaid(order.code, transactionId);
  if (!paidOrder) {
    return writeJson(res, 200, { ok: true, message: 'Order already processed.' });
  }

  const sub = activateSubscription(paidOrder);
  console.log(`[payment] ✓ Order ${paidOrder.code} paid. Plan: ${paidOrder.planKey}/${paidOrder.period}. User: ${paidOrder.userEmail}. Expires: ${sub.expiresAt}`);

  writeJson(res, 200, { ok: true, message: 'Payment confirmed.', orderCode: paidOrder.code });
}

export function cleanupExpiredOrders() {
  const count = cancelExpiredOrders();
  if (count > 0) console.log(`[payment] Cleaned up ${count} expired orders.`);
}

export { writeJson, readBody };
