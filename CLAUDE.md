# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Web-based inventory management UI for **Card-Board-MasterMind**, a Pokémon TCG
inventory system backed by Supabase (PostgreSQL). This repo is the browser
front end only; the Python CLI it complements lives in a separate repo
(`Card-Board-MasterMind`) and is not checked out here — some SQL comments and
code comments reference its logic (e.g. `staging_workflow.py`) as the source
of truth being ported.

## Running it

No build step, no package manager, no dependencies to install.

```
python3 -m http.server   # then open the printed localhost URL
```

or just open `index.html` directly in a browser. There is no lint, test, or
build command — none exist in this repo.

Sign-in is Google OAuth via Supabase Auth (Authentication -> Providers ->
Google must be enabled on the Supabase project).

## Architecture

Static site, zero build tooling. Plain HTML + native ES modules loaded
directly by the browser via `<script type="module">` and `import`/`export` —
no bundler, no transpilation, no npm.

- **`index.html`** — app shell: inline CSS (dark theme via CSS custom
  properties), the sidebar nav, and a hash-based router (`loadPage()`) that
  dynamically `import()`s one page module per route. Each import is
  cache-busted with `?v=${Date.now()}` so edits show up on next navigation
  without a hard refresh. Also owns the "Issues" sidebar badge (unresolved
  `ebay_order_issues` count), kept live via a Supabase Realtime subscription
  — this lives at the shell level rather than in a page module so it stays
  accurate regardless of which page is open.
- **`shared.js`** — the Supabase client (anon/publishable key only — see
  Security below), auth helpers (`requireAuth`, `signInWithGoogle`,
  `signOut`), and small cross-page utilities: `debounce`, `formatPrice`, and
  the variant **axis options** system (`loadAxisOptions`, `AXIS_OPTIONS`,
  `AXIS_DISPLAY`, `axisDisplay`) — loaded once per page mount from the 7
  variant lookup tables and exported as live bindings so Staging Review,
  Inventory, Catalog, and Purchases all read from one place instead of
  drifting copies.
- **Page modules** (`catalog.js`, `configuration.js`, `inventory.js`,
  `issues.js`, `picking.js`, `purchases.js`, `sales.js`,
  `staging-review.js`) — one per sidebar route, each exporting a single
  `renderX(container)` entry point that the router calls. Every module owns
  its own `state` object (page/filters/sort/expanded-row/etc.), does its own
  Supabase queries, and renders by building HTML strings and wiring up
  listeners after `container.innerHTML = ...` — there is no component
  framework or virtual DOM. `configuration.js` is a multi-tab sub-router
  (Sets, Card games, Pricing rules, Listing templates) reached via
  `#configuration`, `#sets`, `#card-games`, `#pricing-rules`,
  `#listing-templates`, all handled by one `renderConfiguration(container,
  subKey)`.
- **`sql/`** — hand-maintained copies of Postgres objects the app depends on
  (views, RPC functions), meant to be run manually against Supabase. Not
  applied automatically by anything in this repo.

### Module-state-survives-navigation pattern

Because `index.html` re-imports each page module fresh (with a cache-busting
query string) on every navigation, top-level `let`/`const` module state is
reset each time the page is revisited. Where state needs to survive
away-and-back navigation (e.g. Picking's in-progress pile checkboxes,
Inventory's realtime channel handle), it's stashed on `window.__cbm*`
instead of module scope. See `picking.js` (`window.__cbmPickingSession`,
`window.__cbmPickingPreview`) and `inventory.js`
(`window.__cbmInventoryChannel`, `window.__cbmInventoryHashHandler`) for the
pattern — follow it for any new page-level state that must persist.

### Data layer conventions

- Reads generally go through Supabase views (`v_staging`, `v_inventory`,
  `v_sales`, `v_market_prices`, `inventory_available`) rather than raw
  tables, so display-shaping logic lives in Postgres, not JS.
- Writes that need to be atomic/multi-table go through Postgres RPC
  functions called via `supabase.rpc(...)`, not client-side multi-step
  writes:
  - `push_staging_row_to_inventory(p_staging_id)` — resolves/creates a card
    variant, purchase, inventory row, and market price entry from a staging
    row, then marks it `processed`. See `sql/push_staging_row_to_inventory.sql`.
  - `record_sale(...)` — FIFO depletion of inventory lots on sale.
  - `delete_sale_group(p_sale_group_id)`, `delete_staging_row(p_id)`,
    `delete_platform_listing(p_id)`, `get_staging_counts(...)`.
- Row Level Security policies on all tables gate access by authenticated
  user; there is no separate authorization layer in this app.
- The 7 variant "axis" lookup tables (`foil_types`, `foil_patterns`,
  `textures`, `materials`, `sizes`, `stamp_types`, `source_types`) all share
  an identical `(code, display_name, sort_order)` shape and are the source
  of truth for `card_variants` dropdowns everywhere — `configuration.js`
  has one generic CRUD component (`ATTR_TABLES`) that drives all 7 instead
  of duplicating per-table UI.

### Picking page's external dependency

`picking.js` is the one page that talks to something other than Supabase
directly: its Refresh button POSTs to a small FastAPI service
(`picking_api.py`) running on an always-on Windows desktop on the LAN, which
re-runs the same pull job the Python CLI uses (`--ebay-pullpicking`) and
rewrites the `picking_queue` table; the page then re-reads that table from
Supabase. There is no auto-pull on tab open — Refresh is the only trigger.
`PICKING_API_URL` and `PICKING_API_TOKEN` near the top of `picking.js` are
hardcoded to that LAN endpoint and must be updated there if the desktop's
IP/token changes.

## Security notes

- Only the Supabase **publishable/anon** key (`shared.js`) is used
  client-side. The `service_role`/secret key must never appear in this repo.
- RLS policies, not client code, are the actual access control boundary.
