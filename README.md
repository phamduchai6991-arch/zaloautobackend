# AutoZalo Backend

Backend server + Zalo API bridge + Chrome extension cho AutoZalo.

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
