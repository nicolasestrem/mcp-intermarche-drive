# MCP Intermarché Drive

Unofficial MCP server for **Intermarché Courses / Drive**. It searches the catalogue of the store selected in Intermarché and manages the current basket through one visible Chromium tab.

The server is modeled on [`mcp-leclerc-drive`](https://github.com/skunkobi/mcp-leclerc-drive), but the Intermarché adapter and tool contract are independent. It is not affiliated with Intermarché.

## Why a real browser?

Intermarché uses DataDome. Replaying cookies from a headless HTTP client is fragile and unsafe. This server instead:

- attaches to a real Chromium over the Chrome DevTools Protocol (CDP);
- executes same-origin `fetch` calls inside that tab;
- never reads auth cookies or tokens; it reads only Intermarché's non-auth
  `itm_device_id` / `itm_usid` browser identifiers required by the web API and
  never exposes them in MCP results or files;
- serializes and spaces requests;
- reuses **one tab only**—it does not spray tabs and wreck the session;
- stops and asks for manual action if DataDome presents a challenge.

The dedicated Chromium profile retains the normal browser login. Login, store selection, CAPTCHA resolution and checkout stay visible and human-controlled.

## Scope and safety

Available tools:

| Tool | Effect |
|---|---|
| `browser_status` | Checks CDP, selected store and DataDome state |
| `search_product` | Searches the active store catalogue |
| `get_cart` | Reads the complete basket |
| `add_to_cart` | Adds a quantity; substitutions default to **false** |
| `update_quantity` | Sets an absolute quantity; `0` removes the line |
| `remove_from_cart` | Removes one line |
| `set_substitution` | Explicitly changes substitution consent |

There is deliberately **no checkout, order, payment or slot-booking tool**. Final review and purchase remain manual on the Intermarché website.

## Requirements

- Node.js 22 or newer
- Visible Chromium or Google Chrome
- An Intermarché store and Drive mode selected in the browser

## Install

```bash
git clone https://github.com/nicolasestrem/mcp-intermarche-drive.git
cd mcp-intermarche-drive
npm ci
npm run build
npm test
npm run smoke
```

## First run

By default, the server starts a dedicated visible Chromium profile in `~/.mcp-intermarche-drive/chrome` on CDP port `9222`.

1. Start the MCP server from your MCP client.
2. In the Chromium window, open Intermarché if it is not already open.
3. Select the store and **Drive** mode.
4. Log in if you want the website account session to be active.
5. Resolve DataDome manually if prompted.
6. Call `browser_status`, then `search_product`.

Do not open additional Intermarché tabs in this profile. Keep the single tab as the canonical browser state.

## MCP client configuration

```json
{
  "mcpServers": {
    "intermarche-drive": {
      "command": "node",
      "args": ["/absolute/path/mcp-intermarche-drive/dist/src/index.js"],
      "env": {
        "INTERMARCHE_AUTO_LAUNCH": "true"
      }
    }
  }
}
```

To attach to Chromium you already launch yourself:

```json
{
  "env": {
    "INTERMARCHE_AUTO_LAUNCH": "false",
    "INTERMARCHE_CHROME_PORT": "9222"
  }
}
```

Launch that browser with a loopback-only debugging endpoint, for example:

```bash
chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.mcp-intermarche-drive/chrome" \
  --no-first-run --no-default-browser-check about:blank
```

Never expose the CDP port to the network. Anyone who can reach it can control that browser.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `INTERMARCHE_CHROME_PORT` | `9222` | Local CDP port |
| `INTERMARCHE_CHROME_PATH` | auto-detected | Chromium/Chrome executable |
| `INTERMARCHE_CHROME_PROFILE_DIR` | `~/.mcp-intermarche-drive/chrome` | Dedicated persistent profile |
| `INTERMARCHE_AUTO_LAUNCH` | `true` | Start Chromium when CDP is absent |
| `INTERMARCHE_HEADLESS` | `false` | Not recommended; DataDome detects headless browsers |
| `INTERMARCHE_PDV_REF` | browser-derived | Store reference fallback |
| `INTERMARCHE_CATALOG_ID` | `641` | Legacy catalogue metadata fallback |
| `INTERMARCHE_MIN_INTERVAL_MS` | `1100` | Minimum spacing between requests |
| `INTERMARCHE_JITTER_MS` | `500` | Extra randomized spacing |
| `INTERMARCHE_MAX_RETRIES` | `2` | Retries for HTTP 403/429 |
| `INTERMARCHE_BACKOFF_BASE_MS` | `1800` | Retry backoff base |
| `INTERMARCHE_CDP_TIMEOUT_MS` | `30000` | CDP command timeout |

If automatic store discovery does not find the browser's selected store, call `browser_status` and set `INTERMARCHE_PDV_REF` to the store reference shown by the site/network state.

## Development

```bash
npm run typecheck
npm test
npm run smoke
```

- Unit tests cover browser-state extraction, current product/cart normalization and event-based basket synchronization.
- The smoke test speaks JSON-RPC over stdio and verifies the real MCP initialization and `tools/list` path without opening Chromium.
- See [`docs/api-notes.md`](docs/api-notes.md) for the current web-adapter contract.

## Limitations

Intermarché's website endpoints are private and undocumented. They can change without notice. The adapter intentionally isolates those assumptions in `src/intermarche/` and normalizes several observed response shapes, but a future website release may require an update.

DataDome is not bypassed. A challenge always requires the user in the visible browser.

## License

MIT. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
