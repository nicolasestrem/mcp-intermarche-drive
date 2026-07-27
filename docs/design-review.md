# Design review: from Leclerc Drive to Intermarché

This project started from a review of [`skunkobi/mcp-leclerc-drive`](https://github.com/skunkobi/mcp-leclerc-drive), currently at v0.3.0 in commit `ac341d7`. It keeps the parts that fit Intermarché and drops the parts that do not.

This is a design record, not a claim that the two websites expose compatible APIs. They do not.

## What the reference gets right

The Leclerc server settled on four sound decisions after its earlier cookie-replay implementation ran into DataDome:

1. Run requests inside a normal, visible Chrome session over CDP.
2. Keep that browser profile persistent so the user controls login and challenge handling.
3. Serialize requests and add delay instead of firing cart operations in parallel.
4. Expose a small stdio MCP surface rather than automating the checkout UI.

Intermarché uses the same general browser boundary. `src/browser.ts` was adapted from that CDP approach and adds request aborts, CDP timeouts, pending-call rejection, loopback binding, and stricter target selection.

## What cannot be copied

| Concern | Leclerc reference | Intermarché adaptation |
| --- | --- | --- |
| Store selection | Finds stores through a locator API and persists a selected store/host. | Reads the store and Drive mode already selected in the Intermarché tab. `INTERMARCHE_PDV_REF` is only a fallback, not a store switch. |
| Backend topology | Each store can use a different `fdN-courses.leclercdrive.fr` host. | Shopping calls use `www.intermarche.com`; the store reference is part of the API path. |
| Catalogue | Parses product records embedded in server-rendered HTML. | Calls a JSON product endpoint and normalizes the current response shape. |
| Basket | Uses a form-encoded mutation endpoint and scrapes cart state from HTML. | Sends events plus the last synchronized basket snapshot to a JSON cart endpoint. |
| Substitutions | No separate tool in the reference. | Substitution consent is explicit and defaults to false for additions. |
| Browser target | Reuses the first page target and may navigate it. | Reuses an Intermarché tab, or one blank tab; unrelated pages are not commandeered. |
| Failure handling | Retries 403/429 and detects invalid Leclerc HTML. | Retries 403/429, times out CDP and browser fetches, and reports visible DataDome challenges as manual actions. |

A compatibility layer between both sites would hide these differences and make failures harder to diagnose. The Intermarché code therefore has its own client, context extraction, normalizers, and tool contract.

## Intermarché-specific choices

### The browser is the source of store truth

The visible tab owns the selected store, withdrawal mode, anonymous basket, login state, and DataDome session. The MCP re-reads store context before operations. It does not maintain a second store database.

This is why there are no `find_stores` or `set_store` tools. Selecting a different store remains a visible website action. A `pdvRef` override must match the store shown in the browser; using it to point at another store risks mixing browser state with the wrong API path.

### Basket writes use absolute state events

Intermarché's cart API expects the latest synchronized cart snapshot and a list of events. Quantity events carry the target quantity, not a delta. The client:

- reads the current cart before a mutation;
- serializes the complete read/modify/write cycle;
- sends an absolute quantity event;
- updates its synchronization baseline from the response;
- sends substitution consent separately when required.

`add_to_cart` is still not idempotent at the MCP level because it means "increase by N". `update_quantity`, `remove_from_cart`, and `set_substitution` express absolute target state.

### Storage access is deliberately narrow

`src/intermarche/context.ts` snapshots only the keys needed to recover store and basket state. It does not dump local storage, session storage, or the browser cookie jar.

The request helper evaluates page JavaScript that extracts two first-party cookie values used by Intermarché's own request headers: `itm_device_id` and `itm_usid`. Only those derived values cross the CDP evaluation boundary, remain in process memory, and are never returned through MCP.

### One tab is an invariant, not a suggestion

Multiple Intermarché tabs can carry stale or conflicting store and basket state. The browser adapter therefore chooses one existing Intermarché page, falls back to one blank page, and refuses to take over an unrelated tab. Users should keep one Intermarché tab in the dedicated profile.

## Deliberate non-goals

- No CAPTCHA solver or DataDome bypass.
- No checkout, payment, order placement, delivery-slot booking, or account editing.
- No cookie export or headless deployment recipe.
- No automatic store switching.
- No promise that private Intermarché endpoints will remain stable.

## Evidence and remaining risk

As of 2026-07-27:

- TypeScript compilation, unit tests, MCP initialization, `tools/list`, and tool annotations pass locally.
- Product search and basket retrieval have been replayed through a real Intermarché browser session.
- Cart event construction and serialization are covered by tests.
- The automated live smoke test is intentionally read-only; it does not prove that every cart mutation still works on the live site.

Before describing a release as live-write validated, run controlled add, quantity update, substitution, and removal checks against a disposable basket, then confirm the final basket in the website UI. Do not turn that into an unattended CI job.

## Maintenance checklist

When Intermarché changes its frontend:

1. Reproduce the failure with `browser_status`, then the smallest read-only tool.
2. Compare the browser's own request in DevTools with `docs/api-notes.md`.
3. Update assumptions under `src/intermarche/`; do not spread raw response fields into MCP handlers.
4. Add or update a sanitized fixture. Never commit cookies, headers containing identifiers, account data, or a raw browser storage dump.
5. Run `npm run typecheck`, `npm test`, and `npm run smoke`.
6. Run `npm run smoke:live` manually with the dedicated browser profile.
7. If writes changed, validate one controlled basket lifecycle in the visible UI before release.

## Attribution

The CDP and throttling design derives from `mcp-leclerc-drive`, distributed under the MIT License. The Intermarché endpoint adapter and MCP tools are separate implementations. See [`NOTICE`](../NOTICE) for the full attribution and upstream license text.
