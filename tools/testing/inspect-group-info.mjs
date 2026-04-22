#!/usr/bin/env node
import process from 'node:process';
import { getAccount } from '../../backend/lib/accountStore.js';
import { createApiClient } from '../../service/lib/apiClient.js';

const ownerUserId = String(process.argv[2] || '').trim();
const zaloId = String(process.argv[3] || '').trim();
const groupId = String(process.argv[4] || '').trim();

if (!ownerUserId || !zaloId || !groupId) {
  console.error('Usage: node tools/testing/inspect-group-info.mjs <ownerUserId> <zaloId> <groupId>');
  process.exit(1);
}

const account = await getAccount(ownerUserId, zaloId);
if (!account) {
  console.error('Account not found');
  process.exit(2);
}

const { api } = await createApiClient(account, account.userAgent || 'Mozilla/5.0');
let raw = null;

try {
  const result = await api.getGroupInfo([groupId]);
  raw = result?.gridInfoMap?.[groupId] || result?.data?.gridInfoMap?.[groupId] || null;
} catch (_) {
  const allGroups = await api.getAllGroups();
  const rawMap = allGroups?.gridVerMap || allGroups?.gridInfoMap || allGroups?.data?.gridInfoMap || {};
  raw = rawMap?.[groupId] || null;
}

console.log(JSON.stringify(raw, null, 2));
