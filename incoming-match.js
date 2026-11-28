// incoming-match.js
// "Fix card matches": TCGplayer order lines that are not tied to one exact card variant of ours.
// You pick the right card; the link is remembered per TCGplayer product + finish (tcg_products), so
// the same product matches by itself on every later order (sql/tcg_match.sql). Opened from the
// Incoming page. The card picker (search, Link, New version, New card) is card-link-picker.js, the same one
// the Catalog page's TCGplayer catalogue tab uses.

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
        if (e.target.closest('a, button, input, select, .mf-picker')) return;
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
            ${open && st.tab === 'fix' ? `<div class="mf-picker" style="margin-top:8px; border-top:1px solid var(--border); padding-top:8px; cursor:default;"><p style="font-size:12px;">Loading...</p></div>` : ''}
        </div>`;
}

async function wireSearch(container, onBack, g) {
    const host = container.querySelector(`.mf-row[data-key="${CSS.escape(st.open)}"] .mf-picker`);
    if (!host || !g) return;
    const line = g.lines[0];
    // what the TCGplayer catalogue knows about this product: our tied set, its picture
    let cat = null;
    if (line.product_id) {
        const { data } = await supabase.from('v_tcg_catalog_lookup').select('set_name, card_set_id, our_set_name, image_url, rarity, number').eq('product_id', line.product_id).maybeSingle();
        cat = data;
    }
    const { mountCardPicker, FINISH } = await import(`./card-link-picker.js?v=${Date.now()}`);
    mountCardPicker(host, {
        what: `${line.card_name}${line.card_number ? ` #${line.card_number}` : ''} · ${line.printing || line.condition_raw || ''}`,
        name: line.card_name, number: line.card_number || cat?.number,
        ourSetName: cat?.our_set_name || '', ourSetId: cat?.card_set_id || null,
        tcgSetName: cat?.set_name || line.set_label, rarity: line.rarity || cat?.rarity, imageUrl: cat?.image_url || null,
        want: { foil_type: line.foil_type || FINISH[line.printing] || 'non_holo', foil_pattern: line.foil_pattern, texture: line.texture },
        onClose: () => { st.open = null; draw(container, onBack); },
        onLink: async (variantId) => {
            const { data: res, error } = await supabase.rpc('tcg_link_line', { p_line_id: line.id, p_variant_id: variantId });
            if (error) return error.message;
            st.open = null;
            await renderMatchFixer(container, onBack);
            window.__cbmRefreshIncomingBadge?.();
            container.insertAdjacentHTML('afterbegin', `<p style="color:var(--success);">Linked: ${res.lines} order line${res.lines === 1 ? '' : 's'} fixed${res.staging_rows ? `, ${res.staging_rows} already in Staging Review updated` : ''}.</p>`);
            return true;
        },
    });
}
