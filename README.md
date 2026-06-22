# Liberdus Status – Frontend Only

This document only covers how to run the **frontend** and point it at an existing status backend.

## Files

- `index.html` – main page for the status dashboard.
- `style.css` – layout and styles.
- `main.js` – frontend logic that talks to the backend API.

## Connecting to the backend

The frontend calls a small backend service that exposes:

- `GET /api/summary`
- `GET /api/history`
- `GET /health`

By default, the frontend expects the backend at:

- `https://status.liberdus.com`

You can change this in two ways.

### Option 1: Use window.LIBERDUS_STATUS_API (recommended)

Before loading `main.js`, set `window.LIBERDUS_STATUS_API` in `index.html`:

```html
<script>
  window.LIBERDUS_STATUS_API = "https://status.example.com";
</script>
<script src="main.js"></script>
```

If `window.LIBERDUS_STATUS_API` is set to a string, the frontend uses it as the base URL for all API calls.

### Option 2: Use the default localhost URL

If you do **not** set `window.LIBERDUS_STATUS_API`, the frontend uses:

```js
https://status.liberdus.com
```

Make sure your backend is reachable at that origin.

If the summary request fails, the dashboard shows:

```text
Status fetch failed. Please check again later.
```

No mock service data is shown when the backend is unavailable.

## Choosing the network (Devnet vs Testnet)

The frontend has a network dropdown in the top-right of the “Service status” card:

- **Devnet** (default)
- **Testnet**

This control changes the `?network=` query parameter sent to the backend, so the same dashboard can show either Devnet or Testnet data from the same backend.

You do not need to edit the code to switch networks; just use the dropdown.

## How to open the frontend

For simple usage:

1. Ensure the backend is running and reachable (for example at `http://localhost:7070` or your configured URL).
2. Open `index.html` in a browser (double-click it or serve it with a static web server).
3. If you changed the backend URL, confirm:
   - Either `window.LIBERDUS_STATUS_API` is set correctly in `index.html`, **or**
   - The backend is running at `http://localhost:7070`.

The dashboard should load and start showing the current status and uptime history from the configured backend.

When the backend includes a Discord bot service, such as `discord-status-bot`,
the dashboard groups it under “Discord Bot” and displays whether it is
`Active` or `Down`.

## Local outage demo

For local demos, run the static UI and mock backend in separate terminals:

```bash
python3 -m http.server 4177
node mock-status-backend.mjs
```

Then open:

```text
http://localhost:4177/local-demo.html
```

The demo page includes controls for all-up, Discord-down, site-down, and
backend-fetch-failed states without changing the production backend.
