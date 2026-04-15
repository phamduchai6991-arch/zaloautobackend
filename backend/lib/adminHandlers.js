import { createHmac, timingSafeEqual } from 'node:crypto';
import { getAllSubscriptions, getAllOrders, grantAdminSubscription } from './paymentStore.js';
import { getAllUsers } from './userStore.js';
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listGroups,
  bulkAddGroups,
  updateGroup,
  deleteGroup,
  deleteGroupsByCategory,
  getGroupCount,
  getCategoryCount,
} from './groupLibraryStore.js';

const PLAN_LIMITS = { basic: 1, plus: 3, pro: 10 };
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const VALID_PLAN_KEYS = new Set(['basic', 'plus', 'pro']);
const VALID_PERIODS = new Set(['monthly', 'yearly']);

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

function decodeAdminToken(token) {
  if (!token || !token.includes('.')) return null;

  const [payload] = token.split('.');
  if (!payload) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
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

function getAdminUsername(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return decodeAdminToken(token)?.username || ADMIN_USERNAME;
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

export async function handleAdminStats(req, res) {
  if (!requireAdmin(req, res)) return;

  const users = await getAllUsers();
  const subs = await getAllSubscriptions();
  const orders = await getAllOrders();

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

export async function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;

  const users = await getAllUsers();
  const subs = await getAllSubscriptions();
  const orders = await getAllOrders();

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

export async function handleAdminOrders(req, res) {
  if (!requireAdmin(req, res)) return;

  const orders = (await getAllOrders()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, orders }));
}

export async function handleAdminGrantSubscription(req, res, body) {
  if (!requireAdmin(req, res)) return;

  const { userId, userEmail, planKey, period } = body || {};

  if (!userId || !String(userId).trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu userId để cấp gói.' }));
    return;
  }

  if (!userEmail || !String(userEmail).trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu email người dùng.' }));
    return;
  }

  if (!VALID_PLAN_KEYS.has(planKey)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Gói không hợp lệ.' }));
    return;
  }

  if (!VALID_PERIODS.has(period)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Kỳ hạn không hợp lệ.' }));
    return;
  }

  const adminUsername = getAdminUsername(req);
  const result = await grantAdminSubscription({
    userId: String(userId).trim(),
    userEmail: String(userEmail).trim(),
    planKey,
    period,
    adminUsername,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    order: result.order,
    subscription: result.subscription,
    message: 'Đã cấp gói thành công.',
  }));
}

// ─── Group Library Admin Handlers ───

export async function handleAdminListCategories(req, res) {
  if (!requireAdmin(req, res)) return;
  const categories = await listCategories();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, categories }));
}

export async function handleAdminCreateCategory(req, res, body) {
  if (!requireAdmin(req, res)) return;
  const { name, color, sortOrder } = body || {};
  if (!name?.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu tên danh mục.' }));
    return;
  }
  const category = await createCategory(name, color, sortOrder);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, category }));
}

export async function handleAdminUpdateCategory(req, res, body) {
  if (!requireAdmin(req, res)) return;
  const { id, name, color, sortOrder } = body || {};
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu id danh mục.' }));
    return;
  }
  const category = await updateCategory(id, { name, color, sortOrder });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, category }));
}

export async function handleAdminDeleteCategory(req, res, body) {
  if (!requireAdmin(req, res)) return;
  const { id, deleteGroups } = body || {};
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu id danh mục.' }));
    return;
  }
  if (deleteGroups) await deleteGroupsByCategory(id);
  await deleteCategory(id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

export async function handleAdminListGroups(req, res, params) {
  if (!requireAdmin(req, res)) return;
  const groups = await listGroups(params);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, groups }));
}

export async function handleAdminBulkAddGroups(req, res, body) {
  if (!requireAdmin(req, res)) return;
  const { lines, categoryId } = body || {};
  if (!lines?.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu dữ liệu nhóm.' }));
    return;
  }
  const adminUsername = getAdminUsername(req);
  const inserted = await bulkAddGroups(lines, categoryId, adminUsername);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count: inserted.length, groups: inserted }));
}

export async function handleAdminUpdateGroup(req, res, body) {
  if (!requireAdmin(req, res)) return;
  const { id, name, inviteLink, description, categoryId, memberCount } = body || {};
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu id nhóm.' }));
    return;
  }
  const group = await updateGroup(id, { name, inviteLink, description, categoryId, memberCount });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, group }));
}

export async function handleAdminDeleteGroup(req, res, body) {
  if (!requireAdmin(req, res)) return;
  const { id } = body || {};
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Thiếu id nhóm.' }));
    return;
  }
  await deleteGroup(id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

export async function handleAdminGroupLibraryStats(req, res) {
  if (!requireAdmin(req, res)) return;
  const [groupCount, categoryCount] = await Promise.all([getGroupCount(), getCategoryCount()]);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, groupCount, categoryCount }));
}