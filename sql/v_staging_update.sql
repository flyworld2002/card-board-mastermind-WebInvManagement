-- ============================================================
-- v_staging (updated)
--
-- Adds columns required by the Staging Review web app that were
-- missing from the original view: source, card_id, match_options,
-- override_price, calculated_price, source_type, stamp_type, notes.
--
-- Safe to re-run: CREATE OR REPLACE VIEW preserves the view's
-- dependents as long as existing column names/positions are kept
-- and new columns are only appended.
-- ============================================================

-- Note: column order changes from the original view (staging_id is now
-- first), so CREATE OR REPLACE VIEW is not usable here -- Postgres
-- rejects reordering/renaming existing columns that way. Drop and
-- recreate instead.

DROP VIEW IF EXISTS v_staging;

CREATE VIEW v_staging AS
SELECT
    s.id AS staging_id,
    s.source,
    s.order_number,
    s.order_date::date AS order_date,
    s.card_name,
    s.set_name,
    s.condition,
    s.foil_type,
    s.foil_pattern,
    s.source_type,
    s.stamp_type,
    s.quantity,
    s.price AS cost_per_card,
    s.override_price,
    s.calculated_price,
    s.market_price,
    s.market_price_date,
    s.api_rarity,
    s.match_status,
    s.match_options,
    s.status,
    s.notes,
    s.card_id,
    cm.name AS matched_card_name,
    cs.name AS matched_set_name,
    cm.card_number AS matched_number,
    s.import_batch
FROM staging s
LEFT JOIN card_master cm ON s.card_id = cm.id
LEFT JOIN card_sets cs ON cm.set_id = cs.id
ORDER BY s.order_date DESC, s.card_name;
