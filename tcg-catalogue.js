// tcg-catalogue.js
// "TCGplayer catalogue" tab of the Catalog page: the app's copy of TCGplayer's product list (refreshed weekly by
// importer/tcg_catalog.py), with linking. Two views:
//   Cards - search TCGplayer products, see which of our exact card versions each printing is linked to, and
//           Link / Change it (tcg_link_product: remembered as a manual link, order lines + Staging Review follow).
//           "New version..." creates a card version (the same 7 finish fields as Catalog > Our cards) and links it.
//           "New card..." creates the card itself (like Staging Review's Create new card) + its version, and links it.
//   Sets  - which TCGplayer sets are tied to one of our sets; "Tie to our set" (tcg_tie_set) writes the set alias,
//           and the desktop links that set's cards on the next sync (main.py --tcg-catalog-map).
// SQL: sql/tcg_catalog_lookup.sql, sql/tcg_catalog_link.sql.

import { supabase } from './shared.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const PAGE = 50;
const pretty = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const FINISH = { 'Normal': 'non_holo', 'Holofoil': 'holo', 'Reverse Holofoil': 'reverse_holo' };

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
            The app's copy of TCGplayer's product list. "Linked to" shows which of our exact card versions each printing matches;
            order lines find their card through that link. Link or Change a printing here and every order for it follows.</p>
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

    let sets = [];
    const loadSets = async () => {
        const { data, error } = await supabase.from('v_tcg_catalog_sets').select('*').order('name');
        if (error) throw new Error(error.message);
        sets = data || [];
    };
    try { await loadSets(); } catch (err) { container.querySelector('#tcgc-body').innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(err.message)}</p>`; return; }
    const refreshed = sets.map(s => s.synced_at).filter(Boolean).sort().pop();
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
                    ${sets.map(s => `<option value="${s.group_id}" ${String(s.group_id) === String(S.group) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                </select>
                <label style="font-size:13px;"><input type="checkbox" id="tcgc-cards" ${S.cardsOnly ? 'checked' : ''} /> Cards only</label>
                <label style="font-size:13px;"><input type="checkbox" id="tcgc-unlinked" ${S.unlinked ? 'checked' : ''} /> Not linked only</label>
            </div>
            <div id="tcgc-count" style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;"></div>
            <div id="tcgc-msg" style="font-size:12px; margin-bottom:6px;"></div>
            <div id="tcgc-results" style="overflow-x:auto;"></div>
            <div id="tcgc-more" style="text-align:center; margin-top:12px;"></div>`;
        let page = 0, timer = null, seq = 0;
        const byId = new Map();
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
        const linkedCell = (p) => {
            const printings = (p.printings && p.printings.length ? p.printings : ['Normal']).filter(x => FINISH[x]);
            const links = p.links || [];
            return printings.map(pr => {
                const l = links.find(x => x.printing === pr);
                return `<div style="white-space:nowrap; padding:1px 0;"><span style="color:var(--text-secondary);">${esc(pr)}:</span>
                    ${l ? `${esc(l.card || '?')}${l.number ? ` #${esc(l.number)}` : ''} · ${esc(variantLabel(l))}
                           ${l.source === 'order_match' ? '<span style="color:var(--text-secondary);" title="Linked when an order line was matched">(from an order)</span>' : ''}
                           ${l.source === 'manual' ? '<span style="color:var(--text-secondary);" title="Linked by hand">(by you)</span>' : ''}
                           <button class="btn tcgc-link" data-pid="${p.product_id}" data-pr="${esc(pr)}" style="font-size:10px; padding:0 6px;">Change</button>`
                        : `<span style="color:var(--warning);">not linked</span>
                           <button class="btn tcgc-link" data-pid="${p.product_id}" data-pr="${esc(pr)}" style="font-size:10px; padding:0 6px;">Link</button>`}
                </div>`;
            }).join('');
        };
        const rowHtml = (p) => `<tr data-pid="${p.product_id}" style="border-top:1px solid var(--border);">
                <td style="padding:6px;">${p.image_url ? `<img src="${esc(p.image_url)}" loading="lazy" alt="" style="width:40px; border-radius:3px;" />` : ''}</td>
                <td style="padding:6px;">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</td>
                <td style="padding:6px;">${esc(p.set_name)}${p.card_set_id ? '' : ' <span style="color:var(--warning); font-size:11px;" title="This TCGplayer set is not tied to one of our sets">(set not tied)</span>'}</td>
                <td style="padding:6px; white-space:nowrap;">${esc(p.number || '')}</td>
                <td style="padding:6px;">${esc(p.rarity || '')}</td>
                <td style="padding:6px;">${esc((p.printings || []).join(', '))}</td>
                <td style="padding:6px; font-size:12px;">${linkedCell(p)}</td>
            </tr>`;
        const load = async (reset) => {
            const my = ++seq;
            if (reset) { page = 0; byId.clear(); body.querySelector('#tcgc-results').innerHTML = '<p>Loading...</p>'; }
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
            for (const p of data) byId.set(String(p.product_id), p);
            res.querySelector('tbody')?.insertAdjacentHTML('beforeend', data.map(rowHtml).join(''));
            const more = body.querySelector('#tcgc-more');
            more.innerHTML = data.length === PAGE ? '<button class="btn" id="tcgc-load-more">Load more</button>' : '';
            more.querySelector('#tcgc-load-more')?.addEventListener('click', () => { page++; load(false); });
        };

        // The picker (card-link-picker.js, shared with Incoming > Fix card matches): Link / New version / New card
        const openPicker = async (p, printing) => {
            body.querySelectorAll('tr.tcgc-picker').forEach(x => x.remove());
            const tr = body.querySelector(`tr[data-pid="${p.product_id}"]`);
            if (!tr) return;
            tr.insertAdjacentHTML('afterend', '<tr class="tcgc-picker"><td></td><td colspan="6" style="padding:6px 6px 12px;"><div class="tp-host"></div></td></tr>');
            const box = tr.nextElementSibling;
            const { mountCardPicker } = await import(`./card-link-picker.js?v=${Date.now()}`);
            mountCardPicker(box.querySelector('.tp-host'), {
                what: `${p.name} · ${printing}`,
                name: String(p.name).split(' - ')[0].split(' (')[0].trim(), number: p.number,
                ourSetName: p.our_set_name, ourSetId: p.card_set_id, tcgSetName: p.set_name, rarity: p.rarity, imageUrl: p.image_url,
                want: { foil_type: FINISH[printing] },
                onClose: () => box.remove(),
                onLink: async (variantId) => {
                    const { data: rr, error } = await supabase.rpc('tcg_link_product', { p_product_id: p.product_id, p_printing: printing, p_variant_id: variantId });
                    if (error) return error.message;
                    // redraw just this product's row
                    const { data: fresh } = await supabase.from('v_tcg_catalog_lookup').select('*').eq('product_id', p.product_id).single();
                    box.remove();
                    if (fresh) { byId.set(String(p.product_id), fresh); tr.outerHTML = rowHtml(fresh); }
                    body.querySelector('#tcgc-msg').innerHTML = `<span style="color:var(--success);">Linked ${esc(p.name)} · ${esc(printing)}.${rr.lines ? ` ${rr.lines} order line${rr.lines === 1 ? '' : 's'} now matched` : ''}${rr.staging_rows ? `, ${rr.staging_rows} in Staging Review updated` : ''}.</span>`;
                    window.__cbmRefreshIncomingBadge?.();
                    return true;
                },
            });
        };
        body.querySelector('#tcgc-results').addEventListener('click', (e) => {
            const b = e.target.closest('.tcgc-link');
            if (!b) return;
            const p = byId.get(b.dataset.pid);
            if (p) openPicker(p, b.dataset.pr);
        });
        body.querySelector('#tcgc-q').addEventListener('input', (e) => { S.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => load(true), 300); });
        body.querySelector('#tcgc-group').addEventListener('change', (e) => { S.group = e.target.value; load(true); });
        body.querySelector('#tcgc-cards').addEventListener('change', (e) => { S.cardsOnly = e.target.checked; load(true); });
        body.querySelector('#tcgc-unlinked').addEventListener('change', (e) => { S.unlinked = e.target.checked; load(true); });
        load(true);
    }

    // ── Sets ─────────────────────────────────────────────────────────────────
    let ourSets = null, remap = null;
    async function showSets() {
        body.innerHTML = '<p>Loading...</p>';
        if (!ourSets) {
            const { data } = await supabase.from('card_sets').select('id, name, release_year').order('name');
            ourSets = data || [];
        }
        const r = await supabase.from('tcg_catalog_remap').select('*').eq('id', 1).maybeSingle();
        remap = r.data;
        const draw = (msg) => {
            const untied = sets.filter(s => !s.card_set_id);
            const list = sets.filter(s => !S.untiedOnly || !s.card_set_id)
                .sort((a, b) => (!!a.card_set_id - !!b.card_set_id) || (b.cards - a.cards) || a.name.localeCompare(b.name));
            const pending = remap?.requested_at && (!remap.done_at || remap.done_at < remap.requested_at);
            body.innerHTML = `
                <p style="font-size:13px; margin:0 0 6px;"><strong>${untied.length}</strong> of ${sets.length} TCGplayer sets are not tied to one of our sets.
                    Cards in an untied set never match an order line automatically. Many are sets we do not carry; tie the ones we do.</p>
                ${pending ? `<p style="font-size:12px; color:var(--warning); margin:0 0 6px;">A newly tied set's cards get linked on the next sync on the Incoming page (it runs in the background and takes about a minute)${remap.started_at && remap.started_at >= remap.requested_at ? ': linking is running now.' : '.'}</p>`
                          : remap?.done_at ? `<p style="font-size:12px; color:var(--text-secondary); margin:0 0 6px;">Last linking run: ${esc(new Date(remap.done_at).toLocaleString())}.</p>` : ''}
                ${msg ? `<p style="font-size:12px; margin:0 0 6px;">${msg}</p>` : ''}
                <label style="font-size:13px;"><input type="checkbox" id="tcgc-untied" ${S.untiedOnly ? 'checked' : ''} /> Not tied only</label>
                <div style="overflow-x:auto; margin-top:8px;"><table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <thead><tr><th style="text-align:left;">TCGplayer set</th><th style="text-align:left;">Code</th><th style="text-align:left;">Our set</th>
                        <th style="text-align:right;">Cards</th><th style="text-align:right;">Linked</th><th></th></tr></thead>
                    <tbody>${list.map(s => `<tr data-g="${s.group_id}" style="border-top:1px solid var(--border);">
                        <td style="padding:5px 6px;">${esc(s.name)}</td>
                        <td style="padding:5px 6px; color:var(--text-secondary);">${esc(s.abbreviation || '')}</td>
                        <td style="padding:5px 6px;">${s.card_set_id ? esc(s.our_set_name) : '<span style="color:var(--warning);">not tied</span>'}
                            <button class="btn tcgc-tie" data-g="${s.group_id}" style="font-size:10px; padding:0 6px; margin-left:4px;">${s.card_set_id ? 'Change' : 'Tie to our set'}</button></td>
                        <td style="padding:5px 6px; text-align:right;">${s.cards}</td>
                        <td style="padding:5px 6px; text-align:right;">${s.linked_cards}${s.cards ? ` <span style="color:var(--text-secondary);">(${Math.round(100 * s.linked_cards / s.cards)}%)</span>` : ''}</td>
                        <td style="padding:5px 6px;"><button class="btn tcgc-open-set" data-g="${s.group_id}" style="font-size:11px;">See cards</button></td>
                    </tr>`).join('')}</tbody></table></div>`;
            body.querySelector('#tcgc-untied').addEventListener('change', (e) => { S.untiedOnly = e.target.checked; draw(); });
            body.querySelectorAll('.tcgc-open-set').forEach(b => b.addEventListener('click', () => {
                S.group = b.dataset.g; S.q = ''; S.view = 'cards'; paintTabs(); show();
            }));
            body.querySelectorAll('.tcgc-tie').forEach(b => b.addEventListener('click', () => {
                body.querySelectorAll('tr.tcgc-tie-row').forEach(x => x.remove());
                const tr = b.closest('tr');
                const g = sets.find(x => String(x.group_id) === b.dataset.g);
                tr.insertAdjacentHTML('afterend', `<tr class="tcgc-tie-row"><td colspan="6" style="padding:6px 6px 12px;">
                    <div style="border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-size:13px;">
                        Tie TCGplayer set <strong>${esc(g.name)}</strong> to our set:
                        <input class="tt-filter" placeholder="Filter our sets" style="width:180px; margin-left:6px;" />
                        <select class="tt-set" style="max-width:320px;">${ourSets.map(o => `<option value="${o.id}" ${o.id === g.card_set_id ? 'selected' : ''}>${esc(o.name)}${o.release_year ? ` (${o.release_year})` : ''}</option>`).join('')}</select>
                        <button class="btn btn-primary tt-save" style="font-size:12px;">Tie</button>
                        <button class="btn tt-cancel" style="font-size:12px;">Cancel</button>
                    </div></td></tr>`);
                const row = tr.nextElementSibling, sel = row.querySelector('.tt-set');
                row.querySelector('.tt-filter').addEventListener('input', (e) => {
                    const f = e.target.value.trim().toLowerCase();
                    sel.innerHTML = ourSets.filter(o => !f || o.name.toLowerCase().includes(f))
                        .map(o => `<option value="${o.id}">${esc(o.name)}${o.release_year ? ` (${o.release_year})` : ''}</option>`).join('');
                });
                row.querySelector('.tt-cancel').addEventListener('click', () => row.remove());
                row.querySelector('.tt-save').addEventListener('click', async () => {
                    if (!sel.value) return;
                    const { data: rr, error } = await supabase.rpc('tcg_tie_set', { p_group_id: g.group_id, p_set_id: sel.value });
                    if (error) { draw(`<span style="color:var(--danger);">${esc(error.message)}</span>`); return; }
                    await loadSets();
                    const r2 = await supabase.from('tcg_catalog_remap').select('*').eq('id', 1).maybeSingle();
                    remap = r2.data;
                    draw(`<span style="color:var(--success);">Tied ${esc(g.name)} to ${esc(rr.set)}. Its cards get linked on the next sync on the Incoming page.</span>`);
                });
            }));
        };
        draw();
    }

    show();
}
