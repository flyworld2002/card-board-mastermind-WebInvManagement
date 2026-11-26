-- TCGplayer catalogue mirror (applied 2026-11-26).
--
-- Filled by importer/tcg_catalog.py (main.py --tcg-catalog-sync) from the public TCGplayer data
-- mirror tcgcsv.com: every Pokemon set ("group") and every product in it (cards and sealed), with
-- TCGplayer's own product id, printed number, rarity and which finishes (Normal / Holofoil /
-- Reverse Holofoil) it is sold in. The sync also links each card product to our exact card variant
-- where set + number + name agree (tcg_products, source 'catalogue'), so an order line is matched
-- by its TCGplayer product id before any guessing.

CREATE TABLE IF NOT EXISTS tcg_catalog_groups (
    group_id      integer PRIMARY KEY,
    name          text NOT NULL,           -- TCGplayer's set label, e.g. "ME06: Delta Reign"
    abbreviation  text,
    published_on  date,
    modified_on   timestamptz,
    card_set_id   uuid,                    -- our card_sets row, when the sync could tie it
    synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tcg_catalog_products (
    product_id    bigint PRIMARY KEY,
    group_id      integer NOT NULL REFERENCES tcg_catalog_groups(group_id) ON DELETE CASCADE,
    name          text NOT NULL,
    number        text,                    -- printed number as TCGplayer lists it, e.g. "126/103"
    rarity        text,
    is_card       boolean NOT NULL DEFAULT false,
    printings     text[] NOT NULL DEFAULT '{}',   -- Normal | Holofoil | Reverse Holofoil | ...
    url           text,
    image_url     text,
    modified_on   timestamptz
);
CREATE INDEX IF NOT EXISTS tcg_catalog_products_group_idx ON tcg_catalog_products (group_id);
CREATE INDEX IF NOT EXISTS tcg_catalog_products_name_idx ON tcg_catalog_products (lower(name));

ALTER TABLE tcg_catalog_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_catalog_products ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tcg_catalog_groups', 'tcg_catalog_products'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass AND polname = 'authenticated only') THEN
            EXECUTE format('CREATE POLICY "authenticated only" ON public.%I FOR ALL USING (auth.role() = ''authenticated''::text)', t);
        END IF;
    END LOOP;
END $$;
