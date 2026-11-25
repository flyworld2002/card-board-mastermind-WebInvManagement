-- eBay shipping-band pricing for single cards (applied 2026-11-24).
--
-- Why: on eBay a single card priced up to $20 ships on the $0.78 label; over $20 it costs $5.99.
-- A card priced $20.99-$25.19 nets less than the same card at $19.99, so computed prices are
-- moved out of that dead zone.
--
-- Rule (eBay, single cards), applied to the COMPUTED price (tier/market price, after the normal
-- .99 rounding), before any floor:
--   price  < 16.99            -> unchanged (normal tier pricing)
--   16.99 <= price <= 21.99   -> 19.99
--   21.99 < price <= 25.99    -> 25.99
--   price  > 25.99            -> unchanged (normal tier pricing continues upward)
-- A manual_price pin (exact price) and a floor_price (minimum) still win over the band.
--
-- Settings live in platform_price_rules, one row per (platform, product_type), so another
-- platform or product type gets its own rule, or none. A platform with no row is unchanged.
-- To turn the eBay rule off: UPDATE platform_price_rules SET enabled = false WHERE platform = 'ebay';
--
-- resolve_listing_prices() now calls apply_shipping_band(price, p_platform) on the computed
-- price before taking the greatest of it, the template base_price and the floor. (The full
-- function body lives in the database; this file records the change.)
--
-- Verified when applied: all 11,333 eBay roster rows matched the rule exactly; pinned prices
-- unchanged; 82 computed prices changed (43 to 19.99, 39 to 25.99).

CREATE TABLE IF NOT EXISTS platform_price_rules (
    id serial PRIMARY KEY,
    platform text NOT NULL,
    product_type text NOT NULL DEFAULT 'single_card',
    enabled boolean NOT NULL DEFAULT true,
    normal_up_to numeric NOT NULL,
    band1_up_to numeric NOT NULL,
    band1_price numeric NOT NULL,
    band2_up_to numeric NOT NULL,
    band2_price numeric NOT NULL,
    note text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, product_type)
);

INSERT INTO platform_price_rules (platform, product_type, enabled, normal_up_to, band1_up_to, band1_price, band2_up_to, band2_price, note)
VALUES ('ebay', 'single_card', true, 16.98, 21.99, 19.99, 25.99, 25.99,
        'eBay shipping bands for single cards: <= $20 ships on the $0.78 label, over $20 costs $5.99. Pins and floors still win.')
ON CONFLICT (platform, product_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.apply_shipping_band(p numeric, p_platform text, p_product_type text DEFAULT 'single_card')
RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT COALESCE((
    SELECT CASE WHEN p IS NULL THEN NULL
                WHEN p <= r.normal_up_to THEN p
                WHEN p <= r.band1_up_to THEN r.band1_price
                WHEN p <= r.band2_up_to THEN r.band2_price
                ELSE p END
    FROM platform_price_rules r
    WHERE r.platform = p_platform AND r.product_type = p_product_type AND r.enabled
    LIMIT 1), p)
$f$;
