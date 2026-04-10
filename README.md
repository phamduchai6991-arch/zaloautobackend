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
| `ZALOWEB_ALLOWED_ORIGINS` | env | Trusted origins for CORS |

## Deployment

Backend serves the built frontend (place `dist/` in `backend/` or configure `DIST_DIR`).

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
