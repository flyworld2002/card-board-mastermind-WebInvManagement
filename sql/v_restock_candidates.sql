-- v_restock_candidates: active/out-of-stock roster rows currently showing
-- quantity_listed = 0 on their live eBay listing while inventory is
-- actually available to push. Feeds the "Listing pricing" sidebar badge
-- and the per-row restock pill in listing-pricing.js's templates table.
--
-- available_qty mirrors resolve_listing_prices()'s own formula (Card-Board-
-- MasterMind/docs/plans/listing_pricing_migration_042_resolve_prices_card_photo.sql):
-- total_inventory_qty minus quantity_listed already committed to this same
-- variant on OTHER active listings. Status scope (active, out_of_stock)
-- matches the convention already used elsewhere in this codebase for
-- "this platform_listings row is live" (e.g. the platform_listings
-- selects in Card-Board-MasterMind's rename_variation-driven migration
-- scripts) rather than filtering on sync_enabled, which turns out to mark
-- a large, unrelated population of rows -- deliberately-paused rows
-- (sold_out_retained roster status) are status='delisted' instead, and are
-- excluded by the status list on their own.
--
-- Not applied automatically by anything in this repo -- run manually
-- against Supabase (see CLAUDE.md's sql/ convention). Source of truth is
-- the live view; keep this file in sync by hand after any change.

CREATE OR REPLACE VIEW v_restock_candidates AS
WITH inv AS (
  SELECT variant_id, COALESCE(SUM(quantity - quantity_sold), 0)::integer AS total_inventory_qty
  FROM inventory
  WHERE is_graded = FALSE
  GROUP BY variant_id
),
listed AS (
  SELECT variant_id, platform, listing_id, COALESCE(SUM(quantity_listed), 0)::integer AS listed_qty
  FROM platform_listings
  WHERE status = 'active'
  GROUP BY variant_id, platform, listing_id
),
candidates AS (
  SELECT
    lca.id AS assignment_id,
    pl.id AS platform_listing_id,
    pl.listing_id,
    pl.platform,
    pl.account,
    lt.id AS template_id,
    lt.name AS template_name,
    cv.id AS variant_id,
    cm.name AS card_name,
    cm.card_number,
    COALESCE(inv.total_inventory_qty, 0) AS total_inventory_qty,
    GREATEST(
      COALESCE(inv.total_inventory_qty, 0)
      - COALESCE((
          SELECT SUM(l2.listed_qty) FROM listed l2
          WHERE l2.variant_id = cv.id
            AND l2.platform = pl.platform
            AND l2.listing_id <> pl.listing_id
        ), 0),
      0
    ) AS available_qty
  FROM listing_card_assignments lca
  JOIN platform_listings pl ON pl.id = lca.platform_listing_id
  JOIN listing_templates lt ON lt.id = lca.template_id
  JOIN card_variants cv ON cv.id = lca.variant_id
  JOIN card_master cm ON cm.id = cv.card_id
  LEFT JOIN inv ON inv.variant_id = cv.id
  WHERE pl.status IN ('active', 'out_of_stock')
    AND COALESCE(pl.quantity_listed, 0) = 0
)
SELECT * FROM candidates WHERE available_qty > 0;

GRANT SELECT ON v_restock_candidates TO anon, authenticated;
