import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

let _users = null;

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

function getUsersMap() {
  if (!_users) _users = loadJson(USERS_FILE);
  return _users;
}

function saveUsers() {
  saveJson(USERS_FILE, _users);
}

export function upsertUser(user) {
  if (!user?.userId) return null;

  const users = getUsersMap();
  const existing = users[user.userId] || {};
  const now = new Date().toISOString();

  const next = {
    userId: user.userId,
    email: user.email || existing.email || '',
    name: user.name || existing.name || '',
    picture: user.picture || existing.picture || '',
    createdAt: existing.createdAt || now,
    lastSeenAt: now,
    updatedAt: now,
  };

  users[user.userId] = next;
  _users = users;
  saveUsers();
  return next;
}

export function getAllUsers() {
  return Object.values(getUsersMap());
}