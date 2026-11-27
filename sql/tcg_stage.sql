-- TCGplayer orders -> Staging Review, with per-row Short and Hold (applied 2026-11-26).
--
-- stage_tcg_order(order) copies an order's cards into staging (same shape the HTML importer
-- makes: matched cards go in as 'approved', the rest as 'pending'/'not_found' to be matched in
-- Staging Review; shipping + tax are spread over the cards by value) and marks the order
-- received. Run twice it does nothing the second time.
-- tcg_set_short(row, n) = n cards of that line did not arrive. tcg_hold_cards(row, n, flags, note)
-- = n cards arrived but are set aside (individual rows in tcg_held_cards, flags can stack).
-- Both shrink the staging row's quantity to what is actually received and skip it at 0.
-- Refunds, photos and the Held page come in the next step.

CREATE TABLE IF NOT EXISTS tcg_staged_lines (
    staging_id    uuid PRIMARY KEY REFERENCES staging(id) ON DELETE CASCADE,
    order_number  text NOT NULL,
    line_id       uuid,
    ordered_qty   integer NOT NULL,
    short_qty     integer NOT NULL DEFAULT 0,
    held_qty      integer NOT NULL DEFAULT 0,
    short_note    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tcg_staged_lines_order_idx ON tcg_staged_lines (order_number);

CREATE TABLE IF NOT EXISTS tcg_held_cards (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number   text NOT NULL,
    line_id        uuid,
    staging_id     uuid REFERENCES staging(id) ON DELETE SET NULL,
    card_id        uuid,
    card_name      text NOT NULL,
    card_number    text,
    set_label      text,
    condition_raw  text,
    unit_cost      numeric,
    flags          text[] NOT NULL,   -- wrong_condition | wrong_item | error | grading | waiting_seller (can stack)
    note           text,
    status         text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'returned', 'refunded', 'released')),
    refund_amount  numeric,
    created_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS tcg_held_cards_order_idx ON tcg_held_cards (order_number);

ALTER TABLE tcg_staged_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_held_cards   ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tcg_staged_lines', 'tcg_held_cards'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass AND polname = 'authenticated only') THEN
            EXECUTE format('CREATE POLICY "authenticated only" ON public.%I FOR ALL USING (auth.role() = ''authenticated''::text)', t);
        END IF;
    END LOOP;
END $$;

-- staging.quantity = ordered - short - held; a row with nothing left is 'skipped', and comes back
-- if the numbers are corrected. Refuses once the row has been pushed to inventory.
CREATE OR REPLACE FUNCTION public._tcg_recompute(p_staging_id uuid) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE l tcg_staged_lines; s staging; q integer;
BEGIN
    SELECT * INTO l FROM tcg_staged_lines WHERE staging_id = p_staging_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'This staging row did not come from a TCGplayer order'; END IF;
    SELECT * INTO s FROM staging WHERE id = p_staging_id FOR UPDATE;
    IF s.status = 'processed' THEN RAISE EXCEPTION 'Already pushed to inventory, cannot change it here'; END IF;
    q := l.ordered_qty - l.short_qty - l.held_qty;
    IF q < 0 THEN RAISE EXCEPTION 'Short + held (%) is more than the % ordered', l.short_qty + l.held_qty, l.ordered_qty; END IF;
    UPDATE staging SET quantity = GREATEST(q, 0),
        status = CASE WHEN q = 0 THEN 'skipped'
                      WHEN s.status = 'skipped' THEN (CASE WHEN s.card_id IS NOT NULL AND s.match_status = 'matched' THEN 'approved' ELSE 'pending' END)
                      ELSE s.status END,
        updated_at = now()
    WHERE id = p_staging_id;
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_set_short(p_staging_id uuid, p_short_qty integer, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $f$
BEGIN
    IF p_short_qty < 0 THEN RAISE EXCEPTION 'Short quantity cannot be negative'; END IF;
    UPDATE tcg_staged_lines SET short_qty = p_short_qty, short_note = p_note WHERE staging_id = p_staging_id;
    PERFORM _tcg_recompute(p_staging_id);
    RETURN (SELECT jsonb_build_object('quantity', s.quantity, 'status', s.status, 'short_qty', l.short_qty, 'held_qty', l.held_qty)
            FROM staging s JOIN tcg_staged_lines l ON l.staging_id = s.id WHERE s.id = p_staging_id);
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_hold_cards(p_staging_id uuid, p_qty integer, p_flags text[], p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE l tcg_staged_lines; s staging; ln tcg_order_lines;
BEGIN
    IF p_qty < 1 THEN RAISE EXCEPTION 'Hold at least 1 card'; END IF;
    IF p_flags IS NULL OR cardinality(p_flags) = 0 THEN RAISE EXCEPTION 'Pick at least one reason'; END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_flags) f WHERE f NOT IN ('wrong_condition', 'wrong_item', 'error', 'grading', 'waiting_seller')) THEN
        RAISE EXCEPTION 'Unknown reason in %', p_flags;
    END IF;
    SELECT * INTO l FROM tcg_staged_lines WHERE staging_id = p_staging_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'This staging row did not come from a TCGplayer order'; END IF;
    IF l.ordered_qty - l.short_qty - l.held_qty < p_qty THEN RAISE EXCEPTION 'Only % card(s) left on this line', l.ordered_qty - l.short_qty - l.held_qty; END IF;
    SELECT * INTO s FROM staging WHERE id = p_staging_id;
    SELECT * INTO ln FROM tcg_order_lines WHERE id = l.line_id;
    INSERT INTO tcg_held_cards (order_number, line_id, staging_id, card_id, card_name, card_number, set_label, condition_raw, unit_cost, flags, note, status)
    SELECT l.order_number, l.line_id, p_staging_id, s.card_id, s.card_name, s.card_number, s.set_name, COALESCE(ln.condition_raw, s.condition), s.price, p_flags, p_note,
           CASE WHEN p_flags = ARRAY['grading']::text[] THEN 'grading' ELSE 'held' END   -- grading only => the grading pile
    FROM generate_series(1, p_qty);
    UPDATE tcg_staged_lines SET held_qty = held_qty + p_qty WHERE staging_id = p_staging_id;
    PERFORM _tcg_recompute(p_staging_id);
    RETURN (SELECT jsonb_build_object('quantity', s2.quantity, 'status', s2.status, 'short_qty', l2.short_qty, 'held_qty', l2.held_qty)
            FROM staging s2 JOIN tcg_staged_lines l2 ON l2.staging_id = s2.id WHERE s2.id = p_staging_id);
END $f$;

CREATE OR REPLACE FUNCTION public.stage_tcg_order(p_order text) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE o tcg_orders; ln tcg_order_lines; v_batch text; v_rate numeric; v_base numeric; v_id uuid; v_cond text;
        v_staged integer := 0; v_unmatched integer := 0;
BEGIN
    SELECT * INTO o FROM tcg_orders WHERE order_number = p_order FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order % not found', p_order; END IF;
    IF o.status = 'cancelled' THEN RAISE EXCEPTION 'Order % is cancelled', p_order; END IF;
    SELECT import_batch INTO v_batch FROM staging WHERE order_number = p_order LIMIT 1;
    IF v_batch IS NOT NULL THEN
        RETURN jsonb_build_object('already', true, 'batch_id', v_batch);
    END IF;
    v_batch := 'TCGP_' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD_HH24MISS');
    SELECT COALESCE(NULLIF(o.subtotal, 0), SUM(unit_price * quantity)) INTO v_base FROM tcg_order_lines WHERE order_number = p_order;
    v_rate := CASE WHEN COALESCE(v_base, 0) > 0 THEN (COALESCE(o.shipping, 0) + COALESCE(o.tax, 0)) / v_base ELSE 0 END;
    FOR ln IN SELECT * FROM tcg_order_lines WHERE order_number = p_order ORDER BY line_no LOOP
        v_cond := CASE WHEN lower(ln.condition_raw) LIKE 'lightly played%' THEN 'Lightly Played'
                       WHEN lower(ln.condition_raw) LIKE 'moderately played%' THEN 'Moderately Played'
                       WHEN lower(ln.condition_raw) LIKE 'heavily played%' THEN 'Heavily Played'
                       WHEN lower(ln.condition_raw) LIKE 'damaged%' THEN 'Damaged'
                       ELSE 'Near Mint' END;
        INSERT INTO staging (import_batch, order_number, order_date, source, card_name, set_name, condition, foil_type, foil_pattern, texture,
                             quantity, price, card_id, match_status, status, notes, card_number)
        VALUES (v_batch, p_order, o.ordered_on::timestamptz, 'tcgplayer', ln.card_name, ln.set_label, v_cond, ln.foil_type, ln.foil_pattern, ln.texture,
                ln.quantity, round(ln.unit_price * (1 + v_rate), 2), ln.card_id,
                CASE WHEN ln.card_id IS NOT NULL THEN 'matched' ELSE 'not_found' END,
                CASE WHEN ln.card_id IS NOT NULL THEN 'approved' ELSE 'pending' END,
                'TCGPlayer: ' || ln.card_name || ' ' || COALESCE('#' || ln.card_number, '(no # printed)') || ' | Set: ' || COALESCE(ln.set_label, '?')
                    || COALESCE(' | Rarity: ' || ln.rarity, '') || ' | Condition: ' || COALESCE(ln.condition_raw, '?')
                    || ' | $' || to_char(ln.unit_price, 'FM999990.00') || ' x' || ln.quantity,
                NULLIF(ltrim(COALESCE(ln.card_number, ''), '0'), ''))
        RETURNING id INTO v_id;
        INSERT INTO tcg_staged_lines (staging_id, order_number, line_id, ordered_qty) VALUES (v_id, p_order, ln.id, ln.quantity);
        v_staged := v_staged + 1;
        IF ln.card_id IS NULL THEN v_unmatched := v_unmatched + 1; END IF;
    END LOOP;
    IF v_staged = 0 THEN RAISE EXCEPTION 'Order % has no card lines', p_order; END IF;
    UPDATE tcg_orders SET received_at = COALESCE(received_at, now()), received_by = COALESCE(received_by, 'staging'), last_changed_at = now()
    WHERE order_number = p_order;
    RETURN jsonb_build_object('already', false, 'batch_id', v_batch, 'staged', v_staged, 'unmatched', v_unmatched);
END $f$;
