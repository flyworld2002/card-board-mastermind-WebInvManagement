-- Resolves a free-text variant axis value (e.g. "Holiday Calendar" typed via
-- the staging page's "Custom..." option) to a lookup code, creating the
-- lookup row if it doesn't exist yet. Every axis is FK-constrained to its
-- lookup table, so without this the push fails with a card_variants_*_fkey
-- violation.
CREATE OR REPLACE FUNCTION public.ensure_axis_code(p_table text, p_raw text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code   text;
    v_exists boolean;
BEGIN
    IF p_raw IS NULL OR btrim(p_raw) = '' THEN
        RETURN NULL;
    END IF;

    IF p_table NOT IN ('foil_types', 'foil_patterns', 'textures', 'materials',
                       'sizes', 'stamp_types', 'source_types') THEN
        RAISE EXCEPTION 'ensure_axis_code: unknown axis table %', p_table;
    END IF;

    v_code := lower(btrim(p_raw));
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE code = $1)', p_table)
        INTO v_exists USING v_code;
    IF v_exists THEN
        RETURN v_code;
    END IF;

    v_code := btrim(regexp_replace(lower(btrim(p_raw)), '[^a-z0-9]+', '_', 'g'), '_');
    IF v_code = '' THEN
        RETURN NULL;
    END IF;

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE code = $1)', p_table)
        INTO v_exists USING v_code;
    IF NOT v_exists THEN
        EXECUTE format(
            'INSERT INTO public.%I (code, display_name, sort_order) '
            'VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.%I)) '
            'ON CONFLICT (code) DO NOTHING', p_table, p_table)
            USING v_code, initcap(replace(v_code, '_', ' '));
    END IF;
    RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.push_staging_row_to_inventory(p_staging_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_row            staging%ROWTYPE;
    v_purchase_id    uuid;
    v_variant_id     uuid;
    v_inventory_id   uuid;
    v_is_ebay        boolean;
    v_cost           numeric;
    v_asking         numeric;
    v_market_price   numeric;
    v_market_date    date;
BEGIN
    -- 1. Load and validate the staging row
    SELECT * INTO v_row FROM staging WHERE id = p_staging_id FOR UPDATE;

    IF v_row IS NULL THEN
        RAISE EXCEPTION 'Staging row % not found', p_staging_id;
    END IF;

    IF v_row.card_id IS NULL THEN
        RAISE EXCEPTION 'Staging row % has no card_id — resolve the match before pushing', p_staging_id;
    END IF;

    IF v_row.status = 'processed' THEN
        RAISE EXCEPTION 'Staging row % was already processed', p_staging_id;
    END IF;

    -- Normalize the seven variant axes the same way Python's
    -- get_or_create_variant() does (db/connection.py) — every axis is
    -- FK-constrained against a lowercase_snake_case lookup table, but
    -- callers (the web app's free-text "Custom..." axis fallback,
    -- manual staging edits) aren't guaranteed to send matching case.
    -- ensure_axis_code() also snake_cases free text and creates the
    -- lookup row when it's new, so a value like "Holiday Calendar"
    -- no longer fails the card_variants FK. NULL stays NULL.
    v_row.foil_type    := ensure_axis_code('foil_types',    v_row.foil_type);
    v_row.foil_pattern := ensure_axis_code('foil_patterns', v_row.foil_pattern);
    v_row.texture      := ensure_axis_code('textures',      v_row.texture);
    v_row.material     := ensure_axis_code('materials',     v_row.material);
    v_row.size         := ensure_axis_code('sizes',         v_row.size);
    v_row.stamp_type   := ensure_axis_code('stamp_types',   v_row.stamp_type);
    v_row.source_type  := ensure_axis_code('source_types',  v_row.source_type);

    v_is_ebay := (v_row.source = 'ebay');

    -- 2. Resolve or create the purchase
    SELECT id INTO v_purchase_id
    FROM purchases
    WHERE reference_id = v_row.order_number;

    IF v_purchase_id IS NULL THEN
        INSERT INTO purchases (
            source, purchase_type, reference_id, total_cost,
            card_count, purchased_at
        ) VALUES (
            COALESCE(v_row.source, 'tcgplayer'),
            'single',
            v_row.order_number,
            v_row.price * v_row.quantity,
            v_row.quantity,
            COALESCE(v_row.order_date, now())
        )
        RETURNING id INTO v_purchase_id;
    END IF;

    -- 3. Resolve or create the card_variant (seven-axis, NULL-safe)
    SELECT id INTO v_variant_id
    FROM card_variants
    WHERE card_id      = v_row.card_id
      AND foil_type    IS NOT DISTINCT FROM v_row.foil_type
      AND foil_pattern IS NOT DISTINCT FROM v_row.foil_pattern
      AND texture      IS NOT DISTINCT FROM v_row.texture
      AND material     IS NOT DISTINCT FROM v_row.material
      AND size         IS NOT DISTINCT FROM v_row.size
      AND stamp_type   IS NOT DISTINCT FROM v_row.stamp_type
      AND source_type  IS NOT DISTINCT FROM v_row.source_type;

    IF v_variant_id IS NULL THEN
        INSERT INTO card_variants (
            card_id, foil_type, foil_pattern, texture,
            material, size, stamp_type, source_type
        ) VALUES (
            v_row.card_id, v_row.foil_type, v_row.foil_pattern, v_row.texture,
            v_row.material, v_row.size, v_row.stamp_type, v_row.source_type
        )
        ON CONFLICT (card_id, variant_key)
        DO UPDATE SET card_id = EXCLUDED.card_id
        RETURNING id INTO v_variant_id;
    END IF;

    -- 5. Insert the inventory row (per-source $ handling)
    v_cost   := v_row.price;
    v_asking := v_row.listing_price;

    INSERT INTO inventory (
        card_id, purchase_id, condition, is_graded, quantity,
        cost_basis, asking_price, notes, acquired_at, variant_id
    ) VALUES (
        v_row.card_id, v_purchase_id, v_row.condition, false, v_row.quantity,
        v_cost, v_asking, v_row.notes,
        COALESCE(v_row.order_date, now()), v_variant_id
    )
    RETURNING id INTO v_inventory_id;

    -- 5b. Recompute purchase summary totals
    UPDATE purchases p
    SET
        card_count    = totals.card_count,
        total_cost    = totals.total_cost,
        purchase_type = CASE WHEN totals.card_count > 1 THEN 'lot' ELSE 'single' END
    FROM (
        SELECT
            COALESCE(SUM(quantity), 0)              AS card_count,
            COALESCE(SUM(cost_basis * quantity), 0) AS total_cost
        FROM inventory
        WHERE purchase_id = v_purchase_id
    ) AS totals
    WHERE p.id = v_purchase_id;

    -- 6. Upsert market price snapshot if available
    v_market_price := v_row.market_price;
    v_market_date  := v_row.market_price_date;

    IF v_market_price IS NOT NULL THEN
        INSERT INTO market_prices (variant_id, condition, market_price, source, updated_at)
        VALUES (
            v_variant_id, v_row.condition, v_market_price,
            CASE WHEN v_is_ebay THEN 'ebay' ELSE 'pokemontcg' END,
            COALESCE(v_market_date::timestamptz, now())
        )
        ON CONFLICT (variant_id, condition)
        DO UPDATE SET
            market_price = EXCLUDED.market_price,
            source       = EXCLUDED.source,
            updated_at   = EXCLUDED.updated_at
        WHERE market_prices.updated_at < EXCLUDED.updated_at;
    END IF;

    -- 7. Record eBay listing mapping and platform state
    IF v_is_ebay AND v_variant_id IS NOT NULL THEN

        INSERT INTO ebay_listing_map
            (item_id, variation_name, variant_id, condition, source, last_synced_at)
        VALUES (
            v_row.order_number,
            COALESCE(v_row.variation_name, ''),
            v_variant_id,
            v_row.condition,
            'manual_push',
            now()
        )
        ON CONFLICT DO NOTHING;

        INSERT INTO platform_listings
            (variant_id, platform, listing_id, external_id, list_price,
             quantity_listed, status, account, listed_at)
        VALUES (
            v_variant_id,
            'ebay',
            v_row.order_number,
            COALESCE(v_row.variation_name, ''),
            v_row.listing_price,
            v_row.quantity,
            CASE WHEN v_row.quantity > 0 THEN 'active' ELSE 'out_of_stock' END,
            v_row.account,
            now()
        )
        ON CONFLICT (variant_id, platform, listing_id, external_id) DO NOTHING;

        -- Update list_price and account if staging was manually corrected
        UPDATE platform_listings
        SET list_price = v_row.listing_price,
            account    = v_row.account,
            synced_at  = now()
        WHERE variant_id  = v_variant_id
          AND platform    = 'ebay'
          AND listing_id  = v_row.order_number
          AND external_id = COALESCE(v_row.variation_name, '');

    END IF;

    -- 8. Mark staging row as processed
    UPDATE staging
    SET status = 'processed', updated_at = now()
    WHERE id = p_staging_id;

    RETURN jsonb_build_object(
        'inventory_id', v_inventory_id,
        'variant_id',   v_variant_id,
        'purchase_id',  v_purchase_id
    );
END;
$function$;
