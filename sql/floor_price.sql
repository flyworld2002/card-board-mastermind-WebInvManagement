-- floor_price: a per-card minimum price on a listing's roster (applied 2026-11-24).
--
-- listing_card_assignments.floor_price
--   NULL  = no floor.
--   value = the card's resolved price is never below this, but the market/tier
--           price can still go higher.
--   A manual_price pin (exact price) still wins over a floor.
--
-- resolve_listing_prices() was changed to:
--   * return one more column, floor_price (last column),
--   * resolved_price = GREATEST(tier/market price, template base_price, floor_price)
--     when the row has no manual_price pin,
--   * report price_source = 'floor' when the floor is what set the price.
-- Applied by editing the live function's definition in place (the full function
-- body lives in the database; this file records the change). Verified at the time:
-- the resolved price and source of all 11,333 roster rows were identical before and
-- after with no floors set.

ALTER TABLE listing_card_assignments ADD COLUMN IF NOT EXISTS floor_price numeric;
COMMENT ON COLUMN listing_card_assignments.floor_price IS
  'Minimum price for this card when it is NOT pinned: resolved price = greatest(tier/market price, floor_price). A manual_price pin, when set, still wins (exact price).';
