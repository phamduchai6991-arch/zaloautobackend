# AutoZalo Backend

Backend server + Zalo API bridge + Chrome extension cho AutoZalo.vn.

---

## Cấu trúc dự án

```
zaloweb/                          ← Workspace (KHÔNG phải git repo)
│
├── zaloautobackend/              ← Git repo này (backend + extension)
│   ├── backend/                  — Payment API, webhook SePay (port 3000)
│   │   ├── server.js
│   │   └── lib/                  — paymentHandlers, paymentStore, adminHandlers
│   ├── service/                  — Zalo API bridge local (port 4517)
│   │   ├── server.js
│   │   └── lib/                  — apiClient, handlers, http, config
│   ├── extension/                — ⭐ Chrome Extension MV3 (SOURCE OF TRUTH)
│   │   ├── manifest.json
│   │   ├── background.js
│   │   └── content/
│   │       ├── zalo-main.js      — Script chạy trong MAIN world của Zalo tab
│   │       ├── zalo-bridge.js    — Relay giữa MAIN world và extension
│   │       └── web-bridge.js     — Bridge cho các trang web khác (frontend)
│   ├── tools/                    — Scripts dev/debug
│   │   ├── sync-to-browser.cjs   — ⭐ Đồng bộ extension → Chrome đang mở
│   │   ├── zip-extension.mjs     — Build zip cho người dùng tải
│   │   ├── inspection/           — Kiểm tra state của Chrome/extension
│   │   └── testing/              — Test các API của Zalo
│   └── reference/                — Tài liệu tham khảo (không deploy)
│
└── frontend/                     ← Git repo riêng (React + Vite)
    ├── src/
    └── public/
        └── autozalo-extension.zip  — Zip extension cho người dùng tải
```

> **Lưu ý quan trọng**: Chỉ có 2 git repo:
> - `zaloautobackend/` → `github.com/phamduchai6991-arch/zaloautobackend`
> - `frontend/` → `github.com/phamduchai6991-arch/zaloautofrontend`

---

## Setup lần đầu

```bash
# 1. Cài dependencies
cd zaloautobackend
npm install
cd service && npm install --ignore-scripts && cd ..

# 2. Tạo file môi trường
cp backend/.env.example backend/.env
# Điền các giá trị vào backend/.env

# 3. Chạy dev
npm run dev
```

---

## Commands

| Command | Mô tả |
|---------|-------|
| `npm run dev` | Chạy backend + zalo service cùng lúc |
| `npm run dev:backend` | Chỉ chạy payment backend (port 3000) |
| `npm run dev:zalo` | Chỉ chạy Zalo API bridge (port 4517) |
| `npm start` | Production (backend only) |
| `npm run pack:ext` | Build zip extension → `frontend/public/autozalo-extension.zip` |

---

## Environment Variables

| Variable | File | Mô tả |
|----------|------|-------|
| `PORT` | `backend/.env` | Backend port (default: 3000) |
| `SEPAY_API_KEY` | `backend/.env` | SePay webhook API key |
| `ADMIN_USERNAME` | `backend/.env` | Username đăng nhập trang /admin |
| `ADMIN_SECRET` | `backend/.env` | Password trang /admin |
| `ZALOWEB_ALLOWED_ORIGINS` | env | CORS origins, phân cách bằng dấu phẩy |
| `GOOGLE_CLIENT_IDS` | `backend/.env` | Danh sách Google Client ID hợp lệ (phân cách dấu phẩy) |
| `SESSION_SECRET` | `backend/.env` | Secret ký token phiên nội bộ (bắt buộc set trên production) |
| `FRONTEND_DIST_DIR` | env | Path tới built frontend dist (optional) |

---

## Workflow phát triển Extension

### Chỉnh sửa code extension

1. Sửa file trong `extension/` (hoặc `extension/content/`)
2. Đồng bộ vào Chrome:

```bash
# Copy files → Chrome đang mở + reload extension
node tools/sync-to-browser.cjs --reload

# Copy + reload extension + reload Zalo tab
node tools/sync-to-browser.cjs --reload --reload-tab
```

3. Test, lặp lại bước 1-2

### Deploy extension cho người dùng

```bash
# Build zip mới
npm run pack:ext

# Commit và push cả 2 repo
git add extension/ tools/ ; git commit -m "..." ; git push

cd ../frontend
git add public/autozalo-extension.zip ; git commit -m "chore: update extension zip" ; git push
```

> Render sẽ tự redeploy frontend sau khi push.

---

## Cấu trúc Chrome Extension

Extension chạy theo 3 lớp:

```
Trang web (AutoZalo.vn)
    ↕ window.postMessage
content/web-bridge.js         — ISOLATED world, relay message
    ↕ chrome.runtime.sendMessage
background.js                 — Service worker, routing
    ↕ chrome.tabs.sendMessage
content/zalo-bridge.js        — ISOLATED world trong Zalo tab
    ↕ window.postMessage + CustomEvent
content/zalo-main.js          — MAIN world, truy cập Webpack/Zalo API trực tiếp
```

**API Bridge** — gọi từ frontend:
```javascript
// Gửi lệnh
window.postMessage({ source: '__zalotool_api__', callId: 'abc', method: 'getMessageHistory', args: { threadId: '...', isGroup: false, count: 20 } }, '*');

// Nhận kết quả
window.addEventListener('__zalotool_api_result__', (e) => {
  const { callId, ok, data } = JSON.parse(e.detail);
});
```

**Các method hiện có:**

| Method | Tham số | Mô tả |
|--------|---------|-------|
| `checkApiReady` | — | Kiểm tra extension đã khởi tạo |
| `getConversationList` | — | Lấy danh sách hội thoại |
| `getMessageHistory` | `threadId, isGroup, count` | Lấy lịch sử tin nhắn |
| `sendMessage` | `threadId, isGroup, content` | Gửi tin nhắn |
| `debugGetMessageHistory` | `threadId` | Debug chi tiết getCM |
| `debugModuleMethods` | — | Liệt kê Webpack module methods |

---

## Debug Chrome DevTools (CDP)

Chrome chạy với remote debugging ở port 9222:

```bash
# Kiểm tra kết nối
curl http://localhost:9222/json

# Chạy scripts debug
node tools/inspection/check-tab-state.cjs <TAB_ID>
node tools/testing/test-decrypt-direct.cjs <TAB_ID>
```

> Tab ID của Zalo lấy từ `http://localhost:9222/json`.

---

## Lưu ý quan trọng

- **KHÔNG** gọi `enc.setDecryptKey()` trong lúc debug — sẽ làm hỏng AES key của session
- **KHÔNG** reload Zalo tab khi đang test — user sẽ bị đăng xuất  
- Extension load từ `Downloads/autozalo-extension (27)/` — luôn chạy `sync-to-browser.cjs` sau khi sửa code
- getCM response có **3 lớp decode**: `response.data.data` (AES) → `{error_code, data: "<JSON>"}` → `JSON.parse(data)` → `{groupMsgs|msgs}`


## Structure

```
├── backend/           — Payment API + static serving (port 3000)
│   ├── server.js      — HTTP server, SePay webhook
│   └── lib/           — paymentHandlers, paymentStore
├── service/           — Local Zalo API bridge (port 4517)
│   ├── server.js      — HTTP entrypoint
│   └── lib/           — apiClient, handlers, http, config
├── extension/         — Chrome MV3 extension
│   ├── manifest.json
│   ├── background.js
│   └── content/       — web-bridge, zalo-bridge, zalo-main
├── reference/         — Local packages & API docs
│   └── zalo-api-final/ — Zalo API npm package
└── tools/             — Dev & inspection scripts
```

## Setup

```bash
npm install                                       # root (concurrently)
cd service && npm install --ignore-scripts && cd ..  # zalo service deps
cp backend/.env.example backend/.env              # cấu hình secrets
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend + zalo service |
| `npm run dev:backend` | Payment backend only (port 3000) |
| `npm run dev:zalo` | Zalo API bridge only (port 4517) |
| `npm start` | Production start (backend only) |
| `npm run pack:ext` | Pack Chrome extension zip |

## Environment Variables

| Variable | Location | Description |
|----------|----------|-------------|
| `PORT` | `backend/.env` | Backend port (default: 3000) |
| `SEPAY_API_KEY` | `backend/.env` | SePay webhook API key |
| `ADMIN_USERNAME` | `backend/.env` | Admin username for `/admin` login |
| `ADMIN_SECRET` | `backend/.env` | Admin password secret |
| `ZALOWEB_ALLOWED_ORIGINS` | env | Trusted origins for CORS, comma-separated |
| `GOOGLE_CLIENT_IDS` | `backend/.env` | Trusted Google OAuth client IDs, comma-separated |
| `SESSION_SECRET` | `backend/.env` | Secret for signing persistent app session tokens |
| `FRONTEND_DIST_DIR` | env | Optional absolute or relative path to built frontend dist |

## Deployment

Backend can run in two deployment modes:

- Monolith mode: serve the built frontend from this service by setting `FRONTEND_DIST_DIR`.
- API-only mode: deploy this repo alone and point the frontend to this backend with `VITE_BACKEND_URL`.

### Render web service

This repo now includes `render.yaml` for a basic free Render deployment.

Required environment variables on Render:

- `ADMIN_SECRET`
- `SEPAY_API_KEY`
- `ZALOWEB_ALLOWED_ORIGINS` = frontend domain, for example `https://autozalo-frontend.onrender.com`

Recommended health check path:

- `/api/health`

Important limitation for free testing:

- Orders, subscriptions, and users are stored in JSON files. On a free Render instance, filesystem data is ephemeral and can reset after restart or cold redeploy. That is acceptable for a short test, but not for production billing.

```
Server (autozalo.vn)
┌────────────────────┐
│  backend/server.js │
│  - Serve frontend  │
│  - Payment API     │
│  - SePay webhook   │
└────────────────────┘
```

The `service/` (Zalo bridge) runs locally on user machines only — never deployed.
