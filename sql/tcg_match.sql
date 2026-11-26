-- Fixing which of our cards a TCGplayer order line is (applied 2026-11-26).
--
-- tcg_link_line(line, variant): you say "this TCGplayer line is this exact card variant". Every
-- line with the same TCGplayer product + finish is updated, the link is remembered in tcg_products
-- (source 'manual') so future orders match by themselves, and any of those lines already sitting
-- in Staging Review (not yet pushed) get the card and finish fields too.
-- tcg_clear_link(line): undo a wrong link; the lines go back to unmatched and are re-tried by the
-- daily job. Lines linked by hand (match_source 'manual') are never changed by the automatic
-- re-matching.

CREATE OR REPLACE FUNCTION public.tcg_link_line(p_line_id uuid, p_variant_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE ln tcg_order_lines; v card_variants; n integer; st integer := 0;
BEGIN
    SELECT * INTO ln FROM tcg_order_lines WHERE id = p_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order line not found'; END IF;
    SELECT * INTO v FROM card_variants WHERE id = p_variant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Variant not found'; END IF;

    UPDATE tcg_order_lines SET card_id = v.card_id, variant_id = v.id, match_status = 'matched', match_source = 'manual'
    WHERE id = p_line_id OR (ln.product_id IS NOT NULL AND product_id = ln.product_id AND printing = ln.printing);
    GET DIAGNOSTICS n = ROW_COUNT;

    IF ln.product_id IS NOT NULL THEN
        INSERT INTO tcg_products (product_id, printing, variant_id, card_id, name, set_label, slug, source)
        VALUES (ln.product_id, ln.printing, v.id, v.card_id, ln.card_name, ln.set_label, ln.product_slug, 'manual')
        ON CONFLICT (product_id, printing) DO UPDATE
            SET variant_id = EXCLUDED.variant_id, card_id = EXCLUDED.card_id, source = 'manual', updated_at = now();
    END IF;

    UPDATE staging s SET card_id = v.card_id, match_status = 'matched',
           status = CASE WHEN s.status = 'pending' THEN 'approved' ELSE s.status END,
           foil_type = v.foil_type, foil_pattern = v.foil_pattern, texture = v.texture, material = v.material,
           size = v.size, stamp_type = v.stamp_type, source_type = v.source_type, updated_at = now()
    FROM tcg_staged_lines sl
    WHERE sl.staging_id = s.id AND s.status <> 'processed'
      AND sl.line_id IN (SELECT id FROM tcg_order_lines WHERE id = p_line_id
                         OR (ln.product_id IS NOT NULL AND product_id = ln.product_id AND printing = ln.printing));
    GET DIAGNOSTICS st = ROW_COUNT;
    RETURN jsonb_build_object('lines', n, 'staging_rows', st);
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_clear_link(p_line_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE ln tcg_order_lines; n integer;
BEGIN
    SELECT * INTO ln FROM tcg_order_lines WHERE id = p_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order line not found'; END IF;
    IF ln.product_id IS NOT NULL THEN
        DELETE FROM tcg_products WHERE product_id = ln.product_id AND printing = ln.printing;
    END IF;
    UPDATE tcg_order_lines SET card_id = NULL, variant_id = NULL, match_status = 'unmatched', match_source = NULL
    WHERE id = p_line_id OR (ln.product_id IS NOT NULL AND product_id = ln.product_id AND printing = ln.printing);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('lines', n);
END $f$;
