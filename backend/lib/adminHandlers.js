import { createHmac, timingSafeEqual } from 'node:crypto';
import { getAllSubscriptions, getAllOrders } from './paymentStore.js';
import { getAllUsers } from './userStore.js';

const PLAN_LIMITS = { basic: 1, plus: 3, pro: 10 };
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

// Default credentials — override via env vars
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || 'Duchai0426';

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signTokenPayload(payload) {
  return createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
}

function issueAdminToken(username) {
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  const payload = toBase64Url(JSON.stringify({ username, exp: expiresAt }));
  const signature = signTokenPayload(payload);
  return {
    token: `${payload}.${signature}`,
    expiresAt,
  };
}

function verifyAdminToken(token) {
  if (!token || !token.includes('.')) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = signTokenPayload(payload);
  const left = Buffer.from(signature, 'utf-8');
  const right = Buffer.from(expected, 'utf-8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return decoded?.username === ADMIN_USERNAME && Number(decoded?.exp) > Date.now();
  } catch {
    return false;
  }
}

function isRecentlyActive(lastSeenAt) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() <= ACTIVE_WINDOW_MS;
}

function requireAdmin(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyAdminToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized.' }));
    return false;
  }
  return true;
}

export function handleAdminLogin(req, res, body) {
  const { username, password } = body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_SECRET) {
    const session = issueAdminToken(username);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token: session.token, expiresAt: session.expiresAt }));
  } else {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Tài khoản hoặc mật khẩu không đúng.' }));
  }
}

export function handleAdminStats(req, res) {
  if (!requireAdmin(req, res)) return;

  const users = getAllUsers();
  const subs = getAllSubscriptions();
  const orders = getAllOrders();

  const userIds = new Set(users.map((u) => u.userId));
  const subUserIds = new Set(subs.map((s) => s.userId));
  const orderUserIds = new Set(orders.map((o) => o.userId));
  const allUserIds = new Set([...userIds, ...subUserIds, ...orderUserIds]);

  const activeSubs = subs.filter((s) => s.status === 'active').length;
  const expiredSubs = subs.filter((s) => s.status === 'expired').length;
  const freeUsers = [...allUserIds].filter((id) => !subUserIds.has(id)).length;
  const activeUsers = users.filter((u) => isRecentlyActive(u.lastSeenAt)).length;

  const paidOrders = orders.filter((o) => o.status === 'paid');
  const totalRevenue = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

  const revenueByPlan = { basic: 0, plus: 0, pro: 0 };
  for (const o of paidOrders) {
    if (revenueByPlan[o.planKey] !== undefined) {
      revenueByPlan[o.planKey] += o.amount || 0;
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    stats: {
      totalUsers: allUserIds.size,
      activeUsers,
      activeSubs,
      expiredSubs,
      freeUsers,
      totalRevenue,
      revenueByPlan,
      paidOrders: paidOrders.length,
      pendingOrders: orders.filter((o) => o.status === 'pending').length,
      cancelledOrders: orders.filter((o) => o.status === 'expired' || o.status === 'cancelled').length,
    },
  }));
}

export function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;

  const users = getAllUsers();
  const subs = getAllSubscriptions();
  const orders = getAllOrders();

  const userMap = {};

  for (const user of users) {
    userMap[user.userId] = {
      userId: user.userId,
      email: user.email || '—',
      name: user.name || '',
      picture: user.picture || '',
      lastSeenAt: user.lastSeenAt || null,
      isUsing: isRecentlyActive(user.lastSeenAt),
      planKey: null,
      status: 'free',
      startedAt: null,
      expiresAt: null,
      maxAccounts: 0,
      orderCount: 0,
      totalSpent: 0,
    };
  }

  for (const order of orders) {
    if (!userMap[order.userId]) {
      userMap[order.userId] = {
        userId: order.userId,
        email: order.userEmail || '—',
        name: '',
        picture: '',
        lastSeenAt: null,
        isUsing: false,
        planKey: null,
        status: 'free',
        startedAt: null,
        expiresAt: null,
        maxAccounts: 0,
        orderCount: 0,
        totalSpent: 0,
      };
    }
    userMap[order.userId].orderCount++;
    if (order.status === 'paid') userMap[order.userId].totalSpent += order.amount || 0;
  }

  for (const sub of subs) {
    if (!userMap[sub.userId]) {
      userMap[sub.userId] = {
        userId: sub.userId,
        email: sub.userEmail || '—',
        name: '',
        picture: '',
        lastSeenAt: null,
        isUsing: false,
        planKey: null,
        status: 'free',
        startedAt: null,
        expiresAt: null,
        maxAccounts: 0,
        orderCount: 0,
        totalSpent: 0,
      };
    }
    userMap[sub.userId].planKey = sub.planKey;
    userMap[sub.userId].status = sub.status;
    userMap[sub.userId].startedAt = sub.startedAt;
    userMap[sub.userId].expiresAt = sub.expiresAt;
    userMap[sub.userId].maxAccounts = PLAN_LIMITS[sub.planKey] || 0;
    if (sub.userEmail) userMap[sub.userId].email = sub.userEmail;
  }

  const userRows = Object.values(userMap).sort((a, b) => {
    const rank = { active: 0, expired: 1, free: 2 };
    const ra = rank[a.status] ?? 3;
    const rb = rank[b.status] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.isUsing !== b.isUsing) return a.isUsing ? -1 : 1;
    return (b.totalSpent || 0) - (a.totalSpent || 0);
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, users: userRows }));
}

export function handleAdminOrders(req, res) {
  if (!requireAdmin(req, res)) return;

  const orders = getAllOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, orders }));
}