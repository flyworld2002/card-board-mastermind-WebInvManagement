-- TCGplayer catalogue lookup (applied 2026-11-28). Read-only views for the Catalog page's "TCGplayer catalogue" tab
-- (tcg-catalogue.js). Data: tcg_catalog_products / tcg_catalog_groups (sql/tcg_catalog.sql, refreshed weekly by
-- importer/tcg_catalog.py) and tcg_products (TCGplayer product + printing -> our exact card variant).

-- One row per TCGplayer product, with every link to one of our card variants (one per printing).
CREATE OR REPLACE VIEW v_tcg_catalog_lookup WITH (security_invoker = true) AS
SELECT p.product_id, p.name, p.number, p.rarity, p.is_card, p.printings, p.url, p.image_url, p.modified_on,
       g.group_id, g.name AS set_name, g.abbreviation, g.published_on, g.card_set_id, cs.name AS our_set_name,
       COALESCE(l.n, 0) AS link_count, l.links
FROM tcg_catalog_products p
JOIN tcg_catalog_groups g ON g.group_id = p.group_id
LEFT JOIN card_sets cs ON cs.id = g.card_set_id
LEFT JOIN LATERAL (
    SELECT count(*) AS n,
           jsonb_agg(jsonb_build_object(
               'printing', t.printing, 'source', t.source, 'card', cm.name, 'number', cm.card_number,
               'foil_type', v.foil_type, 'foil_pattern', v.foil_pattern, 'texture', v.texture, 'material', v.material,
               'size', v.size, 'stamp_type', v.stamp_type, 'source_type', v.source_type) ORDER BY t.printing) AS links
    FROM tcg_products t
    LEFT JOIN card_variants v ON v.id = t.variant_id
    LEFT JOIN card_master cm ON cm.id = COALESCE(t.card_id, v.card_id)
    WHERE t.product_id = p.product_id) l ON true;

-- One row per TCGplayer set: is it tied to one of our sets, and how many of its cards are linked.
CREATE OR REPLACE VIEW v_tcg_catalog_sets WITH (security_invoker = true) AS
SELECT g.group_id, g.name, g.abbreviation, g.published_on, g.synced_at, g.card_set_id, cs.name AS our_set_name,
       count(p.product_id) FILTER (WHERE p.is_card) AS cards,
       count(p.product_id) FILTER (WHERE p.is_card AND EXISTS (SELECT 1 FROM tcg_products t WHERE t.product_id = p.product_id)) AS linked_cards
FROM tcg_catalog_groups g
LEFT JOIN card_sets cs ON cs.id = g.card_set_id
LEFT JOIN tcg_catalog_products p ON p.group_id = g.group_id
GROUP BY g.group_id, cs.name;
