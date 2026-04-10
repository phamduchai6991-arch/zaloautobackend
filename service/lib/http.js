import { isAllowedWebOrigin } from './config.js';

function appendVaryHeader(res, value) {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', value);
    return;
  }

  const values = String(current)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!values.includes(value)) {
    values.push(value);
    res.setHeader('Vary', values.join(', '));
  }
}

export function getRequestOrigin(req) {
  const originHeader = req?.headers?.origin;
  return typeof originHeader === 'string' ? originHeader : '';
}

export function hasAllowedOrigin(req) {
  const origin = getRequestOrigin(req);
  return !origin || isAllowedWebOrigin(origin);
}

export function setCorsHeaders(res, req) {
  const origin = getRequestOrigin(req);
  if (origin && isAllowedWebOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', new URL(origin).origin);
    appendVaryHeader(res, 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Agent');
}

export function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('Body JSON không hợp lệ.'));
      }
    });

    req.on('error', reject);
  });
}