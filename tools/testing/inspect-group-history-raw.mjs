#!/usr/bin/env node
import process from 'node:process';
import { getAccount } from '../../backend/lib/accountStore.js';
import { createApiClient } from '../../service/lib/apiClient.js';
import { ensureCustomApiActions } from '../../service/lib/handlers.js';
import { decodeAES } from '../../reference/zalo-api-final/dist/utils.js';

const ownerUserId = String(process.argv[2] || '').trim();
const zaloId = String(process.argv[3] || '').trim();
const groupId = String(process.argv[4] || '').trim();
const count = Math.max(1, Number(process.argv[5] || 10) || 10);

if (!ownerUserId || !zaloId || !groupId) {
  console.error('Usage: node tools/testing/inspect-group-history-raw.mjs <ownerUserId> <zaloId> <groupId> [count]');
  process.exit(1);
}

const account = await getAccount(ownerUserId, zaloId);
if (!account) {
  console.error('Account not found');
  process.exit(2);
}

const { api } = await createApiClient(account, account.userAgent || 'Mozilla/5.0');
ensureCustomApiActions(api);

if (typeof api.custom === 'function') {
  api.custom('inspectRawCM', async ({ ctx, utils, props }) => {
    const cmHost = String(
      api?.zpwServiceMap?.group_cloud_message?.[0]
      || api?.zpwServiceMap?.conversation?.[0]
      || 'https://tt-group-cm.chat.zalo.me'
    ).replace(/\/$/, '');
    const serviceURL = utils.makeURL(`${cmHost}/api/cm/getrecentv2`);
    const encryptedParams = utils.encodeAES(JSON.stringify({
      groupId: String(props?.groupId || ''),
      globalMsgId: Number(props?.globalMsgId) || 0,
      count: Number(props?.count) || 10,
      imei: ctx.imei,
    }));
    const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams, nretry: 0 }), {
      method: 'GET',
    });
    const json = await response.json();
    const decoded = typeof json?.data === 'string' ? JSON.parse(decodeAES(ctx.secretKey, json.data)) : json;
    return { json, decoded };
  });
}

try {
  const rawResult = await api.inspectRawCM({ groupId, globalMsgId: 0, count });
  console.log('=== inspectRawCM OK ===');
  console.log(JSON.stringify(rawResult, null, 2).slice(0, 12000));
} catch (error) {
  console.log('=== inspectRawCM ERROR ===');
  console.log(JSON.stringify({ message: error?.message, code: error?.code, stack: error?.stack }, null, 2));
}

for (const label of ['getCM', 'getRecentGroup', 'getHistoryMessage']) {
  try {
    const result = await api[label]({ groupId, globalMsgId: 0, count });
    console.log(`=== ${label} OK ===`);
    console.log(JSON.stringify(result, null, 2).slice(0, 12000));
  } catch (error) {
    console.log(`=== ${label} ERROR ===`);
    console.log(JSON.stringify({ message: error?.message, code: error?.code, stack: error?.stack }, null, 2));
  }
}
