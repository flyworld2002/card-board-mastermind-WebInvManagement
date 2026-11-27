// held.js
// Held cards: TCGplayer cards that arrived wrong (condition, error print), are waiting on the seller,
// or are set aside for grading. One record per physical card, flags that stack, photos, and what
// happened to it (sent back / refunded / released into inventory). Also where refunds from TCGplayer
// are assigned to specific cards. Data: sql/tcg_held.sql (+ tcg_stage.sql for how cards get here).
//
// Photos go to the public storage bucket "tcg-held-photos"; the per-order gallery link
// (the neutral gallery site, see gallery-link.js) shows them to the seller without a login. Photos are deleted here
// 90 days after the card is resolved.

import { supabase, formatPrice } from './shared.js';
import { galleryUrl } from './gallery-link.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const REASONS = [
    ['wrong_condition', 'Wrong condition'], ['wrong_item', 'Wrong item'], ['error', 'Error card'],
    ['grading', 'Hold for grading'], ['waiting_seller', 'Waiting on seller'],
];
const REASON_LABEL = { ...Object.fromEntries(REASONS), kept: 'Kept, no refund' };
const KEEP_REASONS = [
    ['damaged', 'Damaged, too poor to sell'], ['lower_condition', 'Lower condition than listed, will sell later'],
    ['wrong_card', 'Wrong card, keeping it'], ['small_value', 'Not worth chasing'], ['other', 'Other (write a note)'],
];
const KEEP_LABEL = Object.fromEntries(KEEP_REASONS);
const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

const BUCKET = 'tcg-held-photos';
const KEEP_DAYS = 90;

const state = { short: [], showShortDone: false, tab: 'held', cards: [], photos: new Map(), orders: new Map(), refunds: [], lines: new Map(), edit: null, msg: '' };

const fmtDate = (d) => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const photoUrl = (path) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

async function purgeExpired() {
    try { await (await import(`./order-photos.js?v=${Date.now()}`)).purgeOldOrderPhotos(); } catch { /* try again next visit */ }
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
    const { data: old } = await supabase.from('tcg_held_cards').select('id').neq('status', 'held').lt('resolved_at', cutoff).limit(500);
    const ids = (old || []).map(r => r.id);
    if (!ids.length) return;
    const { data: ph } = await supabase.from('tcg_held_photos').select('id, path').in('held_id', ids);
    if (!ph?.length) return;
    const { error } = await supabase.storage.from(BUCKET).remove(ph.map(p => p.path));
    if (!error) await supabase.from('tcg_held_photos').delete().in('id', ph.map(p => p.id));
}

async function load() {
    const cardsQ = supabase.from('tcg_held_cards').select('*').order('created_at', { ascending: false }).limit(1000);
    const [cards, photos, refunds, shorts] = await Promise.all([
        cardsQ,
        supabase.from('tcg_held_photos').select('*').order('created_at'),
        supabase.from('v_tcg_refund_review').select('*').order('issued_on', { ascending: false }),
        supabase.from('v_tcg_short_work').select('*').order('ordered_on', { ascending: false }),
    ]);
    const err = cards.error || photos.error || refunds.error || shorts.error;
    if (err) throw new Error(err.message);
    state.short = shorts.data || [];
    state.cards = cards.data || [];
    state.photos = new Map();
    for (const p of photos.data || []) {
        if (!state.photos.has(p.held_id)) state.photos.set(p.held_id, []);
        state.photos.get(p.held_id).push(p);
    }
    state.refunds = refunds.data || [];
    const orderNums = [...new Set([...state.cards.map(c => c.order_number), ...state.refunds.map(r => r.order_number)])];
    state.orders = new Map();
    if (orderNums.length) {
        const { data } = await supabase.from('tcg_orders').select('order_number, seller, ordered_on, gallery_token').in('order_number', orderNums);
        for (const o of data || []) state.orders.set(o.order_number, o);
    }
    // card lines of the orders that have a refund to review ("cards that never arrived" picks one)
    state.lines = new Map();
    const refundOrders = [...new Set(state.refunds.map(r => r.order_number))];
    if (refundOrders.length) {
        const { data } = await supabase.from('tcg_order_lines').select('id, order_number, card_name, quantity, line_no').in('order_number', refundOrders).order('line_no').limit(5000);
        for (const l of data || []) {
            if (!state.lines.has(l.order_number)) state.lines.set(l.order_number, []);
            state.lines.get(l.order_number).push(l);
        }
    }
}

export async function renderHeld(container) {
    container.innerHTML = '<h2 style="margin:0 0 4px;">Held cards</h2><p>Loading...</p>';
    try {
        await purgeExpired();
        await load();
    } catch (e) {
        container.innerHTML = `<h2>Held cards</h2><p style="color:var(--danger)">Failed to load: ${esc(e.message)}</p>`;
        return;
    }
    draw(container);
}

async function reload(container, msg) {
    state.msg = msg || '';
    await load();
    window.__cbmRefreshHeldBadge?.();
    draw(container);
}

function draw(container) {
    const held = state.cards.filter(c => c.status === 'held');
    const grading = state.cards.filter(c => c.status === 'grading');      // set aside for grading: nothing to chase
    const kept = state.cards.filter(c => c.status === 'kept');            // kept without a refund: nothing to chase
    const done = state.cards.filter(c => !['held', 'grading', 'kept'].includes(c.status));
    const list = state.tab === 'held' ? held : state.tab === 'grading' ? grading : state.tab === 'kept' ? kept : state.tab === 'done' ? done : [];
    const byOrder = new Map();
    for (const c of list) {
        if (!byOrder.has(c.order_number)) byOrder.set(c.order_number, []);
        byOrder.get(c.order_number).push(c);
    }
    const tabBtn = (k, label) => `<button class="btn held-tab" data-t="${k}" style="${state.tab === k ? 'background:var(--accent); color:#fff;' : ''}">${label}</button>`;
    container.innerHTML = `
        <h2 style="margin:0 0 4px;">Held cards</h2>
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 12px;">
            Cards set aside from a TCGplayer order: wrong condition, error, hold for grading, waiting on the seller.
            Add photos, then send the seller the order's photo link. Mark each one sent back, refunded, or release it into inventory.
        </p>
        ${state.msg ? `<p style="color:var(--success);">${state.msg}</p>` : ''}
        <div style="display:flex; gap:8px; margin-bottom:12px;">
            ${tabBtn('held', `On hold (${held.length})`)}${tabBtn('grading', `Grading pile (${grading.length})`)}${tabBtn('short', `Missing cards (${state.short.filter(w => w.is_open).length})`)}${tabBtn('kept', `Kept, no refund (${kept.length})`)}${tabBtn('refunds', `Refunds to review (${state.refunds.length})`)}${tabBtn('done', `Resolved (${done.length})`)}
        </div>
        <div id="held-body">${state.tab === 'short' ? shortHtml() : state.tab === 'refunds' ? refundsHtml() : (byOrder.size ? [...byOrder].map(([o, cs]) => orderHtml(o, cs)).join('') : '<p style="color:var(--text-secondary);">Nothing here.</p>')}</div>`;
    container.querySelectorAll('.held-tab').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.t; state.edit = null; draw(container); }));
    wire(container);
}

function orderHtml(orderNumber, cards) {
    const o = state.orders.get(orderNumber) || {};
    return `
        <section style="border:1px solid var(--border); border-radius:8px; padding:10px 14px; margin-bottom:14px;">
            <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:6px;">
                <strong>${esc(o.seller || '')}</strong>
                <span style="color:var(--text-secondary); font-size:12px;">${esc(orderNumber)} · ordered ${esc(fmtDate(o.ordered_on))}</span>
                <button class="btn btn-primary held-msg" data-order="${esc(orderNumber)}" style="font-size:12px; margin-left:auto;" title="Write a message to this seller about these cards (nothing is sent until you approve it)">Message seller</button>
                <button class="btn held-link" data-order="${esc(orderNumber)}" style="font-size:12px;">Copy photo link for seller</button>
            </div>
            <div class="held-order-photos" data-order="${esc(orderNumber)}"></div>
            ${cards.map(cardHtml).join('')}
        </section>`;
}

function cardHtml(c) {
    const photos = state.photos.get(c.id) || [];
    const editing = state.edit === c.id;
    const isHeld = c.status === 'held';
    const inPile = c.status === 'grading';
    const inKept = c.status === 'kept';
    const active = isHeld || inPile || inKept;
    return `
        <div class="held-card" data-id="${esc(c.id)}" style="border-top:1px solid var(--border); padding:8px 0;">
            <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap;">
                <strong>${esc(c.card_name)}</strong>${c.card_number ? `<span style="color:var(--text-secondary);">#${esc(c.card_number)}</span>` : ''}
                <span style="font-size:12px;">${esc(c.set_label)}</span>
                <span style="font-size:12px; color:var(--text-secondary);">${esc(c.condition_raw)}</span>
                <span style="margin-left:auto; font-size:12px;">cost ${formatPrice(c.unit_cost)}${Number(c.refund_amount) > 0 ? ` · refunded ${formatPrice(c.refund_amount)}` : ''}</span>
            </div>
            <div style="margin:4px 0;">
                ${(c.flags || []).map(f => `<span style="font-size:11px; padding:1px 8px; margin-right:4px; border-radius:10px; border:1px solid var(--warning); color:var(--warning);">${esc(REASON_LABEL[f] || f)}</span>`).join('')}
                ${inKept ? `<span style="font-size:11px; padding:1px 8px; border-radius:10px; border:1px solid var(--accent); color:var(--accent);">kept: ${esc(KEEP_LABEL[c.keep_reason] || c.keep_reason || '')}</span>`
                    : inPile ? '<span style="font-size:11px; padding:1px 8px; border-radius:10px; border:1px solid var(--accent); color:var(--accent);">in the grading pile</span>'
                    : c.status !== 'held' ? `<span style="font-size:11px; padding:1px 8px; border-radius:10px; border:1px solid var(--border);">${esc(c.status)} ${esc(fmtDate(c.resolved_at))}</span>` : ''}
                ${c.note ? `<span style="font-size:12px; color:var(--text-secondary);">${esc(c.note)}</span>` : ''}
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                ${photos.map(p => `<a href="${esc(photoUrl(p.path))}" target="_blank" rel="noopener"><img src="${esc(photoUrl(p.path))}" loading="lazy" style="width:56px; height:76px; object-fit:cover; border-radius:4px; border:1px solid var(--border);" /></a>`).join('')}
                ${active ? `<label class="btn" style="font-size:12px; cursor:pointer;">Add photos
                    <input type="file" class="held-photo-input" accept="image/*" multiple style="display:none;" /></label>` : ''}
            </div>
            ${active ? `
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                <button class="btn held-edit" style="font-size:12px;">${inKept ? 'Note' : 'Reasons / note'}</button>
                ${isHeld || inPile ? `<button class="btn held-keep" style="font-size:12px;" title="You will not chase the seller: take it off the work list (it stays out of inventory for now)">Keep it, no refund</button>` : ''}
                ${inKept ? `<button class="btn held-unkeep" style="font-size:12px;">Back to on hold</button>` : ''}
                ${isHeld ? `<button class="btn held-act" data-a="returned" style="font-size:12px;">Sent back</button>
                <button class="btn held-act" data-a="refunded" style="font-size:12px;">Refunded</button>
                <button class="btn held-grade" data-on="1" style="font-size:12px;" title="Set it aside for grading: nothing to chase, it stays out of the On hold list and the follow-ups">To the grading pile</button>` : ''}
                ${inPile ? `<button class="btn held-grade" data-on="0" style="font-size:12px;">Back to on hold</button>` : ''}
                <button class="btn held-act" data-a="release" style="font-size:12px;">Release to inventory</button>
            </div>
            <div class="held-form" style="margin-top:6px;">${editing ? (inKept ? noteOnlyHtml(c) : editHtml(c)) : ''}</div>` : ''}
        </div>`;
}

// ── Missing cards (Short) worklist ─────────────────────────────────────────────
const SHORT_RES = { resent: 'seller is resending it', refunded: 'refund received', dropped: 'dropped, not chasing' };

function shortStatus(w) {
    if (w.short_resolved_at) return [`settled: ${SHORT_RES[w.short_resolution] || w.short_resolution}`, 'var(--text-secondary)'];
    if (Number(w.refunded) >= Number(w.owed) - 0.005) return ['refund received', 'var(--success)'];
    if (w.thread_last_dir === 'in') return [`seller replied ${fmtDate(w.thread_last_date)}`, 'var(--accent)'];
    if (w.message_pending) return ['your message is waiting for Grok', 'var(--warning)'];
    if (w.thread_last_dir === 'out' || w.message_sent_at) return [`waiting on seller since ${fmtDate(w.message_sent_at || w.thread_last_date)}`, 'var(--warning)'];
    return ['not contacted yet', 'var(--danger)'];
}

function shortHtml() {
    const shown = state.short.filter(w => state.showShortDone || w.is_open);
    const byOrder = new Map();
    for (const w of shown) {
        if (!byOrder.has(w.order_number)) byOrder.set(w.order_number, []);
        byOrder.get(w.order_number).push(w);
    }
    const done = state.short.filter(w => !w.is_open).length;
    return `
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 8px;">
            Cards you marked Short (they did not arrive). Each stays here until it is settled: a refund covers it, or you click Resolved.</p>
        <label style="font-size:12px; color:var(--text-secondary);"><input type="checkbox" id="short-show-done" ${state.showShortDone ? 'checked' : ''} /> show settled ones (${done})</label>
        ${byOrder.size ? [...byOrder].map(([order, ws]) => {
            const o = state.orders.get(order) || {};
            const seller = ws[0].seller;
            return `
            <section style="border:1px solid var(--border); border-radius:8px; padding:8px 14px; margin:10px 0;">
                <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap;">
                    <strong>${esc(seller)}</strong>
                    <span style="color:var(--text-secondary); font-size:12px;">${esc(order)} · ordered ${esc(fmtDate(ws[0].ordered_on))}</span>
                    <button class="btn btn-primary short-msg" data-order="${esc(order)}" style="font-size:12px; margin-left:auto;" title="Message the seller about the missing cards (nothing is sent until you approve it)">Message seller</button>
                </div>
                ${ws.map(w => { const [label, color] = shortStatus(w); return `
                <div class="short-row" data-staging="${esc(w.staging_id)}" style="border-top:1px solid var(--border); padding:6px 0; margin-top:6px;">
                    <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap;">
                        <strong>${esc(w.card_name)}</strong>${w.card_number ? `<span style="color:var(--text-secondary);">#${esc(w.card_number)}</span>` : ''}
                        <span style="font-size:12px;">${w.qty} missing · ${formatPrice(w.paid_each)} each (${formatPrice(w.owed)})${Number(w.refunded) > 0 ? ` · refunded ${formatPrice(w.refunded)}` : ''}</span>
                        <span style="font-size:12px; font-weight:600; color:${color};">${esc(label)}</span>
                        ${w.short_note ? `<span style="font-size:12px; color:var(--text-secondary);">${esc(w.short_note)}</span>` : ''}
                    </div>
                    <div style="display:flex; gap:6px; margin-top:4px; flex-wrap:wrap;">
                        ${w.short_resolved_at ? `<button class="btn short-reopen" style="font-size:12px;">Reopen</button>`
                            : `<button class="btn short-resolve" style="font-size:12px;">Resolved</button>`}
                    </div>
                    <div class="short-form" style="margin-top:4px;"></div>
                </div>`; }).join('')}
            </section>`; }).join('') : '<p style="color:var(--text-secondary);">No missing cards waiting on you.</p>'}`;
}

function wireShort(container) {
    container.querySelector('#short-show-done')?.addEventListener('change', (e) => { state.showShortDone = e.target.checked; draw(container); });
    container.querySelectorAll('.short-msg').forEach(b => b.addEventListener('click', async () => {
        const m = await import(`./message-seller.js?v=${Date.now()}`);
        await m.openMessageSeller({ orderNumber: b.dataset.order, kind: 'missing', onDone: () => reload(container) });
    }));
    container.querySelectorAll('.short-row').forEach(row => {
        const id = row.dataset.staging;
        const form = row.querySelector('.short-form');
        row.querySelector('.short-resolve')?.addEventListener('click', () => {
            form.innerHTML = `<select class="short-how">${Object.entries(SHORT_RES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
                <input type="text" class="short-note" placeholder="Note (optional)" style="width:220px; margin-left:6px;" />
                <button class="btn btn-primary short-save" style="margin-left:6px;">Save</button>`;
            form.querySelector('.short-save').addEventListener('click', async () => {
                const { error } = await supabase.rpc('tcg_resolve_short', { p_staging_id: id, p_resolution: form.querySelector('.short-how').value, p_note: form.querySelector('.short-note').value.trim() || null });
                if (error) { alert(error.message); return; }
                await reload(container, 'Settled. It is off the work list.');
            });
        });
        row.querySelector('.short-reopen')?.addEventListener('click', async () => {
            const { error } = await supabase.rpc('tcg_reopen_short', { p_staging_id: id });
            if (error) { alert(error.message); return; }
            await reload(container, 'Reopened.');
        });
    });
}

function noteOnlyHtml(c) {
    return `<input type="text" class="held-note" value="${esc(c.note || '')}" placeholder="Note" style="width:360px;" />
        <button class="btn btn-primary held-save-note" style="margin-left:6px;">Save</button>`;
}

function editHtml(c) {
    return `
        <div style="display:flex; gap:14px; flex-wrap:wrap; margin-bottom:6px;">
            ${REASONS.map(([k, l]) => `<label style="display:flex; gap:4px; align-items:center;"><input type="checkbox" class="held-flag" value="${k}" ${(c.flags || []).includes(k) ? 'checked' : ''} />${l}</label>`).join('')}
        </div>
        <input type="text" class="held-note" value="${esc(c.note || '')}" placeholder="Note" style="width:320px;" />
        <button class="btn btn-primary held-save" style="margin-left:6px;">Save</button>`;
}

function refundsHtml() {
    if (!state.refunds.length) return '<p style="color:var(--text-secondary);">No refunds waiting for a decision.</p>';
    return `
        <p style="color:var(--text-secondary); font-size:13px;">
            TCGplayer refunds that are not fully assigned. Say what each one was for. A refund on an order you already received
            that is spread over the whole order changes what those cards cost, so it is only recorded here for review; it does not change inventory.
        </p>
        <div style="margin-bottom:8px;"><button class="btn" id="held-dismiss-all" style="font-size:12px;">Dismiss all (no action needed)</button></div>
        ${state.refunds.map(r => {
            const o = state.orders.get(r.order_number) || {};
            const heldHere = state.cards.filter(c => c.order_number === r.order_number);
            const lines = state.lines.get(r.order_number) || [];
            return `
            <div class="held-refund" data-order="${esc(r.order_number)}" data-refund="${r.refund_id}" style="border:1px solid var(--border); border-radius:6px; padding:8px 12px; margin-bottom:8px;">
                <div><strong>${esc(o.seller || r.seller)}</strong>
                    <span style="color:var(--text-secondary); font-size:12px;">${esc(r.order_number)} · ${esc(r.kind)} refund ${esc(fmtDate(r.issued_on))} of ${formatPrice(r.amount)}
                    · ${formatPrice(r.remaining)} left · order ${r.received_at ? 'already received' : 'not received yet'}</span></div>
                <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                    <select class="held-r-kind">
                        ${heldHere.length ? '<option value="held">A held card</option>' : ''}
                        <option value="short">Cards that never arrived</option>
                        <option value="order">The whole order (cost review)</option>
                        <option value="none">No action needed</option>
                    </select>
                    <select class="held-r-target" style="max-width:280px;">
                        ${heldHere.map(c => `<option value="${esc(c.id)}" data-k="held">${esc(c.card_name)} (${esc(c.status)})</option>`).join('')}
                        ${lines.map(l => `<option value="${esc(l.id)}" data-k="short" style="display:none;">${esc(l.card_name)} x${l.quantity}</option>`).join('')}
                    </select>
                    <input type="number" class="held-r-amt" step="0.01" min="0.01" value="${Number(r.remaining).toFixed(2)}" style="width:80px;" />
                    <button class="btn btn-primary held-r-go">Assign</button>
                </div>
            </div>`;
        }).join('')}`;
}

function wire(container) {
    wireShort(container);
    container.querySelectorAll('.held-order-photos').forEach(el => {
        import(`./order-photos.js?v=${Date.now()}`).then(m => m.renderOrderPhotos(el, el.dataset.order)).catch(() => {});
    });
    container.querySelectorAll('.held-msg').forEach(b => b.addEventListener('click', async () => {
        const m = await import(`./message-seller.js?v=${Date.now()}`);
        await m.openMessageSeller({ orderNumber: b.dataset.order });
    }));
    container.querySelectorAll('.held-link').forEach(b => b.addEventListener('click', async () => {
        const o = state.orders.get(b.dataset.order);
        const url = galleryUrl(o.gallery_token);
        try { await navigator.clipboard.writeText(url); b.textContent = 'Link copied'; } catch { prompt('Copy this link:', url); }
    }));
    container.querySelectorAll('.held-card').forEach(el => {
        const id = el.dataset.id;
        const card = state.cards.find(c => c.id === id);
        el.querySelector('.held-photo-input')?.addEventListener('change', (e) => uploadPhotos(container, card, [...e.target.files]));
        el.querySelector('.held-edit')?.addEventListener('click', () => { state.edit = state.edit === id ? null : id; draw(container); });
        el.querySelector('.held-save')?.addEventListener('click', async () => {
            const flags = [...el.querySelectorAll('.held-flag:checked')].map(c => c.value);
            if (!flags.length) { alert('Keep at least one reason.'); return; }
            const { error } = await supabase.from('tcg_held_cards').update({ flags, note: el.querySelector('.held-note').value.trim() || null }).eq('id', id);
            if (error) { alert(error.message); return; }
            state.edit = null;
            await reload(container);
        });
        el.querySelectorAll('.held-act').forEach(b => b.addEventListener('click', () => act(container, card, b.dataset.a, el)));
        el.querySelector('.held-save-note')?.addEventListener('click', async () => {
            const { error } = await supabase.from('tcg_held_cards').update({ note: el.querySelector('.held-note').value.trim() || null }).eq('id', id);
            if (error) { alert(error.message); return; }
            state.edit = null;
            await reload(container);
        });
        el.querySelector('.held-keep')?.addEventListener('click', () => keepForm(container, card, el));
        el.querySelector('.held-unkeep')?.addEventListener('click', async () => {
            const { error } = await supabase.rpc('tcg_unkeep_held', { p_held_id: id });
            if (error) { alert(error.message); return; }
            await reload(container, `${esc(card.card_name)} is back on hold.`);
        });
        el.querySelectorAll('.held-grade').forEach(b => b.addEventListener('click', async () => {
            const on = b.dataset.on === '1';
            const { error } = await supabase.rpc('tcg_set_grading', { p_held_id: id, p_on: on });
            if (error) { alert(error.message); return; }
            await reload(container, on ? `${esc(card.card_name)} moved to the grading pile.` : `${esc(card.card_name)} is back on hold.`);
        }));
    });

    // refunds
    container.querySelector('#held-dismiss-all')?.addEventListener('click', async () => {
        if (!confirm(`Mark all ${state.refunds.length} refunds as "no action needed"? They are removed from this list.`)) return;
        for (const r of state.refunds) {
            const { error } = await supabase.rpc('tcg_allocate_refund', { p_order: r.order_number, p_refund_id: r.refund_id, p_kind: 'none', p_amount: Number(r.remaining), p_note: 'dismissed' });
            if (error) { alert(error.message); break; }
        }
        await reload(container, 'Refunds dismissed.');
    });
    container.querySelectorAll('.held-refund').forEach(el => {
        const order = el.dataset.order;
        const kindSel = el.querySelector('.held-r-kind');
        const target = el.querySelector('.held-r-target');
        const syncTargets = () => {
            const k = kindSel.value;
            target.style.display = (k === 'held' || k === 'short') ? '' : 'none';
            [...target.options].forEach(op => { op.style.display = op.dataset.k === k ? '' : 'none'; if (op.dataset.k === k && !target.value) op.selected = true; });
            const first = [...target.options].find(op => op.dataset.k === k);
            if (first) target.value = first.value;
        };
        kindSel.addEventListener('change', syncTargets);
        syncTargets();
        el.querySelector('.held-r-go').addEventListener('click', async () => {
            const k = kindSel.value;
            const args = { p_order: order, p_refund_id: Number(el.dataset.refund), p_kind: k, p_amount: Number(el.querySelector('.held-r-amt').value) };
            if (k === 'held') args.p_held_id = target.value;
            if (k === 'short') args.p_line_id = target.value;
            const { error } = await supabase.rpc('tcg_allocate_refund', args);
            if (error) { alert(error.message); return; }
            await reload(container, 'Refund assigned.');
        });
    });
}

// "Keep it, no refund": you will not chase the seller, so the card leaves the work list. A reason is required.
function keepForm(container, card, el) {
    const form = el.querySelector('.held-form');
    form.innerHTML = `<select class="held-keep-reason"><option value="">Pick a reason...</option>${KEEP_REASONS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
        <input type="text" class="held-keep-note" placeholder="Note (required for Other)" style="width:240px; margin-left:6px;" />
        <button class="btn btn-primary held-keep-go" style="margin-left:6px;">Keep it</button>
        <span class="held-keep-msg" style="font-size:12px; color:var(--danger); margin-left:6px;"></span>`;
    form.querySelector('.held-keep-go').addEventListener('click', async () => {
        const reason = form.querySelector('.held-keep-reason').value;
        const msg = form.querySelector('.held-keep-msg');
        if (!reason) { msg.textContent = 'Pick a reason first.'; return; }
        const { error } = await supabase.rpc('tcg_keep_held', { p_held_id: card.id, p_reason: reason, p_note: form.querySelector('.held-keep-note').value.trim() || null });
        if (error) { msg.textContent = error.message; return; }
        await reload(container, `${esc(card.card_name)} kept without a refund. It is no longer on the work list.`);
    });
}

async function act(container, card, action, el) {
    const form = el.querySelector('.held-form');
    if (action === 'returned') {
        if (!confirm(`Mark ${card.card_name} as sent back to the seller?`)) return;
        const { error } = await supabase.rpc('tcg_resolve_held', { p_held_id: card.id, p_status: 'returned' });
        if (error) { alert(error.message); return; }
        await reload(container, `${esc(card.card_name)} marked sent back.`);
    } else if (action === 'refunded') {
        form.innerHTML = `<label>Refund received for this card $<input type="number" class="held-amt" step="0.01" min="0" value="${Number(card.refund_amount || card.unit_cost || 0).toFixed(2)}" style="width:80px;" /></label>
            <button class="btn btn-primary held-go" style="margin-left:6px;">Mark refunded</button>`;
        form.querySelector('.held-go').addEventListener('click', async () => {
            const { error } = await supabase.rpc('tcg_resolve_held', { p_held_id: card.id, p_status: 'refunded', p_refund: Number(form.querySelector('.held-amt').value) });
            if (error) { alert(error.message); return; }
            await reload(container, `${esc(card.card_name)} marked refunded.`);
        });
    } else if (action === 'release') {
        const suggested = Math.max(Number(card.unit_cost || 0) - Number(card.refund_amount || 0), 0);
        form.innerHTML = `<label>Condition <select class="held-cond">${CONDITIONS.map(x => `<option ${x === (card.condition_raw || '').replace(/ (Reverse )?Holofoil$/i, '') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
            <label style="margin-left:8px;">Cost to carry into inventory $<input type="number" class="held-cost" step="0.01" min="0" value="${suggested.toFixed(2)}" style="width:80px;" /></label>
            <span style="color:var(--text-secondary); font-size:12px; margin-left:6px;">landed cost ${formatPrice(card.unit_cost)}${Number(card.refund_amount) > 0 ? ` minus ${formatPrice(card.refund_amount)} refunded` : ''}</span>
            <button class="btn btn-primary held-go" style="margin-left:6px;">Send to Staging Review</button>`;
        form.querySelector('.held-go').addEventListener('click', async () => {
            const { data, error } = await supabase.rpc('tcg_release_held', { p_held_id: card.id, p_cost: Number(form.querySelector('.held-cost').value), p_condition: form.querySelector('.held-cond').value });
            if (error) { alert(error.message); return; }
            window.__cbmStagingPreset = { import_batch: data.batch_id };
            window.__cbmRefreshHeldBadge?.();
            location.hash = '#staging';
        });
    }
}

// Phone photos are 3-5 MB; shrink to a 1600 px JPEG before uploading.
async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Could not read that image')), 'image/jpeg', 0.82));
}

async function uploadPhotos(container, card, files) {
    if (!files.length) return;
    let ok = 0;
    for (const f of files) {
        try {
            const blob = await shrink(f);
            const path = `${card.order_number}/${card.id}/${Date.now()}-${ok}.jpg`;
            const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
            if (up.error) throw up.error;
            const ins = await supabase.from('tcg_held_photos').insert({ held_id: card.id, order_number: card.order_number, path });
            if (ins.error) throw ins.error;
            ok++;
        } catch (e) {
            alert(`Could not add ${f.name}: ${e.message}`);
        }
    }
    await reload(container, ok ? `${ok} photo${ok === 1 ? '' : 's'} added.` : '');
}
