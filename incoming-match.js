// incoming-match.js
// "Fix card matches": TCGplayer order lines that are not tied to one exact card variant of ours.
// You pick the right card; the link is remembered per TCGplayer product + finish (tcg_products), so
// the same product matches by itself on every later order (sql/tcg_match.sql). Opened from the
// Incoming page.

import { supabase } from './shared.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const st = { tab: 'fix', allOrders: false, groups: [], linked: [], open: null, busy: false };

const LINE_SELECT = '*, tcg_orders!inner(order_number, seller, ordered_on, received_at, status)';

function groupLines(lines) {
    const map = new Map();
    for (const l of lines) {
        const key = l.product_id ? `${l.product_id}|${l.printing}` : l.id;
        if (!map.has(key)) map.set(key, { key, lines: [], qty: 0, orders: new Set() });
        const g = map.get(key);
        g.lines.push(l);
        g.qty += l.quantity || 0;
        g.orders.add(l.tcg_orders.seller);
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
}

async function load() {
    let q = supabase.from('tcg_order_lines').select(LINE_SELECT).neq('match_status', 'matched').neq('tcg_orders.status', 'cancelled').limit(3000);
    if (!st.allOrders) q = q.is('tcg_orders.received_at', null);
    const fix = await q;
    if (fix.error) throw new Error(fix.error.message);
    st.groups = groupLines(fix.data || []);
    const lk = await supabase.from('tcg_order_lines').select(LINE_SELECT).eq('match_source', 'manual').limit(3000);
    if (lk.error) throw new Error(lk.error.message);
    st.linked = groupLines(lk.data || []);
}

export async function countLinesToFix() {
    const { count } = await supabase.from('tcg_order_lines')
        .select('id, tcg_orders!inner(received_at, status)', { count: 'exact', head: true })
        .neq('match_status', 'matched').is('tcg_orders.received_at', null).neq('tcg_orders.status', 'cancelled');
    return count ?? 0;
}

export async function renderMatchFixer(container, onBack) {
    container.innerHTML = '<p>Loading...</p>';
    try { await load(); } catch (e) {
        container.innerHTML = `<p style="color:var(--danger)">Failed to load: ${esc(e.message)}</p>`;
        return;
    }
    draw(container, onBack);
}

function draw(container, onBack) {
    const list = st.tab === 'fix' ? st.groups : st.linked;
    container.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
            <button class="btn" id="mf-back">← Incoming orders</button>
            <h2 style="margin:0;">Fix card matches</h2>
        </div>
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 12px;">
            These TCGplayer cards are not tied to one exact card variant of ours yet, so they are not counted under "On order"
            and arrive in Staging Review as "not found". Pick the right card once and every order with that same TCGplayer product
            (and finish) is fixed, now and in the future.
        </p>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
            <button class="btn mf-tab" data-t="fix" style="${st.tab === 'fix' ? 'background:var(--accent); color:#fff;' : ''}">To fix (${st.groups.length})</button>
            <button class="btn mf-tab" data-t="linked" style="${st.tab === 'linked' ? 'background:var(--accent); color:#fff;' : ''}">Linked by me (${st.linked.length})</button>
            <label style="font-size:12px; color:var(--text-secondary); margin-left:auto;">
                <input type="checkbox" id="mf-all" ${st.allOrders ? 'checked' : ''} /> include orders already received</label>
        </div>
        <div id="mf-list">${list.length ? list.map(g => groupHtml(g)).join('') : '<p style="color:var(--text-secondary);">Nothing here.</p>'}</div>`;

    container.querySelector('#mf-back').addEventListener('click', onBack);
    container.querySelectorAll('.mf-tab').forEach(b => b.addEventListener('click', () => { st.tab = b.dataset.t; st.open = null; draw(container, onBack); }));
    container.querySelector('#mf-all').addEventListener('change', async (e) => { st.allOrders = e.target.checked; await renderMatchFixer(container, onBack); });
    container.querySelectorAll('.mf-row').forEach(r => r.addEventListener('click', (e) => {
        if (e.target.closest('a, button, input')) return;
        st.open = st.open === r.dataset.key ? null : r.dataset.key;
        draw(container, onBack);
    }));
    container.querySelectorAll('.mf-clear').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Undo this link? The cards go back to "to fix".')) return;
        const { error } = await supabase.rpc('tcg_clear_link', { p_line_id: b.dataset.line });
        if (error) { alert(error.message); return; }
        await renderMatchFixer(container, onBack);
    }));
    if (st.open) wireSearch(container, onBack, list.find(g => g.key === st.open));
}

function groupHtml(g) {
    const l = g.lines[0];
    const open = st.open === g.key;
    const link = l.product_id ? `<a href="https://www.tcgplayer.com/product/${l.product_id}" target="_blank" rel="noopener">TCGplayer page</a>` : '<span style="color:var(--text-secondary);">no product id</span>';
    const status = st.tab === 'linked'
        ? '<span style="color:var(--success);">linked by you</span>'
        : l.match_status === 'card_only' ? '<span style="color:var(--warning);">card found, no variant for this finish yet</span>'
        : '<span style="color:var(--danger);">no card found</span>';
    return `
        <div class="mf-row" data-key="${esc(g.key)}" style="border:1px solid var(--border); border-radius:6px; padding:8px 12px; margin-bottom:6px; cursor:pointer;">
            <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap;">
                <strong>${esc(l.card_name)}</strong>${l.card_number ? `<span style="color:var(--text-secondary);">#${esc(l.card_number)}</span>` : ''}
                <span>${esc(l.set_label)}</span>
                <span style="color:var(--text-secondary); font-size:12px;">${esc(l.rarity)} · ${esc(l.condition_raw)}${l.foil_pattern ? ` · ${esc(l.foil_pattern)}` : ''}${l.texture ? ` · ${esc(l.texture)}` : ''}</span>
                <span style="margin-left:auto; font-size:12px;">${g.qty} on ${g.lines.length} line${g.lines.length === 1 ? '' : 's'} · ${link}</span>
            </div>
            <div style="font-size:12px; margin-top:2px;">${status}
                <span style="color:var(--text-secondary);"> · ${esc([...g.orders].slice(0, 3).join(', '))}${g.orders.size > 3 ? '…' : ''}</span>
                ${st.tab === 'linked' ? `<button class="btn mf-clear" data-line="${esc(l.id)}" style="font-size:11px; margin-left:8px;">Undo link</button>` : ''}</div>
            ${open && st.tab === 'fix' ? `
                <div class="mf-search" style="margin-top:8px; border-top:1px solid var(--border); padding-top:8px;">
                    <input type="text" class="mf-name" value="${esc(l.card_name)}" placeholder="Card name" style="width:200px;" />
                    <input type="text" class="mf-num" value="${esc((l.card_number || '').replace(/^0+/, ''))}" placeholder="#" style="width:70px;" />
                    <input type="text" class="mf-set" value="" placeholder="Set (optional)" style="width:170px;" />
                    <button class="btn btn-primary mf-go" type="button">Search</button>
                    <div class="mf-results" style="margin-top:8px; font-size:13px;"></div>
                </div>` : ''}
        </div>`;
}

function variantLabel(r) {
    return [r.foil_label, r.pattern_label, r.texture_label, r.material_label, r.size_label, r.stamp_label, r.source_label].filter(Boolean).join(' · ') || 'Non-Holo';
}

function wireSearch(container, onBack, g) {
    const box = container.querySelector(`.mf-row[data-key="${CSS.escape(st.open)}"] .mf-search`);
    if (!box || !g) return;
    const line = g.lines[0];
    const results = box.querySelector('.mf-results');
    const run = async () => {
        results.textContent = 'Searching...';
        const name = box.querySelector('.mf-name').value.trim();
        const num = box.querySelector('.mf-num').value.trim();
        const set = box.querySelector('.mf-set').value.trim();
        let q = supabase.from('v_card_variants')
            .select('card_id, variant_id, card_name, set_name, card_number, rarity, foil_type, foil_pattern, texture, foil_label, pattern_label, texture_label, material_label, size_label, stamp_label, source_label')
            .order('card_name').order('foil_type').limit(40);
        if (name) q = q.ilike('card_name', `%${name}%`);
        if (num) q = q.eq('card_number', num);
        if (set) q = q.ilike('set_name', `%${set}%`);
        const { data, error } = await q;
        if (error) { results.innerHTML = `<span style="color:var(--danger)">${esc(error.message)}</span>`; return; }
        if (!data.length) { results.textContent = 'No cards found. Try fewer words, or clear the number or set.'; return; }
        // same finish as the TCGplayer line first
        const same = (r) => (r.foil_type || null) === (line.foil_type || null) && (r.foil_pattern || null) === (line.foil_pattern || null) && (r.texture || null) === (line.texture || null);
        data.sort((a, b) => Number(same(b)) - Number(same(a)));
        results.innerHTML = data.map(r => `
            <div style="display:flex; gap:10px; align-items:center; padding:3px 0; ${same(r) ? '' : 'opacity:0.75;'}">
                <span style="min-width:220px;">${esc(r.card_name)} <span style="color:var(--text-secondary);">#${esc(r.card_number)}</span></span>
                <span style="min-width:170px; color:var(--text-secondary);">${esc(r.set_name)}</span>
                <span style="min-width:120px; font-size:12px;">${esc(r.rarity)}</span>
                <span style="min-width:150px; font-size:12px;">${esc(variantLabel(r))}${same(r) ? ' <span style="color:var(--success);">✓ same finish</span>' : ''}</span>
                <button class="btn mf-link" data-v="${esc(r.variant_id)}" style="font-size:12px;">Link</button>
            </div>`).join('');
        results.querySelectorAll('.mf-link').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            const { data: res, error: e2 } = await supabase.rpc('tcg_link_line', { p_line_id: line.id, p_variant_id: b.dataset.v });
            if (e2) { b.disabled = false; alert(e2.message); return; }
            st.open = null;
            await renderMatchFixer(container, onBack);
            window.__cbmRefreshIncomingBadge?.();
            container.insertAdjacentHTML('afterbegin', `<p style="color:var(--success);">Linked: ${res.lines} order line${res.lines === 1 ? '' : 's'} fixed${res.staging_rows ? `, ${res.staging_rows} already in Staging Review updated` : ''}.</p>`);
        }));
    };
    box.querySelector('.mf-go').addEventListener('click', run);
    box.querySelectorAll('input').forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); }));
    run();
}
