-- Linking from the TCGplayer catalogue tab (applied 2026-11-28). Builds on sql/tcg_catalog_lookup.sql.
--
--   tcg_link_product(product, printing, variant)  "this TCGplayer product + printing is this exact card version of ours".
--       Remembered in tcg_products (source 'manual', never overwritten by the automatic matching); every order line
--       with that product + printing is matched to it, and lines still in Staging Review get the card + finish too
--       (same effect as Fix card matches' tcg_link_line).
--   tcg_tie_set(group, set)  "this TCGplayer set is our set". Writes the tcgplayer_set_aliases row the matcher reads
--       (label = the TCGplayer set name without its "SV02:" style prefix, as utils/set_name_map.py cleans it) and asks
--       the desktop to re-run the catalogue matching (tcg_catalog_remap), which links that set's cards on the next sync.

-- the alias table had no row security and full anon access: lock it like every other table (the desktop jobs
-- connect directly and are not affected)
ALTER TABLE tcgplayer_set_aliases ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tcgplayer_set_aliases'::regclass AND polname = 'authenticated only') THEN
        CREATE POLICY "authenticated only" ON public.tcgplayer_set_aliases FOR ALL USING (auth.role() = 'authenticated'::text);
    END IF;
END $$;
REVOKE ALL ON tcgplayer_set_aliases FROM anon;

CREATE TABLE IF NOT EXISTS tcg_catalog_remap (
    id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    requested_at  timestamptz,
    started_at    timestamptz,
    done_at       timestamptz,
    note          text
);
ALTER TABLE tcg_catalog_remap ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tcg_catalog_remap'::regclass AND polname = 'authenticated only') THEN
        CREATE POLICY "authenticated only" ON public.tcg_catalog_remap FOR ALL USING (auth.role() = 'authenticated'::text);
    END IF;
END $$;
INSERT INTO tcg_catalog_remap (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.tcg_link_product(p_product_id bigint, p_printing text, p_variant_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE pr tcg_catalog_products; g tcg_catalog_groups; v card_variants; n integer; st integer := 0;
BEGIN
    SELECT * INTO pr FROM tcg_catalog_products WHERE product_id = p_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCGplayer product not found'; END IF;
    IF p_printing NOT IN ('Normal', 'Holofoil', 'Reverse Holofoil') THEN RAISE EXCEPTION 'Unknown printing %', p_printing; END IF;
    SELECT * INTO v FROM card_variants WHERE id = p_variant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Card version not found'; END IF;
    SELECT * INTO g FROM tcg_catalog_groups WHERE group_id = pr.group_id;

    INSERT INTO tcg_products (product_id, printing, variant_id, card_id, name, set_label, slug, source)
    VALUES (p_product_id, p_printing, v.id, v.card_id, pr.name, g.name, pr.url, 'manual')
    ON CONFLICT (product_id, printing) DO UPDATE
        SET variant_id = EXCLUDED.variant_id, card_id = EXCLUDED.card_id, source = 'manual', updated_at = now();

    UPDATE tcg_order_lines SET card_id = v.card_id, variant_id = v.id, match_status = 'matched', match_source = 'manual'
    WHERE product_id = p_product_id AND printing = p_printing;
    GET DIAGNOSTICS n = ROW_COUNT;

    UPDATE staging s SET card_id = v.card_id, match_status = 'matched',
           status = CASE WHEN s.status = 'pending' THEN 'approved' ELSE s.status END,
           foil_type = v.foil_type, foil_pattern = v.foil_pattern, texture = v.texture, material = v.material,
           size = v.size, stamp_type = v.stamp_type, source_type = v.source_type, updated_at = now()
    FROM tcg_staged_lines sl
    WHERE sl.staging_id = s.id AND s.status <> 'processed'
      AND sl.line_id IN (SELECT id FROM tcg_order_lines WHERE product_id = p_product_id AND printing = p_printing);
    GET DIAGNOSTICS st = ROW_COUNT;
    RETURN jsonb_build_object('lines', n, 'staging_rows', st);
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_tie_set(p_group_id integer, p_set_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE g tcg_catalog_groups; s card_sets; v_label text;
BEGIN
    SELECT * INTO g FROM tcg_catalog_groups WHERE group_id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCGplayer set not found'; END IF;
    SELECT * INTO s FROM card_sets WHERE id = p_set_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Our set not found'; END IF;
    v_label := btrim(regexp_replace(g.name, '^[A-Z]+[0-9]*(pt[0-9]+)?:\s*', ''));
    INSERT INTO tcgplayer_set_aliases (tcgplayer_label, set_id, api_set_id) VALUES (v_label, s.id, NULL)
    ON CONFLICT (tcgplayer_label) DO UPDATE SET set_id = EXCLUDED.set_id, api_set_id = NULL;
    UPDATE tcg_catalog_groups SET card_set_id = s.id WHERE group_id = p_group_id;
    UPDATE tcg_catalog_remap SET requested_at = now(), note = 'tied ' || g.name || ' -> ' || s.name WHERE id = 1;
    RETURN jsonb_build_object('label', v_label, 'set', s.name);
END $f$;

REVOKE EXECUTE ON FUNCTION public.tcg_link_product(bigint, text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.tcg_tie_set(integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tcg_link_product(bigint, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tcg_tie_set(integer, uuid) TO authenticated;
