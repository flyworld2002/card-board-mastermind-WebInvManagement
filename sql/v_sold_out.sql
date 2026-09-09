-- v_sold_out: the mirror image of v_restock_candidates -- roster rows
-- showing quantity_listed = 0 on their live listing AND with zero
-- inventory available anywhere (available_qty = 0), i.e. genuinely sold
-- through with nothing left to push. A purchasing/reorder signal ("go buy
-- more of this card"), not a push signal.
--
-- Enriched with each variant's most recent sale (any platform/listing,
-- since inventory is shared across listings) straight from the sales
-- table -- deliberately no new event/episode-tracking table or trigger:
-- the price + date history this needs already lives in `sales`, written
-- by record_sale() on every real sale.
--
-- set_id/set_name/series/rarity are here so the Sold Out tab (sold-out.js)
-- can filter by them -- deliberately not added to v_restock_candidates,
-- not asked for there. Set filter matches by set_id (not set_name
-- string), same convention as catalog.js's loadSetsFilter(). series is
-- card_sets.series (labeled "Era" in the UI) -- a small-cardinality
-- bucket (9 distinct values) added to cut down the flat table's row
-- count, which was the actual complaint driving this filter.
--
-- image_url is COALESCE(image_url_own, image_url), same pattern as
-- resolve_listing_prices() -- lets the Sold Out tab show a thumbnail
-- with zero extra query, card_master is already joined here.
--
-- Not applied automatically by anything in this repo -- run manually
-- against Supabase (see CLAUDE.md's sql/ convention). Source of truth is
-- the live view; keep this file in sync by hand after any change.
--
-- NOTE: CREATE OR REPLACE VIEW cannot reorder/insert columns mid-list in
-- Postgres (errors "cannot change name of view column") -- use
-- DROP VIEW + CREATE VIEW instead when changing the column set, same
-- restriction already hit on render_variation_name() this session.

DROP VIEW IF EXISTS v_sold_out;

CREATE VIEW v_sold_out AS
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
    cs.id AS set_id,
    cs.name AS set_name,
    cs.series,
    cm.rarity,
    COALESCE(cm.image_url_own, cm.image_url) AS image_url,
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
  JOIN card_sets cs ON cs.id = cm.set_id
  LEFT JOIN inv ON inv.variant_id = cv.id
  WHERE pl.status IN ('active', 'out_of_stock')
    AND COALESCE(pl.quantity_listed, 0) = 0
)
SELECT
  c.assignment_id, c.platform_listing_id, c.listing_id, c.platform, c.account,
  c.template_id, c.template_name, c.variant_id, c.card_name, c.card_number,
  c.set_id, c.set_name, c.series, c.rarity, c.image_url,
  c.total_inventory_qty, c.available_qty,
  ls.sale_price AS last_sold_price,
  ls.sold_at AS last_sold_at,
  ls.quantity_sold AS last_sold_qty,
  ls.platform_order_id AS last_sold_order_id
FROM candidates c
LEFT JOIN LATERAL (
  SELECT s.sale_price, s.sold_at, s.quantity_sold, s.platform_order_id
  FROM sales s
  WHERE s.variant_id = c.variant_id
  ORDER BY s.sold_at DESC
  LIMIT 1
) ls ON true
WHERE c.available_qty = 0;

GRANT SELECT ON v_sold_out TO anon, authenticated;
