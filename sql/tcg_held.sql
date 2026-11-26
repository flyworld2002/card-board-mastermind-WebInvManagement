-- Held cards, refund allocation, photos and the public per-order gallery (applied 2026-11-26).
--
-- Held cards live in tcg_held_cards (created by tcg_hold_cards, see tcg_stage.sql): one row per
-- physical card, flags that can stack, a note, photos, and a status (held / returned / refunded /
-- released). Photos are files in the public storage bucket "tcg-held-photos" (unguessable paths),
-- listed in tcg_held_photos. Each order has a random gallery_token; gallery.html + tcg_gallery(token)
-- show that order's held-card photos to anyone with the link (card, reason labels and photos only,
-- no prices, notes or seller). The Held page deletes photos 90 days after a card is resolved.
--
-- Refunds (tcg_order_refunds, read from the order pages) are assigned to specific cards in
-- tcg_refund_allocations. kind: held (a held card), short (cards that never arrived), order (spread
-- over the order's cards: needs a cost review, NOT applied to inventory automatically), none (looked at,
-- no change needed).
-- v_tcg_refund_review lists refunds that are not fully assigned yet.

ALTER TABLE tcg_orders ADD COLUMN IF NOT EXISTS gallery_token uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS tcg_orders_gallery_token_idx ON tcg_orders (gallery_token);

CREATE TABLE IF NOT EXISTS tcg_held_photos (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    held_id       uuid NOT NULL REFERENCES tcg_held_cards(id) ON DELETE CASCADE,
    order_number  text NOT NULL,
    path          text NOT NULL,            -- object path inside the tcg-held-photos bucket
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tcg_held_photos_held_idx ON tcg_held_photos (held_id);

CREATE TABLE IF NOT EXISTS tcg_refund_allocations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number  text NOT NULL,
    refund_id     bigint NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('held', 'short', 'order', 'none')),
    held_id       uuid REFERENCES tcg_held_cards(id) ON DELETE SET NULL,
    line_id       uuid,
    qty           integer,
    amount        numeric NOT NULL CHECK (amount > 0),
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tcg_refund_alloc_idx ON tcg_refund_allocations (order_number, refund_id);

ALTER TABLE tcg_held_photos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_refund_allocations ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tcg_held_photos', 'tcg_refund_allocations'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass AND polname = 'authenticated only') THEN
            EXECUTE format('CREATE POLICY "authenticated only" ON public.%I FOR ALL USING (auth.role() = ''authenticated''::text)', t);
        END IF;
    END LOOP;
END $$;

-- Photo storage: public bucket (the gallery link works without signing in); only signed-in users can add or delete.
INSERT INTO storage.buckets (id, name, public) VALUES ('tcg-held-photos', 'tcg-held-photos', true) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname = 'tcg held photos: signed-in write') THEN
        CREATE POLICY "tcg held photos: signed-in write" ON storage.objects FOR ALL
            USING (bucket_id = 'tcg-held-photos' AND auth.role() = 'authenticated')
            WITH CHECK (bucket_id = 'tcg-held-photos' AND auth.role() = 'authenticated');
    END IF;
END $$;

-- Public gallery data for one order, found by its random token.
CREATE OR REPLACE FUNCTION public.tcg_gallery(p_token uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $f$
    SELECT jsonb_build_object(
        'order_number', o.order_number,
        'ordered_on', o.ordered_on,
        'cards', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'card_name', h.card_name, 'card_number', h.card_number, 'set', h.set_label,
                'condition', h.condition_raw, 'flags', h.flags,
                'photos', (SELECT jsonb_agg(p.path ORDER BY p.created_at) FROM tcg_held_photos p WHERE p.held_id = h.id)
            ) ORDER BY h.created_at)
            FROM tcg_held_cards h
            WHERE h.order_number = o.order_number AND EXISTS (SELECT 1 FROM tcg_held_photos p2 WHERE p2.held_id = h.id)
        ), '[]'::jsonb))
    FROM tcg_orders o WHERE o.gallery_token = p_token
$f$;
GRANT EXECUTE ON FUNCTION public.tcg_gallery(uuid) TO anon, authenticated;

-- A held card was sent back or refunded.
CREATE OR REPLACE FUNCTION public.tcg_resolve_held(p_held_id uuid, p_status text, p_refund numeric DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    IF p_status NOT IN ('returned', 'refunded') THEN RAISE EXCEPTION 'Status must be returned or refunded'; END IF;
    UPDATE tcg_held_cards SET status = p_status, refund_amount = COALESCE(p_refund, refund_amount), resolved_at = now()
    WHERE id = p_held_id AND status = 'held';
    IF NOT FOUND THEN RAISE EXCEPTION 'That card is not on hold'; END IF;
END $f$;

-- A held card is fine after all (or kept after a refund): it goes into Staging Review as one approved
-- card at p_cost (default: its landed cost) and is pushed to inventory from there.
CREATE OR REPLACE FUNCTION public.tcg_release_held(p_held_id uuid, p_cost numeric DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE h tcg_held_cards; s staging; v_batch text;
BEGIN
    SELECT * INTO h FROM tcg_held_cards WHERE id = p_held_id AND status = 'held' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That card is not on hold'; END IF;
    SELECT * INTO s FROM staging WHERE id = h.staging_id;
    v_batch := 'TCGP_HELD_' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD_HH24MISS');
    INSERT INTO staging (import_batch, order_number, order_date, source, card_name, set_name, condition, foil_type, foil_pattern, texture,
                         material, size, stamp_type, source_type, quantity, price, card_id, match_status, status, notes, card_number)
    VALUES (v_batch, h.order_number, COALESCE(s.order_date, now()), 'tcgplayer', h.card_name, COALESCE(s.set_name, h.set_label),
            COALESCE(s.condition, 'Near Mint'), s.foil_type, s.foil_pattern, s.texture, s.material, s.size, s.stamp_type, s.source_type,
            1, COALESCE(p_cost, h.unit_cost, 0), h.card_id,
            CASE WHEN h.card_id IS NOT NULL THEN 'matched' ELSE 'not_found' END,
            CASE WHEN h.card_id IS NOT NULL THEN 'approved' ELSE 'pending' END,
            'Released from hold (' || array_to_string(h.flags, ', ') || '). Check the condition before pushing.', h.card_number);
    UPDATE tcg_held_cards SET status = 'released', resolved_at = now() WHERE id = p_held_id;
    RETURN jsonb_build_object('batch_id', v_batch);
END $f$;

-- Assign (part of) a refund to a held card, to cards that never arrived, or to the order as a whole.
CREATE OR REPLACE FUNCTION public.tcg_allocate_refund(p_order text, p_refund_id bigint, p_kind text, p_amount numeric,
        p_held_id uuid DEFAULT NULL, p_line_id uuid DEFAULT NULL, p_qty integer DEFAULT NULL, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE r tcg_order_refunds; used numeric;
BEGIN
    SELECT * INTO r FROM tcg_order_refunds WHERE order_number = p_order AND refund_id = p_refund_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
    SELECT COALESCE(SUM(amount), 0) INTO used FROM tcg_refund_allocations WHERE order_number = p_order AND refund_id = p_refund_id;
    IF p_amount <= 0 OR p_amount > r.amount - used + 0.004 THEN
        RAISE EXCEPTION 'Amount must be between 0.01 and % (what is left of this refund)', r.amount - used;
    END IF;
    IF p_kind = 'held' AND (p_held_id IS NULL OR NOT EXISTS (SELECT 1 FROM tcg_held_cards WHERE id = p_held_id AND order_number = p_order)) THEN
        RAISE EXCEPTION 'Pick a held card from this order';
    END IF;
    IF p_kind = 'short' AND (p_line_id IS NULL OR NOT EXISTS (SELECT 1 FROM tcg_order_lines WHERE id = p_line_id AND order_number = p_order)) THEN
        RAISE EXCEPTION 'Pick a card line from this order';
    END IF;
    INSERT INTO tcg_refund_allocations (order_number, refund_id, kind, held_id, line_id, qty, amount, note)
    VALUES (p_order, p_refund_id, p_kind, p_held_id, p_line_id, p_qty, p_amount, p_note);
    IF p_kind = 'held' THEN
        UPDATE tcg_held_cards SET refund_amount = COALESCE(refund_amount, 0) + p_amount WHERE id = p_held_id;
    END IF;
END $f$;

CREATE OR REPLACE VIEW v_tcg_refund_review WITH (security_invoker = true) AS
SELECT r.order_number, r.refund_id, r.issued_on, r.amount, r.kind, o.seller, o.status, o.received_at, o.received_by,
       COALESCE(a.used, 0) AS allocated, r.amount - COALESCE(a.used, 0) AS remaining
FROM tcg_order_refunds r
JOIN tcg_orders o ON o.order_number = r.order_number
LEFT JOIN LATERAL (SELECT SUM(x.amount) AS used FROM tcg_refund_allocations x
                   WHERE x.order_number = r.order_number AND x.refund_id = r.refund_id) a ON true
WHERE o.status <> 'cancelled' AND r.amount - COALESCE(a.used, 0) > 0.004;

-- Only signed-in users may call the tracker's write functions (RLS already stops anon, this makes it explicit).
-- Applied 2026-11-26. tcg_gallery stays public on purpose.
DO $$
DECLARE f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'stage_tcg_order(text)', 'tcg_set_short(uuid,integer,text)', 'tcg_hold_cards(uuid,integer,text[],text)', '_tcg_recompute(uuid)',
        'tcg_link_line(uuid,uuid)', 'tcg_clear_link(uuid)', 'tcg_resolve_held(uuid,text,numeric)', 'tcg_release_held(uuid,numeric)',
        'tcg_allocate_refund(text,bigint,text,numeric,uuid,uuid,integer,text)'] LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
    END LOOP;
END $$;
