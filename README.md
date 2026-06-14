# Card-Board-MasterMind Web

Web-based inventory management UI for [Card-Board-MasterMind](https://github.com/flyworld2002/Card-Board-MasterMind),
a Pokémon TCG inventory system backed by Supabase (PostgreSQL).

## Architecture

Static site, no build step. Plain HTML + ES modules, loaded directly by the browser.

```
card-board-mastermind-web/
├── index.html          # App shell: nav, auth gate, page router
├── shared.js           # Supabase client, auth helpers, small utilities
├── staging-review.js   # Staging Review page (filter/edit/resolve/push)
├── dashboard.js         # (planned)
├── inventory.js         # (planned)
├── card-catalog.js      # (planned)
├── sets.js               # (planned)
└── pricing.js            # (planned)
```

Each page is its own ES module, imported on demand by `index.html`'s router.
No bundler — `<script type="module">` and native `import`/`export` only.

## Setup

1. Open `index.html` in a browser, or serve the folder with any static
   file server (e.g. `python3 -m http.server`).
2. Sign in with Google (requires Google OAuth provider enabled in
   Supabase: Authentication -> Providers -> Google).

## Database

Connects to the same Supabase project as the Python CLI
(`Card-Board-MasterMind`), using the publishable (anon) API key.
Row Level Security policies control what authenticated users can
read/write.

### Key database objects used by this app

- `staging` / `v_staging` — staged import rows from eBay and TCGPlayer
- `push_staging_row_to_inventory(p_staging_id uuid)` — Postgres RPC
  that atomically resolves/creates a card variant, purchase, inventory
  row, and market price entry from a staging row, then marks it
  `processed`. See `/sql/push_staging_row_to_inventory.sql`.
- `card_master`, `card_variants`, `card_sets`, `card_attributes`,
  `card_pricing_overrides`, `inventory`, `purchases`, `market_prices`
- Read views: `v_card_variants`, `v_inventory`, `inventory_available`,
  `v_market_prices`

## Pages

- **Staging Review** — review imported rows, edit details, resolve
  ambiguous/unmatched cards (with local catalog dedup search before
  creating new `card_master` rows), and push approved rows to
  inventory via the RPC above.
- Dashboard, Inventory, Card Catalog, Sets, Pricing — planned.

## Security notes

- Only the Supabase **publishable/anon** key is used client-side.
  The `service_role` / secret key must never appear in this repo.
- RLS policies on all tables gate access by authenticated user.
