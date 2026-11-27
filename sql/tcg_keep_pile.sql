-- "Keep it, no refund" pile (applied 2026-11-27).
--
-- Held cards are a WORK LIST: only cards with something left to do (message the seller, wait for a
-- refund, send back, decide). A card that arrived wrong but that Fei will just keep and absorb the cost
-- on has nothing left to do, so it goes to the kept pile instead: status 'kept' + a REQUIRED reason.
-- It is out of inventory (for now), out of the On hold list, the Held badge, the Follow-ups list and the
-- seller gallery. Later it can be released into inventory (Staging Review) with a condition chosen then.
--
--   keep_reason: damaged | lower_condition | wrong_card | small_value | other  (other needs a note)
--   tcg_keep_cards(staging row, qty, reason, note)   at the receive step: instead of Hold
--   tcg_keep_held(held card, reason, note)           for a card that is already on hold / in the grading pile
--   tcg_unkeep_held(held card)                       back to on hold
--   tcg_release_held (tcg_held.sql)                  also works from the kept pile, with a condition
--   Staging quantity = ordered - short - held - kept (tcg_staged_lines.kept_qty, see tcg_stage.sql)

ALTER TABLE tcg_held_cards ADD COLUMN IF NOT EXISTS keep_reason text;
ALTER TABLE tcg_held_cards DROP CONSTRAINT IF EXISTS tcg_held_cards_status_check;
ALTER TABLE tcg_held_cards ADD CONSTRAINT tcg_held_cards_status_check
    CHECK (status IN ('held', 'grading', 'kept', 'returned', 'refunded', 'released'));

CREATE OR REPLACE FUNCTION public._tcg_check_keep_reason(p_reason text, p_note text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    IF p_reason IS NULL OR p_reason NOT IN ('damaged', 'lower_condition', 'wrong_card', 'small_value', 'other') THEN
        RAISE EXCEPTION 'Pick a reason for keeping it';
    END IF;
    IF p_reason = 'other' AND length(btrim(COALESCE(p_note, ''))) = 0 THEN
        RAISE EXCEPTION 'Write a short note when the reason is Other';
    END IF;
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_keep_cards(p_staging_id uuid, p_qty integer, p_reason text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE l tcg_staged_lines; s staging; ln tcg_order_lines;
BEGIN
    IF p_qty < 1 THEN RAISE EXCEPTION 'Keep at least 1 card'; END IF;
    PERFORM _tcg_check_keep_reason(p_reason, p_note);
    SELECT * INTO l FROM tcg_staged_lines WHERE staging_id = p_staging_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'This staging row did not come from a TCGplayer order'; END IF;
    IF l.ordered_qty - l.short_qty - l.held_qty - l.kept_qty < p_qty THEN
        RAISE EXCEPTION 'Only % card(s) left on this line', l.ordered_qty - l.short_qty - l.held_qty - l.kept_qty;
    END IF;
    SELECT * INTO s FROM staging WHERE id = p_staging_id;
    SELECT * INTO ln FROM tcg_order_lines WHERE id = l.line_id;
    INSERT INTO tcg_held_cards (order_number, line_id, staging_id, card_id, card_name, card_number, set_label, condition_raw, unit_cost, flags, note, status, keep_reason)
    SELECT l.order_number, l.line_id, p_staging_id, s.card_id, s.card_name, s.card_number, s.set_name, COALESCE(ln.condition_raw, s.condition), s.price,
           ARRAY['kept']::text[], NULLIF(btrim(p_note), ''), 'kept', p_reason
    FROM generate_series(1, p_qty);
    UPDATE tcg_staged_lines SET kept_qty = kept_qty + p_qty WHERE staging_id = p_staging_id;
    PERFORM _tcg_recompute(p_staging_id);
    RETURN (SELECT jsonb_build_object('quantity', s2.quantity, 'status', s2.status, 'short_qty', l2.short_qty, 'held_qty', l2.held_qty, 'kept_qty', l2.kept_qty)
            FROM staging s2 JOIN tcg_staged_lines l2 ON l2.staging_id = s2.id WHERE s2.id = p_staging_id);
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_keep_held(p_held_id uuid, p_reason text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    PERFORM _tcg_check_keep_reason(p_reason, p_note);
    UPDATE tcg_held_cards SET status = 'kept', keep_reason = p_reason, note = COALESCE(NULLIF(btrim(p_note), ''), note)
    WHERE id = p_held_id AND status IN ('held', 'grading');
    IF NOT FOUND THEN RAISE EXCEPTION 'Only a card that is on hold (or in the grading pile) can be kept'; END IF;
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_unkeep_held(p_held_id uuid) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    UPDATE tcg_held_cards SET status = 'held', keep_reason = NULL WHERE id = p_held_id AND status = 'kept';
    IF NOT FOUND THEN RAISE EXCEPTION 'That card is not in the kept pile'; END IF;
END $f$;

DO $$
DECLARE f text;
BEGIN
    FOREACH f IN ARRAY ARRAY['_tcg_check_keep_reason(text,text)', 'tcg_keep_cards(uuid,integer,text,text)', 'tcg_keep_held(uuid,text,text)', 'tcg_unkeep_held(uuid)'] LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
    END LOOP;
END $$;
