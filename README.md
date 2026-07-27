# mcp-intermarche-drive

Unofficial MCP server for Intermarché Courses / Drive. It searches the catalogue of the store selected in Intermarché and reads or updates the current basket through one visible Chromium tab.

It does not place orders. Checkout, payment, account changes, and delivery-slot booking stay on the website.

## Current status

This is an early adapter for a private, undocumented web API.

- TypeScript build, unit tests, MCP initialization, `tools/list`, and tool annotations pass locally.
- Product search and basket retrieval were checked against the live Intermarché frontend on 2026-07-27.
- Basket writes are covered by tests against the event contract observed in the site. The automated live smoke test is deliberately read-only, so it does not prove that every write still works after an Intermarché release.
- The project is not published to npm. Install it from source.

Review the basket in the visible Intermarché tab before checkout. A green test suite cannot make an undocumented retail API stable.

## Why the browser is part of the design

Intermarché puts DataDome in front of its shopping site. A separate HTTP client with copied cookies is both fragile and a poor security boundary. This server uses the browser session that the user can already see:

1. It attaches to Chromium over the Chrome DevTools Protocol (CDP).
2. It keeps one Intermarché tab on `https://www.intermarche.com`.
3. It runs `window.fetch` in that page, so the browser applies its own cookies and challenge state.
4. It serializes requests and adds a small delay between them.
5. If DataDome shows a challenge, the server stops retrying and tells the user to handle it in the browser.

This is not a CAPTCHA solver or a DataDome bypass. Login, store selection, challenge handling, and checkout remain visible browser actions.

The adapter does not export the browser cookie jar. Its page helper extracts only the values derived from `itm_device_id` and `itm_usid`, which Intermarché's frontend sends as request headers. Those values stay in process memory and never appear in MCP results, logs, or project files. See [security boundaries](#security-boundaries) for the limits of that guarantee.

## What came from the Leclerc reference

The browser/CDP and throttling approach was adapted from [`skunkobi/mcp-leclerc-drive`](https://github.com/skunkobi/mcp-leclerc-drive). The Intermarché implementation is not a renamed Leclerc client:

| Area | Leclerc reference | This project |
| --- | --- | --- |
| Store | Locator tools plus a persisted store/host | Store and Drive mode come from the visible Intermarché tab |
| Catalogue | Product records parsed from store HTML | JSON product endpoint under `www.intermarche.com` |
| Basket | Form-encoded mutations and HTML cart extraction | Event-based JSON synchronization with the previous basket snapshot |
| Substitutions | No separate contract | Explicit tool; additions default to refusal |
| Browser target | General page target reused for the store host | One Intermarché tab, or one blank tab; unrelated tabs are left alone |

The full design review is in [`docs/design-review.md`](docs/design-review.md). Upstream attribution and license text are in [`NOTICE`](NOTICE).

## Tools

| Tool | Reads or writes | Contract |
| --- | --- | --- |
| `browser_status` | Read | Reports CDP state, active store reference, delivery mode, whether a basket id was found, and visible DataDome action required. |
| `search_product` | Read | Searches the active store. Returns Intermarché `itemId` values for basket tools. |
| `get_cart` | Read | Returns the complete normalized basket and total. |
| `add_to_cart` | Write | Increases the current quantity by `quantity`. Substitutions default to `false`. |
| `update_quantity` | Write | Sets an absolute quantity. `0` removes the line. |
| `remove_from_cart` | Write | Removes one product line. |
| `set_substitution` | Write | Sets substitution consent for a product already in the basket. |

`product_id` means the `id` returned by `search_product` or `get_cart`. It is normally Intermarché's `itemId`, not the EAN printed on the package.

Cart mutations happen as soon as the MCP client calls the tool. There is no second confirmation layer inside this server; the MCP host is responsible for its own approval UI.

## Requirements

- Node.js 22 or newer. The server uses Node's built-in `WebSocket`.
- A visible Chromium-family browser with CDP enabled.
- A graphical desktop session. Automatic launch is not suitable for a display-less server.
- An Intermarché store and the Drive withdrawal mode selected in the dedicated browser profile.

Automatic browser detection currently expects:

- macOS: Google Chrome in `/Applications`;
- Windows: Google Chrome in `Program Files`;
- Linux: a `chromium` executable on `PATH`.

Set `INTERMARCHE_CHROME_PATH` when your browser lives elsewhere, such as `google-chrome` on Linux.

## Install from source

```bash
git clone https://github.com/nicolasestrem/mcp-intermarche-drive.git
cd mcp-intermarche-drive
npm ci
npm run build
npm test
npm run smoke
```

The repository is private, so the clone command requires GitHub access to it.

The executable entry point after the build is:

```text
/absolute/path/mcp-intermarche-drive/dist/src/index.js
```

## Connect an MCP client

Use the built file as a local stdio server. The common JSON form is:

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

Replace the path with the real absolute path. Do not use `npx mcp-intermarche-drive`; there is no published package.

The server is lazy about browser startup. Starting the MCP process does not open Chromium immediately. The first tool call that needs the browser, normally `browser_status`, connects to CDP and launches the dedicated profile if necessary.

## First use

1. Start or reload the MCP client after adding the configuration.
2. Call `browser_status`. A dedicated Chromium profile should open on CDP port `9222`.
3. In its single tab, open Intermarché if needed.
4. Select the intended store and the **Drive** withdrawal mode.
5. Log in if you want to use the account basket. Anonymous baskets also work when the site permits them.
6. Resolve any DataDome challenge in the visible tab.
7. Call `browser_status` again, then try a product search.

Keep one Intermarché tab in this profile. Multiple tabs can hold different store or basket state, and the server has no sensible way to guess which one you meant.

## Attach to a browser you launch yourself

Set automatic launch off in the MCP environment:

```json
{
  "env": {
    "INTERMARCHE_AUTO_LAUNCH": "false",
    "INTERMARCHE_CHROME_PORT": "9222"
  }
}
```

Then start Chromium with a dedicated profile and a loopback-only debugging endpoint:

```bash
chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.mcp-intermarche-drive/chrome" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

Do not point this server at your everyday browser profile. CDP grants control over the attached tab, and the profile directory contains a persistent browser session.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `INTERMARCHE_CHROME_PORT` | `9222` | Loopback CDP port. |
| `INTERMARCHE_CHROME_PATH` | platform default | Chromium or Chrome executable. |
| `INTERMARCHE_CHROME_PROFILE_DIR` | `~/.mcp-intermarche-drive/chrome` | Dedicated persistent browser profile. |
| `INTERMARCHE_AUTO_LAUNCH` | `true` | Launch the browser when no CDP endpoint is listening. |
| `INTERMARCHE_HEADLESS` | `false` | Unsupported for normal use; it is more likely to trigger anti-bot checks and removes manual challenge handling. |
| `INTERMARCHE_PDV_REF` | browser-derived | Diagnostic fallback for store discovery. It must match the store selected in the tab. It does not switch stores. |
| `INTERMARCHE_CATALOG_ID` | `641` | Compatibility metadata fallback reported in browser context. It does not choose the store catalogue. |
| `INTERMARCHE_MIN_INTERVAL_MS` | `1100` | Minimum delay between queued web requests. |
| `INTERMARCHE_JITTER_MS` | `500` | Random delay added to the minimum. |
| `INTERMARCHE_MAX_RETRIES` | `2` | Bounded retries for HTTP 403 and 429. |
| `INTERMARCHE_BACKOFF_BASE_MS` | `1800` | Base for exponential retry backoff. |
| `INTERMARCHE_CDP_TIMEOUT_MS` | `30000` | Timeout for CDP commands and browser fetches. |

Avoid setting `INTERMARCHE_PDV_REF` unless browser-state discovery is broken. An override that points at another store can mix that store's API path with the basket state held by the visible tab.

## Security boundaries

- CDP is account-level browser access. Keep it on `127.0.0.1`; never expose port `9222` to a LAN, container bridge, tunnel, or public interface.
- Use a dedicated profile only for Intermarché. Any local process that can access the CDP port or profile directory should be treated as trusted.
- Browser cookies still accompany same-origin requests because the fetch runs in the page. The server does not return the cookie jar through MCP or persist cookie values itself.
- The browser-state snapshot is limited to store and basket keys. Do not replace it with a dump of local storage when debugging.
- Cart tools modify the real current basket. There is no checkout tool, but basket changes are still external side effects.
- Use the project only with your own account and in accordance with the site's terms.

## Troubleshooting

### `browser_status` says CDP is unavailable

- Check that the configured browser executable exists.
- Check that another process is not using the port: change `INTERMARCHE_CHROME_PORT` on both the browser and MCP server if needed.
- On Linux, set `INTERMARCHE_CHROME_PATH=google-chrome` if `chromium` is not installed.
- On a remote or headless machine, launch the visible browser in the desktop session and use `INTERMARCHE_AUTO_LAUNCH=false`.

### No active store is found

Select the store and Drive mode in the attached tab, then call `browser_status` again. Store selection belongs to the website. `INTERMARCHE_PDV_REF` is a last-resort fallback, not a replacement for the visible selection.

### DataDome or HTTP 403/429

Stop calling tools. Bring the existing Intermarché tab to the expected page, complete any visible challenge, and wait before retrying. Do not open more tabs or increase the retry count to hammer through it.

If the browser session or login changed, restart the MCP process so cached request identifiers are rebuilt from the current page.

### The wrong basket or store appears

Close extra Intermarché tabs in the dedicated profile. Remove a stale `INTERMARCHE_PDV_REF` override. Confirm the store and withdrawal mode in the website before making another cart change.

### Chromium reports that the profile is already in use

Reuse the already-running CDP instance on the configured port, or close that dedicated Chromium process before starting another one. Do not reuse the same profile directory from two browser processes.

## Development and verification

```bash
npm run typecheck
npm test
npm run smoke
npm audit --audit-level=low
npm pack --dry-run
```

What these checks cover:

- browser-state extraction from a narrow set of keys;
- normalization of current product and basket response shapes;
- absolute quantity and explicit substitution events;
- serialization of concurrent cart mutations;
- a real JSON-RPC `initialize` and `tools/list` exchange over stdio;
- MCP read-only, idempotent, and destructive annotations.

The optional live smoke test connects to the configured browser and performs only `browser_status`, product search, and basket retrieval:

```bash
npm run build
INTERMARCHE_AUTO_LAUNCH=false npm run smoke:live
```

It does not add or remove products. Run it manually, never as unattended public CI.

Adapter details and the revalidation checklist live in:

- [`docs/api-notes.md`](docs/api-notes.md)
- [`docs/design-review.md`](docs/design-review.md)

## Known limitations

- Intermarché can change these private endpoints or storage shapes without notice.
- Store selection is manual; there are no `find_stores` or `set_store` tools.
- One server instance operates one tab, one browser profile, and one active store.
- The login-status field is best-effort. The website is the authority on whether the session is authenticated.
- Headless operation is not a supported path.
- There is no checkout, order placement, payment, slot booking, or account-management tool.
- Only stdio transport is implemented.

## License and attribution

MIT. See [`LICENSE`](LICENSE) for this project and [`NOTICE`](NOTICE) for the upstream `mcp-leclerc-drive` attribution and MIT license text.

Intermarché is a trademark of its respective owner. This project is unofficial and is not affiliated with or endorsed by Intermarché.
