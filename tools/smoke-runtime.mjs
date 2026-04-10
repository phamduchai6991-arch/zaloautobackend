const checks = [];

async function probeJson(name, url, expectedStatus = 200, init = undefined) {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      ...(init || {}),
    });
    const text = await response.text();
    let parsed = null;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    checks.push({
      name,
      ok: response.status === expectedStatus,
      status: response.status,
      body: parsed ?? text,
    });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      status: 'NETWORK_ERROR',
      body: error instanceof Error ? error.message : String(error),
    });
  }
}

async function probeText(name, url, expectedStatus = 200) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    checks.push({
      name,
      ok: response.status === expectedStatus,
      status: response.status,
      body: text.slice(0, 200),
    });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      status: 'NETWORK_ERROR',
      body: error instanceof Error ? error.message : String(error),
    });
  }
}

await probeJson('service-health', 'http://127.0.0.1:4517/health');
await probeJson('service-action-validation', 'http://127.0.0.1:4517/api/zalo/actions/batch', 400, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: '{}',
});
await probeText('frontend-preview', 'http://127.0.0.1:4173/');

const failedChecks = checks.filter((check) => !check.ok);

console.log(JSON.stringify({
  ok: failedChecks.length === 0,
  checks,
}, null, 2));

if (failedChecks.length > 0) {
  process.exitCode = 1;
}