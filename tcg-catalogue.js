// tcg-catalogue.js
// "TCGplayer catalogue" tab of the Catalog page: read-only lookup over the app's copy of TCGplayer's product list
// (refreshed weekly by importer/tcg_catalog.py). Two views:
//   Cards - search TCGplayer products, see which of our exact card versions each one is linked to (or "not linked")
//   Sets  - which TCGplayer sets are tied to one of our sets; an untied set's cards can never match automatically
// Views: sql/tcg_catalog_lookup.sql (v_tcg_catalog_lookup, v_tcg_catalog_sets).

import { supabase } from './shared.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const PAGE = 50;
const pretty = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// survives leaving and coming back to the page (module state resets on every navigation)
const S = (window.__cbmTcgCatalogue ||= { view: 'cards', q: '', group: '', cardsOnly: true, unlinked: false, untiedOnly: false });

function variantLabel(l) {
    const parts = [l.foil_type && pretty(l.foil_type), l.foil_pattern && `${pretty(l.foil_pattern)} pattern`, l.stamp_type && pretty(l.stamp_type),
        l.texture && pretty(l.texture), l.material && pretty(l.material), l.size && pretty(l.size), l.source_type && pretty(l.source_type)].filter(Boolean);
    return parts.join(', ') || 'no finish details';
}

export async function renderTcgCatalogue(container, onOurCards) {
    container.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; margin:0 0 12px; flex-wrap:wrap;">
            <h2 style="margin:0;">Catalog</h2>
            <div style="display:flex; gap:6px; margin-left:12px;">
                <button class="btn" id="cat-tab-ours">Our cards</button>
                <button class="btn" style="background:var(--accent); color:#fff;">TCGplayer catalogue</button>
            </div>
            <span id="tcgc-refreshed" style="margin-left:auto; font-size:12px; color:var(--text-secondary);"></span>
        </div>
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 10px;">
            The app's copy of TCGplayer's product list. "Linked to" shows which of our exact card versions a TCGplayer product
            matches; order lines find their card through that link. Read-only.</p>
        <div style="display:flex; gap:6px; margin-bottom:10px;">
            <button class="btn tcgc-view" data-v="cards">Cards</button>
            <button class="btn tcgc-view" data-v="sets">Sets</button>
        </div>
        <div id="tcgc-body"></div>`;
    container.querySelector('#cat-tab-ours').addEventListener('click', () => { window.__cbmCatalogTab = 'ours'; onOurCards(); });
    const paintTabs = () => container.querySelectorAll('.tcgc-view').forEach(b => {
        b.style.background = b.dataset.v === S.view ? 'var(--accent)' : ''; b.style.color = b.dataset.v === S.view ? '#fff' : '';
    });
    container.querySelectorAll('.tcgc-view').forEach(b => b.addEventListener('click', () => { S.view = b.dataset.v; paintTabs(); show(); }));
    paintTabs();

    // sets: used by both views (dropdown + Sets table) and for "last refreshed"
    const { data: sets, error: setErr } = await supabase.from('v_tcg_catalog_sets').select('*').order('name');
    if (setErr) { container.querySelector('#tcgc-body').innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(setErr.message)}</p>`; return; }
    const refreshed = (sets || []).map(s => s.synced_at).filter(Boolean).sort().pop();
    if (refreshed) container.querySelector('#tcgc-refreshed').textContent = `Last refreshed ${new Date(refreshed).toLocaleString()}`;

    const body = container.querySelector('#tcgc-body');
    const show = () => (S.view === 'sets' ? showSets() : showCards());

    // ── Cards ────────────────────────────────────────────────────────────────
    function showCards() {
        body.innerHTML = `
            <div class="filters-bar" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
                <input type="search" id="tcgc-q" placeholder="Name and/or number, e.g. eiscue 205" value="${esc(S.q)}" style="min-width:220px; flex:1;" />
                <select id="tcgc-group" style="max-width:280px;">
                    <option value="">All TCGplayer sets</option>
                    ${(sets || []).map(s => `<option value="${s.group_id}" ${String(s.group_id) === String(S.group) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                </select>
                <label style="font-size:13px;"><input type="checkbox" id="tcgc-cards" ${S.cardsOnly ? 'checked' : ''} /> Cards only</label>
                <label style="font-size:13px;"><input type="checkbox" id="tcgc-unlinked" ${S.unlinked ? 'checked' : ''} /> Not linked only</label>
            </div>
            <div id="tcgc-count" style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;"></div>
            <div id="tcgc-results" style="overflow-x:auto;"></div>
            <div id="tcgc-more" style="text-align:center; margin-top:12px;"></div>`;
        let page = 0, timer = null, seq = 0;
        const query = (count) => {
            let q = supabase.from('v_tcg_catalog_lookup').select('*', count ? { count: 'exact' } : undefined);
            for (const tok of S.q.trim().split(/\s+/).filter(Boolean)) {
                if (/\d/.test(tok)) q = q.ilike('number', `${tok.replace(/^#/, '').replace(/[%_]/g, '')}%`);
                else q = q.ilike('name', `%${tok.replace(/[%_]/g, '')}%`);
            }
            if (S.group) q = q.eq('group_id', S.group);
            if (S.cardsOnly) q = q.eq('is_card', true);
            if (S.unlinked) q = q.eq('link_count', 0);
            return q.order('name').order('product_id');
        };
        const rowHtml = (p) => {
            const links = (p.links || []).map(l => `
                <div style="white-space:nowrap;"><span style="color:var(--text-secondary);">${esc(l.printing)}:</span>
                    ${esc(l.card || '?')}${l.number ? ` #${esc(l.number)}` : ''} · ${esc(variantLabel(l))}
                    ${l.source === 'order_match' ? '<span style="color:var(--text-secondary);" title="Linked when an order line was matched">(from an order)</span>' : ''}</div>`).join('');
            return `<tr style="border-top:1px solid var(--border);">
                <td style="padding:6px;">${p.image_url ? `<img src="${esc(p.image_url)}" loading="lazy" alt="" style="width:40px; border-radius:3px;" />` : ''}</td>
                <td style="padding:6px;">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</td>
                <td style="padding:6px;">${esc(p.set_name)}${p.card_set_id ? '' : ' <span style="color:var(--warning); font-size:11px;" title="This TCGplayer set is not tied to one of our sets">(set not tied)</span>'}</td>
                <td style="padding:6px; white-space:nowrap;">${esc(p.number || '')}</td>
                <td style="padding:6px;">${esc(p.rarity || '')}</td>
                <td style="padding:6px;">${esc((p.printings || []).join(', '))}</td>
                <td style="padding:6px; font-size:12px;">${links || '<span style="color:var(--warning);">not linked</span>'}</td>
            </tr>`;
        };
        const load = async (reset) => {
            const my = ++seq;
            if (reset) { page = 0; body.querySelector('#tcgc-results').innerHTML = '<p>Loading...</p>'; }
            const { data, error, count } = await query(reset).range(page * PAGE, page * PAGE + PAGE - 1);
            if (my !== seq || !body.isConnected) return;              // a newer search started, or the page changed
            const res = body.querySelector('#tcgc-results');
            if (error) { res.innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(error.message)}</p>`; return; }
            if (reset) {
                body.querySelector('#tcgc-count').textContent = `${(count ?? 0).toLocaleString()} product${count === 1 ? '' : 's'}`;
                res.innerHTML = data.length ? `<table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <thead><tr><th></th><th style="text-align:left;">Name</th><th style="text-align:left;">TCGplayer set</th><th style="text-align:left;">Number</th>
                    <th style="text-align:left;">Rarity</th><th style="text-align:left;">Printings</th><th style="text-align:left;">Linked to</th></tr></thead>
                    <tbody></tbody></table>` : '<p style="color:var(--text-secondary);">Nothing found.</p>';
            }
            res.querySelector('tbody')?.insertAdjacentHTML('beforeend', data.map(rowHtml).join(''));
            const more = body.querySelector('#tcgc-more');
            more.innerHTML = data.length === PAGE ? '<button class="btn" id="tcgc-load-more">Load more</button>' : '';
            more.querySelector('#tcgc-load-more')?.addEventListener('click', () => { page++; load(false); });
        };
        body.querySelector('#tcgc-q').addEventListener('input', (e) => { S.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => load(true), 300); });
        body.querySelector('#tcgc-group').addEventListener('change', (e) => { S.group = e.target.value; load(true); });
        body.querySelector('#tcgc-cards').addEventListener('change', (e) => { S.cardsOnly = e.target.checked; load(true); });
        body.querySelector('#tcgc-unlinked').addEventListener('change', (e) => { S.unlinked = e.target.checked; load(true); });
        load(true);
    }

    // ── Sets ─────────────────────────────────────────────────────────────────
    function showSets() {
        const untied = (sets || []).filter(s => !s.card_set_id);
        const draw = () => {
            const list = (sets || []).filter(s => !S.untiedOnly || !s.card_set_id)
                .sort((a, b) => (!!a.card_set_id - !!b.card_set_id) || (b.cards - a.cards) || a.name.localeCompare(b.name));
            body.innerHTML = `
                <p style="font-size:13px; margin:0 0 8px;"><strong>${untied.length}</strong> of ${(sets || []).length} TCGplayer sets are not tied to one of our sets.
                    Cards in an untied set never match an order line automatically. Many are sets we do not carry; tying one needs a set alias
                    (tcgplayer_set_aliases), which I can add when you ask.</p>
                <label style="font-size:13px;"><input type="checkbox" id="tcgc-untied" ${S.untiedOnly ? 'checked' : ''} /> Not tied only</label>
                <div style="overflow-x:auto; margin-top:8px;"><table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <thead><tr><th style="text-align:left;">TCGplayer set</th><th style="text-align:left;">Code</th><th style="text-align:left;">Our set</th>
                        <th style="text-align:right;">Cards</th><th style="text-align:right;">Linked</th><th></th></tr></thead>
                    <tbody>${list.map(s => `<tr style="border-top:1px solid var(--border);">
                        <td style="padding:5px 6px;">${esc(s.name)}</td>
                        <td style="padding:5px 6px; color:var(--text-secondary);">${esc(s.abbreviation || '')}</td>
                        <td style="padding:5px 6px;">${s.card_set_id ? esc(s.our_set_name) : '<span style="color:var(--warning);">not tied</span>'}</td>
                        <td style="padding:5px 6px; text-align:right;">${s.cards}</td>
                        <td style="padding:5px 6px; text-align:right;">${s.linked_cards}${s.cards ? ` <span style="color:var(--text-secondary);">(${Math.round(100 * s.linked_cards / s.cards)}%)</span>` : ''}</td>
                        <td style="padding:5px 6px;"><button class="btn tcgc-open-set" data-g="${s.group_id}" style="font-size:11px;">See cards</button></td>
                    </tr>`).join('')}</tbody></table></div>`;
            body.querySelector('#tcgc-untied').addEventListener('change', (e) => { S.untiedOnly = e.target.checked; draw(); });
            body.querySelectorAll('.tcgc-open-set').forEach(b => b.addEventListener('click', () => {
                S.group = b.dataset.g; S.q = ''; S.view = 'cards'; paintTabs(); show();
            }));
        };
        draw();
    }

    show();
}
