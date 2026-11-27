-- Grading pile for held cards (applied 2026-11-27).
--
-- A card held ONLY "for grading" is not a problem to chase: it just sits in the grading pile until
-- Fei decides what to do. Such cards get their own status 'grading' so they stay out of the On hold
-- list, the Held badge, the Follow-ups list and the seller gallery. Cards held for any other reason
-- (alone or together with grading) stay 'held'.
--   tcg_hold_cards (tcg_stage.sql)   a hold with flags exactly {grading} is created as 'grading'
--   tcg_set_grading(card, on)        move a card into / out of the pile by hand
--   tcg_release_held (tcg_held.sql)  also works from the grading pile
--   tcg_gallery (tcg_order_photos.sql) leaves grading cards out

ALTER TABLE tcg_held_cards DROP CONSTRAINT IF EXISTS tcg_held_cards_status_check;
ALTER TABLE tcg_held_cards ADD CONSTRAINT tcg_held_cards_status_check
    CHECK (status IN ('held', 'grading', 'kept', 'returned', 'refunded', 'released'));

CREATE OR REPLACE FUNCTION public.tcg_set_grading(p_held_id uuid, p_on boolean) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    IF p_on THEN
        UPDATE tcg_held_cards SET status = 'grading' WHERE id = p_held_id AND status = 'held';
        IF NOT FOUND THEN RAISE EXCEPTION 'Only a card that is on hold can go to the grading pile'; END IF;
    ELSE
        UPDATE tcg_held_cards SET status = 'held' WHERE id = p_held_id AND status = 'grading';
        IF NOT FOUND THEN RAISE EXCEPTION 'That card is not in the grading pile'; END IF;
    END IF;
END $f$;
REVOKE EXECUTE ON FUNCTION public.tcg_set_grading(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tcg_set_grading(uuid, boolean) TO authenticated;

-- Cards already held for grading only move into the pile.
UPDATE tcg_held_cards SET status = 'grading' WHERE status = 'held' AND flags = ARRAY['grading']::text[];
