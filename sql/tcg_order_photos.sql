-- TCGplayer seller messages, Phase 4: photos on the order itself + a fuller seller gallery (applied 2026-11-26).
-- Plan: Card-Board-MasterMind/docs/plans/tcg-seller-messages.md
--
-- Order photos (packing slip, opened contents, damaged package) are PRIVATE: they live in the
-- non-public storage bucket "tcg-order-photos" (only signed-in users can open them) because a slip
-- or label shows Fei's name and address. A photo is shown to the seller only when "Show to seller"
-- is switched on: the page then puts a copy in the public bucket "tcg-held-photos" (public_path) and
-- gallery.html / tcg_gallery() list it. Switching it off removes the public copy.
-- Card photos (tcg_held_photos) are unchanged and shared by default.
--
-- tcg_gallery(token) now also returns:
--   order_photos  public paths of the order photos that are switched on
--   missing       cards marked Short (name, number, quantity; no prices)
--   cards[].received  the "what arrived" note, only for cards held as Wrong item
-- Retention: the Held page deletes order photos 90 days after the order stops needing follow-up.

CREATE TABLE IF NOT EXISTS tcg_order_photos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number    text NOT NULL REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    kind            text NOT NULL DEFAULT 'other' CHECK (kind IN ('slip', 'contents', 'package', 'other')),
    caption         text,
    path            text NOT NULL,            -- object path in the private bucket tcg-order-photos
    show_to_seller  boolean NOT NULL DEFAULT false,
    public_path     text,                     -- copy in the public bucket while shown to the seller
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tcg_order_photos_order_idx ON tcg_order_photos (order_number);

ALTER TABLE tcg_order_photos ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tcg_order_photos'::regclass AND polname = 'authenticated only') THEN
        CREATE POLICY "authenticated only" ON public.tcg_order_photos FOR ALL USING (auth.role() = 'authenticated'::text);
    END IF;
END $$;

-- Private bucket (public = false) for the originals; only signed-in users can read or write.
INSERT INTO storage.buckets (id, name, public) VALUES ('tcg-order-photos', 'tcg-order-photos', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname = 'tcg order photos: signed-in only') THEN
        CREATE POLICY "tcg order photos: signed-in only" ON storage.objects FOR ALL
            USING (bucket_id = 'tcg-order-photos' AND auth.role() = 'authenticated')
            WITH CHECK (bucket_id = 'tcg-order-photos' AND auth.role() = 'authenticated');
    END IF;
END $$;

-- The public seller gallery for one order, found by its random token.
CREATE OR REPLACE FUNCTION public.tcg_gallery(p_token uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $f$
    SELECT jsonb_build_object(
        'order_number', o.order_number,
        'ordered_on', o.ordered_on,
        'cards', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'card_name', h.card_name, 'card_number', h.card_number, 'set', h.set_label,
                'condition', h.condition_raw, 'flags', h.flags,
                'received', CASE WHEN 'wrong_item' = ANY (h.flags) THEN NULLIF(btrim(h.note), '') END,
                'photos', (SELECT jsonb_agg(p.path ORDER BY p.created_at) FROM tcg_held_photos p WHERE p.held_id = h.id)
            ) ORDER BY h.created_at)
            FROM tcg_held_cards h
            WHERE h.order_number = o.order_number AND h.status NOT IN ('grading', 'kept') AND EXISTS (SELECT 1 FROM tcg_held_photos p2 WHERE p2.held_id = h.id)
        ), '[]'::jsonb),
        'order_photos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('path', op.public_path, 'kind', op.kind, 'caption', op.caption) ORDER BY op.created_at)
            FROM tcg_order_photos op
            WHERE op.order_number = o.order_number AND op.show_to_seller AND op.public_path IS NOT NULL
        ), '[]'::jsonb),
        'missing', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('card_name', l.card_name, 'card_number', l.card_number, 'qty', sl.short_qty) ORDER BY l.line_no)
            FROM tcg_staged_lines sl JOIN tcg_order_lines l ON l.id = sl.line_id
            WHERE sl.order_number = o.order_number AND sl.short_qty > 0 AND sl.short_resolved_at IS NULL
        ), '[]'::jsonb))
    FROM tcg_orders o WHERE o.gallery_token = p_token
$f$;
GRANT EXECUTE ON FUNCTION public.tcg_gallery(uuid) TO anon, authenticated;
