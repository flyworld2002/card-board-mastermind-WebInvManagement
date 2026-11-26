// incoming.js
// Incoming orders: TCGplayer purchases that are on their way, so nothing gets re-bought
// while it is already in the mail. Data comes from the order pages Grok saves each morning;
// the desktop job (Card-Board-MasterMind importer/tcg_orders.py) reads them into tcg_orders*
// (sql/tcg_orders.sql). This page only reads, plus the manual "received" mark.
//
// On order = not received and not cancelled. TCGplayer never shows "Delivered", so an order
// leaves the list when it reaches Staging/Purchases (marked automatically) or you mark it.

import { supabase, formatPrice } from './shared.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATUS_LABEL = {
    not_shipped: 'Shipping not confirmed',
    shipped_no_tracking: 'Shipped, no tracking',
    shipped_tracking: 'Shipped, tracking',
    cancelled: 'Cancelled',
};
const ALERT_TEXT = {
    no_tracking_14d: (d) => `Shipped without tracking ${d} days after the order`,
    not_confirmed_7d: (d) => `Shipping still not confirmed ${d} days after the order`,
    past_estimate: (d) => `${d} day${d === 1 ? '' : 's'} past the estimated delivery date`,
    carrier_delivered: (d) => d === 0 ? 'Delivered today, not marked received yet' : `Delivered ${d} day${d === 1 ? '' : 's'} ago, not marked received yet`,
};
const FILTERS = [
    ['open', 'On order'], ['followups', 'Follow-ups'], ['alerts', 'Needs a look'], ['cancelled', 'Cancelled'],
    ['refunds', 'Refunds'], ['received', 'Received'],
];

const REASON_LABEL = {
    on_order: 'on order', held: 'held cards', short: 'missing cards', refund: 'refund to review',
    active_thread: 'recent messages', awaiting_reply: 'waiting on seller', manual: 'manual',
};

const state = { followups: new Map(), manualFollow: new Map(), threads: new Map(), messages: new Map(), toFix: 0, orders: [], alerts: new Map(), lines: new Map(), files: [], filter: 'open', openOrder: null, seller: '', editTrack: null };

const fmtDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const money = (v) => v == null ? '—' : formatPrice(v);

function ago(iso) {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${Math.max(mins, 0)} min ago`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}

const matchModule = () => import(`./incoming-match.js?v=${Date.now()}`);

// Follow-ups (v_tcg_followups), the manual switch, and seller messages (tcg_msg_threads / tcg_msg_messages).
// Supabase returns at most 1000 rows per request, so read big tables a page at a time.
async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await build().range(from, from + 999);
        if (error) throw new Error(error.message);
        out.push(...data);
        if (data.length < 1000) return out;
    }
}

async function loadMessages() {
    const [fu, manual, threads, msgs] = await Promise.all([
        fetchAll(() => supabase.from('v_tcg_followups').select('*').order('order_number')),
        fetchAll(() => supabase.from('tcg_followups').select('*').order('order_number')),
        fetchAll(() => supabase.from('tcg_msg_threads').select('*').order('last_date', { ascending: false }).order('thread_id')),
        fetchAll(() => supabase.from('tcg_msg_messages').select('id, thread_id, order_number, position, sender, sent_on, body, direction, seen_at')
            .order('thread_id').order('position')),
    ]);
    state.followups = new Map(fu.map(r => [r.order_number, r.reasons || []]));
    state.manualFollow = new Map(manual.map(r => [r.order_number, r]));
    state.threads = new Map();
    for (const t of threads) {
        if (!state.threads.has(t.order_number)) state.threads.set(t.order_number, []);
        state.threads.get(t.order_number).push(t);
    }
    state.messages = new Map();
    for (const m of msgs) {
        if (!state.messages.has(m.thread_id)) state.messages.set(m.thread_id, []);
        state.messages.get(m.thread_id).push(m);
    }
}

// What the seller conversation on an order looks like right now.
function msgInfo(orderNumber) {
    const threads = state.threads.get(orderNumber) || [];
    if (!threads.length) return null;
    let unseen = 0;
    for (const t of threads) unseen += (state.messages.get(t.thread_id) || []).filter(m => m.direction === 'in' && !m.seen_at).length;
    const latest = threads[0];                                   // threads come newest first
    const msgs = state.messages.get(latest.thread_id) || [];
    const last = msgs[msgs.length - 1];
    let turn = '';
    if (last) turn = last.direction === 'out' ? `waiting on seller since ${fmtDate(last.sent_on)}` : `seller replied ${fmtDate(last.sent_on)}`;
    else if (latest.unread_on_tcgplayer) turn = 'unread on TCGplayer, not saved yet';
    return { threads, unseen, turn, unreadOnTcg: threads.some(t => t.unread_on_tcgplayer) };
}

async function load() {
    const [orders, alerts, files] = await Promise.all([
        supabase.from('tcg_orders').select('*').order('ordered_on', { ascending: false }).limit(2000),
        supabase.from('v_tcg_order_alerts').select('*'),
        supabase.from('tcg_order_files').select('kind, grabbed_on, window_days, parsed_at, note').order('parsed_at', { ascending: false }).limit(200),
    ]);
    const err = orders.error || alerts.error || files.error;
    if (err) throw new Error(err.message);
    state.orders = orders.data || [];
    await loadMessages();
    try { state.toFix = await (await matchModule()).countLinesToFix(); } catch { state.toFix = 0; }
    state.files = files.data || [];
    state.alerts = new Map();
    for (const a of alerts.data || []) {
        if (!state.alerts.has(a.order_number)) state.alerts.set(a.order_number, []);
        state.alerts.get(a.order_number).push(a);
    }
}

// "Last pulled" strip. Warns when nothing has come in for 2+ days or Grok reported a failure
// newer than its last success.
function pullInfo() {
    const pages = state.files.find(f => f.kind === 'pages');
    const ok = state.files.filter(f => f.kind === 'grab_ok').sort((a, b) => b.grabbed_on.localeCompare(a.grabbed_on))[0];
    const failed = state.files.filter(f => f.kind === 'run_failed').sort((a, b) => b.grabbed_on.localeCompare(a.grabbed_on))[0];
    const warns = [];
    const lastMs = pages ? new Date(pages.parsed_at).getTime() : 0;
    if (!pages) warns.push('No order pages have been read yet.');
    else if (Date.now() - lastMs > 2 * 86400000) warns.push('No new order pages for over 2 days. Check that Grok is still grabbing.');
    if (failed && (!ok || failed.grabbed_on > ok.grabbed_on)) warns.push(`Grok reported a failed run on ${fmtDate(failed.grabbed_on)}.`);
    return { pages, ok, warns };
}

export async function renderIncoming(container) {
    container.innerHTML = '<h2 style="margin:0 0 4px;">Incoming orders</h2><p>Loading...</p>';
    try { await load(); } catch (e) {
        container.innerHTML = `<h2>Incoming orders</h2><p style="color:var(--danger)">Failed to load: ${esc(e.message)}</p>`;
        return;
    }
    draw(container);
}

const isOpen = (o) => !o.received_at && o.status !== 'cancelled';

function visible() {
    const q = state.seller.trim().toLowerCase();
    return state.orders.filter(o => {
        if (q && !`${o.seller} ${o.order_number} ${o.tracking_number || ''}`.toLowerCase().includes(q)) return false;
        switch (state.filter) {
            case 'open': return isOpen(o);
            case 'followups': return state.followups.has(o.order_number);
            case 'alerts': return isOpen(o) && state.alerts.has(o.order_number);
            case 'cancelled': return o.status === 'cancelled';
            case 'refunds': return Number(o.refund_total) > 0;
            case 'received': return !!o.received_at && o.status !== 'cancelled';
        }
        return true;
    });
}

function draw(container) {
    const open = state.orders.filter(isOpen);
    const flagged = open.filter(o => state.alerts.has(o.order_number));
    const { pages, ok, warns } = pullInfo();
    const trackChecked = state.orders.map(o => o.carrier_checked_at).filter(Boolean).sort().pop() || null;
    const openCards = open.reduce((a, o) => a + (o.quantity || 0), 0);
    const openMoney = open.reduce((a, o) => a + Number(o.total || 0), 0);
    const msgList = state.files.find(f => f.kind === 'msglist');
    const counts = {
        open: open.length, followups: state.orders.filter(o => state.followups.has(o.order_number)).length, alerts: flagged.length,
        cancelled: state.orders.filter(o => o.status === 'cancelled').length,
        refunds: state.orders.filter(o => Number(o.refund_total) > 0).length,
        received: state.orders.filter(o => o.received_at && o.status !== 'cancelled').length,
    };

    container.innerHTML = `
        <h2 style="margin:0 0 4px;">Incoming orders</h2>
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 12px;">
            TCGplayer orders not yet received. TCGplayer never says "Delivered", so an order drops off
            when it reaches Staging/Purchases or when you mark it received here.
        </p>
        <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px; padding:10px 14px; margin-bottom:12px; font-size:13px;">
            <strong>Last pulled:</strong>
            ${pages ? `order pages read ${esc(ago(pages.parsed_at))} (${esc(new Date(pages.parsed_at).toLocaleString())})` : 'never'}
            ${ok ? ` · Grok's last successful grab: ${esc(fmtDate(ok.grabbed_on))}${ok.window_days ? ` (${esc(ok.window_days)})` : ''}` : ''}
            <div style="margin-top:4px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <span><strong>Delivery dates checked:</strong> ${trackChecked ? esc(ago(trackChecked)) + ` (${esc(new Date(trackChecked).toLocaleString())})` : 'never'}</span>
                <button class="btn" id="inc-track" style="font-size:12px;" title="Copies a request you can paste to Claude, who reads each tracking page in your Chrome and updates these dates">Update delivery dates</button>
                <span id="inc-track-msg" style="font-size:12px; color:var(--text-secondary);"></span>
            </div>
            <div style="margin-top:4px;"><strong>Seller messages read:</strong> ${msgList ? esc(ago(msgList.parsed_at)) + ` (${esc(new Date(msgList.parsed_at).toLocaleString())})` : 'never'}
                <span style="color:var(--text-secondary); font-size:12px;"> · read by the daily run for now; the Sync button comes next</span></div>
            ${warns.map(w => `<div style="color:var(--warning); margin-top:4px;">⚠ ${esc(w)}</div>`).join('')}
        </div>
        <div style="display:flex; gap:24px; margin-bottom:12px; font-size:13px;">
            <div><span style="font-size:22px; font-weight:600;">${open.length}</span> orders on the way</div>
            <div><span style="font-size:22px; font-weight:600;">${openCards.toLocaleString()}</span> cards</div>
            <div><span style="font-size:22px; font-weight:600;">${money(openMoney)}</span> spent</div>
            <div style="${flagged.length ? 'color:var(--warning);' : ''}"><span style="font-size:22px; font-weight:600;">${flagged.length}</span> need a look</div>
        </div>
        ${flagged.length ? `
            <div style="border:1px solid var(--warning); border-radius:6px; padding:10px 14px; margin-bottom:14px;">
                <div style="font-weight:600; margin-bottom:6px;">Needs a look</div>
                ${flagged.map(o => `
                    <div style="font-size:13px; padding:4px 0;">
                        <a href="#" class="inc-jump" data-order="${esc(o.order_number)}">${esc(o.seller)}</a>
                        <span style="color:var(--text-secondary);">· ${esc(o.order_number)} · ${esc(fmtDate(o.ordered_on))} · ${money(o.total)}</span>
                        <div style="color:var(--warning); font-size:12px;">${state.alerts.get(o.order_number).map(a => esc(ALERT_TEXT[a.alert_type](a.days))).join(' · ')}</div>
                    </div>`).join('')}
            </div>` : ''}
        <div class="filters-bar" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
            ${FILTERS.map(([k, label]) => `<button class="btn inc-filter" data-f="${k}" style="${state.filter === k ? 'background:var(--accent); color:#fff;' : ''}">${label} (${counts[k]})</button>`).join('')}
            <button class="btn" id="inc-fix" title="Cards on order that are not tied to one exact card of ours yet">Fix card matches${state.toFix ? ` (${state.toFix} lines)` : ''}</button>
            <input type="text" id="inc-search" placeholder="Seller, order or tracking #..." value="${esc(state.seller)}" style="margin-left:auto; min-width:220px;" />
        </div>
        <div id="inc-table"></div>
    `;

    container.querySelectorAll('.inc-filter').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.f; draw(container); }));
    container.querySelector('#inc-track').addEventListener('click', async () => {
        const text = 'Update the delivery dates on my open TCGplayer orders: open each tracking link in my Chrome, read the estimated or delivered date, and load them into the Incoming page.';
        let copied = false;
        try { await navigator.clipboard.writeText(text); copied = true; } catch { /* clipboard blocked */ }
        container.querySelector('#inc-track-msg').textContent = copied
            ? 'Request copied. Paste it to Claude in Claude Code and the dates are updated from the tracking pages.'
            : `Send Claude this: "${text}"`;
    });
    container.querySelector('#inc-fix').addEventListener('click', async () => {
        const m = await matchModule();
        await m.renderMatchFixer(container, () => renderIncoming(container));
    });
    container.querySelector('#inc-search').addEventListener('input', (e) => {
        state.seller = e.target.value;
        drawTable(container);
    });
    container.querySelectorAll('.inc-jump').forEach(a => a.addEventListener('click', (e) => {
        e.preventDefault();
        state.filter = 'alerts'; state.openOrder = a.dataset.order; draw(container);
    }));
    drawTable(container);
}

function drawTable(container) {
    const wrap = container.querySelector('#inc-table');
    const rows = visible();
    if (!rows.length) { wrap.innerHTML = '<p style="color:var(--text-secondary)">Nothing here.</p>'; return; }
    wrap.innerHTML = `
        <table style="width:100%; border-collapse:collapse;">
            <thead><tr>
                <th style="text-align:left;">Ordered</th><th style="text-align:left;">Seller</th><th style="text-align:left;">Status</th>
                <th style="text-align:left;">Estimated delivery</th><th style="text-align:right;">Cards</th>
                <th style="text-align:right;">Total</th><th></th>
            </tr></thead>
            <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>`;
    wrap.querySelectorAll('tr.inc-row').forEach(tr => tr.addEventListener('click', async (e) => {
        if (e.target.closest('button, a, input')) return;
        state.openOrder = state.openOrder === tr.dataset.order ? null : tr.dataset.order;
        drawTable(container);
        if (state.openOrder) await showLines(container, state.openOrder);
    }));
    wrap.querySelectorAll('.inc-track-add').forEach(b => b.addEventListener('click', () => { state.editTrack = b.dataset.order; drawTable(container); container.querySelector('.inc-track-input')?.focus(); }));
    wrap.querySelectorAll('.inc-track-cancel').forEach(b => b.addEventListener('click', () => { state.editTrack = null; drawTable(container); }));
    wrap.querySelectorAll('.inc-track-save').forEach(b => b.addEventListener('click', () => saveTracking(container, b.dataset.order, b.closest('.inc-trackform').querySelector('.inc-track-input').value)));
    wrap.querySelectorAll('.inc-track-input').forEach(i => i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveTracking(container, i.closest('.inc-trackform').querySelector('.inc-track-save').dataset.order, i.value);
        if (e.key === 'Escape') { state.editTrack = null; drawTable(container); }
    }));
    wrap.querySelectorAll('.inc-stage').forEach(b => b.addEventListener('click', () => openInStaging(container, b)));
    wrap.querySelectorAll('.inc-recv').forEach(b => b.addEventListener('click', () => setReceived(container, b.dataset.order, true)));
    wrap.querySelectorAll('.inc-undo').forEach(b => b.addEventListener('click', () => setReceived(container, b.dataset.order, false)));
    if (state.openOrder) showLines(container, state.openOrder);
}

function msgHtml(o) {
    const mi = msgInfo(o.order_number);
    if (!mi) return '';
    const parts = [];
    if (mi.unseen) parts.push(`<span style="color:var(--accent); font-weight:600;">✉ ${mi.unseen} new</span>`);
    else if (mi.unreadOnTcg) parts.push('<span style="color:var(--accent);">✉ unread on TCGplayer</span>');
    else parts.push('✉');
    if (mi.turn && !(mi.unreadOnTcg && !mi.unseen && mi.turn.startsWith('unread on TCGplayer'))) parts.push(esc(mi.turn));
    return `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${parts.join(' · ')}</div>`;
}

function rowHtml(o) {
    const alerts = state.alerts.get(o.order_number) || [];
    const track = o.tracking_url
        ? `<a href="${esc(o.tracking_url)}" target="_blank" rel="noopener">${esc(o.tracking_number)}</a>` : '';
    const trackEdit = o.status === 'cancelled' ? '' : state.editTrack === o.order_number
        ? `<div class="inc-trackform" style="margin-top:3px;">
               <input type="text" class="inc-track-input" value="${esc(o.tracking_number || '')}" placeholder="Tracking number" style="width:190px; font-size:12px;" />
               <button class="btn btn-primary inc-track-save" data-order="${esc(o.order_number)}" style="font-size:11px;">Save</button>
               <button class="btn inc-track-cancel" style="font-size:11px;">Cancel</button>
           </div>`
        : `<div><button class="btn inc-track-add" data-order="${esc(o.order_number)}" style="font-size:11px; padding:1px 8px; margin-top:3px;">${o.tracking_number ? 'Edit tracking #' : 'Add tracking #'}</button></div>`;
    const action = o.status === 'cancelled' ? ''
        : o.received_at
            ? (o.received_by === 'manual'
                ? `<button class="btn inc-stage" data-order="${esc(o.order_number)}" style="font-size:12px;">Open in Staging Review</button>
                   <button class="btn inc-undo" data-order="${esc(o.order_number)}" style="font-size:11px;">Undo received</button>`
                : o.received_by === 'staging'
                    ? `<button class="btn inc-stage" data-order="${esc(o.order_number)}" style="font-size:12px;">Staging Review</button>`
                    : `<span style="font-size:11px; color:var(--text-secondary);">in system</span>`)
            : `<button class="btn btn-primary inc-stage" data-order="${esc(o.order_number)}" style="font-size:12px;">Open in Staging Review</button>
               <button class="btn inc-recv" data-order="${esc(o.order_number)}" style="font-size:12px;">Mark received</button>`;
    const open = state.openOrder === o.order_number;
    return `
        <tr class="inc-row" data-order="${esc(o.order_number)}" style="cursor:pointer;">
            <td style="padding:8px 6px;">${esc(fmtDate(o.ordered_on))}</td>
            <td style="padding:8px 6px;">
                <div style="font-weight:500;">${esc(o.seller)}</div>
                <div style="font-size:11px; color:var(--text-secondary);">${esc(o.order_number)}</div>
                ${msgHtml(o)}
                ${state.filter === 'followups' ? `<div style="margin-top:3px;">${(state.followups.get(o.order_number) || []).map(r =>
                    `<span style="font-size:10px; padding:1px 7px; margin-right:3px; border-radius:9px; border:1px solid var(--border); color:var(--text-secondary);">${esc(REASON_LABEL[r] || r)}</span>`).join('')}</div>` : ''}
            </td>
            <td style="padding:8px 6px;">
                <div>${esc(STATUS_LABEL[o.status])}</div>
                ${track ? `<div style="font-size:11px;">${track}${o.carrier ? ` (${esc(o.carrier)})` : ''}</div>` : ''}
                ${trackEdit}
                ${o.carrier_status && !o.carrier_delivered_on ? `<div style="font-size:11px; color:var(--text-secondary);" title="${esc(o.carrier_summary || '')}">${esc(o.carrier || 'Carrier')}: ${esc(o.carrier_status)}</div>` : ''}
                ${alerts.map(a => `<div style="font-size:11px; color:var(--warning);">⚠ ${esc(ALERT_TEXT[a.alert_type](a.days))}</div>`).join('')}
            </td>
            <td style="padding:8px 6px;">
                ${o.carrier_delivered_on
                    ? `<div style="color:var(--success); font-weight:600;">Delivered ${esc(fmtDate(o.carrier_delivered_on))}</div>
                       <div style="font-size:11px; color:var(--text-secondary);">per ${esc(o.carrier || 'carrier')}${o.received_at ? '' : ' · mark it received once the cards are in hand'}</div>`
                    : o.carrier_est_delivery
                        ? `<div style="font-weight:600;">${esc(o.carrier || 'Carrier')} est. ${esc(fmtDate(o.carrier_est_delivery))}</div>
                           <div style="font-size:11px; color:var(--text-secondary);">TCGplayer est. ${esc(fmtDate(o.est_delivery))}</div>`
                        : `<div>${esc(fmtDate(o.est_delivery))}</div>
                           ${o.tracking_number ? `<div style="font-size:11px; color:var(--text-secondary);" title="${esc(o.carrier_error || '')}">${o.carrier_error ? 'carrier date not available' : 'carrier date not checked yet'}</div>` : ''}`}
            </td>
            <td style="padding:8px 6px; text-align:right;">${o.quantity ?? '—'}</td>
            <td style="padding:8px 6px; text-align:right;">
                ${money(o.total)}
                ${Number(o.refund_total) > 0 ? `<div style="font-size:11px; color:var(--warning);">refunded ${money(o.refund_total)}</div>` : ''}
            </td>
            <td style="padding:8px 6px; text-align:right;">${action}</td>
        </tr>
        ${open ? `<tr id="inc-detail-${esc(o.order_number)}"><td colspan="7" style="padding:0 6px 10px 30px;"><p style="color:var(--text-secondary); font-size:12px;">Loading cards...</p></td></tr>` : ''}`;
}

async function showLines(container, orderNumber) {
    const cell = container.querySelector(`[id="inc-detail-${orderNumber}"] td`);
    if (!cell) return;
    if (!state.lines.has(orderNumber)) {
        const { data, error } = await supabase.from('tcg_order_lines').select('*').eq('order_number', orderNumber).order('line_no');
        if (error) { cell.innerHTML = `<p style="color:var(--danger)">${esc(error.message)}</p>`; return; }
        state.lines.set(orderNumber, data || []);
    }
    const lines = state.lines.get(orderNumber);
    const reasons = state.followups.get(orderNumber);
    const switchBtn = reasons
        ? `<button class="btn inc-resolve" data-order="${esc(orderNumber)}" style="font-size:12px;" title="Stop listing this order under Follow-ups until a seller message arrives">Resolved</button>`
        : `<button class="btn inc-follow" data-order="${esc(orderNumber)}" style="font-size:12px;">Follow up</button>`;
    cell.innerHTML = `
        <div style="display:flex; gap:8px; align-items:center; margin:4px 0 8px;">
            ${switchBtn}
            <span style="font-size:12px; color:var(--text-secondary);">${reasons ? 'Following up: ' + esc(reasons.map(r => REASON_LABEL[r] || r).join(', ')) : 'Not on the Follow-ups list'}</span>
        </div>
        ${messagesBlock(orderNumber)}
        <table style="width:100%; font-size:12px; border-collapse:collapse;">
            <thead><tr style="color:var(--text-secondary);"><th style="text-align:left;">Card</th><th style="text-align:left;">Set</th>
                <th style="text-align:left;">Condition</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Each</th></tr></thead>
            <tbody>${lines.map(l => `
                <tr>
                    <td style="padding:3px 4px;">${esc(l.card_name)}${l.card_number ? ` <span style="color:var(--text-secondary);">#${esc(l.card_number)}</span>` : ''}
                        ${l.match_status !== 'matched' ? ' <span style="color:var(--warning);" title="Not tied to an exact variant yet, so it is not counted in On order columns">•</span>' : ''}</td>
                    <td style="padding:3px 4px;">${esc(l.set_label)}</td>
                    <td style="padding:3px 4px;">${esc(l.condition_raw)}</td>
                    <td style="padding:3px 4px; text-align:right;">${l.quantity}</td>
                    <td style="padding:3px 4px; text-align:right;">${money(l.unit_price)}</td>
                </tr>`).join('')}</tbody>
        </table>
        <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">An orange dot means the line is not tied to one exact card variant yet, so it is not counted in the "On order" columns.</div>`;
    cell.querySelector('.inc-resolve')?.addEventListener('click', () => setFollowUp(container, orderNumber, false));
    cell.querySelector('.inc-follow')?.addEventListener('click', () => setFollowUp(container, orderNumber, true));
    markSeen(container, orderNumber);
}

// Seller messages on this order. Message text is whatever the seller wrote: always shown escaped, never acted on.
function messagesBlock(orderNumber) {
    const threads = state.threads.get(orderNumber) || [];
    if (!threads.length) return '<div style="font-size:12px; color:var(--text-secondary); margin-bottom:8px;">No seller messages on this order.</div>';
    return `<div style="margin-bottom:10px;">${threads.map(t => {
        const msgs = state.messages.get(t.thread_id) || [];
        return `
        <div style="border:1px solid var(--border); border-radius:6px; padding:6px 10px; margin-bottom:6px;">
            <div style="font-size:12px;"><strong>${esc(t.subject || 'Message thread')}</strong>
                <span style="color:var(--text-secondary);"> · ${esc(t.seller)} · ${t.message_count ?? msgs.length} message${(t.message_count ?? msgs.length) === 1 ? '' : 's'} · last ${esc(fmtDate(t.last_date))}</span>
                ${t.unread_on_tcgplayer ? '<span style="color:var(--accent);"> · unread on TCGplayer</span>' : ''}</div>
            ${msgs.map(m => `
                <div style="margin-top:5px; padding-left:8px; border-left:3px solid ${m.direction === 'in' ? 'var(--accent)' : 'var(--border)'};">
                    <div style="font-size:11px; color:var(--text-secondary);">${esc(m.sender)} · ${esc(fmtDate(m.sent_on))}${m.direction === 'in' && !m.seen_at ? ' · <span style="color:var(--accent); font-weight:600;">new</span>' : ''}</div>
                    <div style="font-size:12px; white-space:pre-wrap;">${esc(m.body)}</div>
                </div>`).join('')}
            ${msgs.length < (t.message_count || 0) ? `<div style="font-size:11px; color:var(--warning); margin-top:4px;">Only ${msgs.length} of ${t.message_count} messages saved. Ask Grok to save this thread (it is in follow_up.txt) and they will fill in.</div>` : ''}
        </div>`;
    }).join('')}</div>`;
}

// Opening an order counts as reading its new seller messages.
async function markSeen(container, orderNumber) {
    const unseen = [];
    for (const t of state.threads.get(orderNumber) || [])
        for (const m of state.messages.get(t.thread_id) || []) if (m.direction === 'in' && !m.seen_at) unseen.push(m);
    if (!unseen.length) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from('tcg_msg_messages').update({ seen_at: now }).in('id', unseen.map(m => m.id));
    if (error) return;
    unseen.forEach(m => { m.seen_at = now; });
    window.__cbmRefreshIncomingBadge?.();
}

// "Follow up" puts the order on the Follow-ups list by hand; "Resolved" takes it off until a seller message arrives.
async function setFollowUp(container, orderNumber, on) {
    const row = on ? { order_number: orderNumber, manual: true, resolved_at: null, updated_at: new Date().toISOString() }
                   : { order_number: orderNumber, manual: false, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const { error } = await supabase.from('tcg_followups').upsert(row, { onConflict: 'order_number' });
    if (error) { alert(`Could not save: ${error.message}`); return; }
    await loadMessages();
    draw(container);
}

// Copies the order's cards into Staging Review (once; a second click just opens it again) and
// marks the order received. Then Staging Review opens on that order's batch, where each card can
// be marked Short (did not arrive) or Hold (set aside) before pushing the rest to inventory.
async function openInStaging(container, btn) {
    const o = state.orders.find(x => x.order_number === btn.dataset.order);
    if (!o.received_at && !confirm(`Open ${o.seller}'s order in Staging Review?

Its ${o.quantity ?? ''} cards are added to staging and the order is marked received.`)) return;
    btn.disabled = true;
    const { data, error } = await supabase.rpc('stage_tcg_order', { p_order: o.order_number });
    if (error) { btn.disabled = false; alert(`Could not stage this order: ${error.message}`); return; }
    window.__cbmStagingPreset = { import_batch: data.batch_id };
    window.__cbmRefreshIncomingBadge?.();
    location.hash = '#staging';
}

// Saves a tracking number typed in by hand (e.g. read off the package label). TCGplayer's own page
// may say "no tracking"; the daily job keeps what is saved here. Delivery dates are filled in later
// from the tracking page (the "Update delivery dates" button).
async function saveTracking(container, orderNumber, raw) {
    const n = (raw || '').replace(/[\s-]/g, '').toUpperCase();
    const o = state.orders.find(x => x.order_number === orderNumber);
    const patch = n
        ? { tracking_number: n, tracking_url: `https://tcgp.shipment.co/track/${n}`,
            carrier: n.startsWith('1Z') ? 'UPS' : /^\d{20,34}$/.test(n) ? 'USPS' : null,
            // a different number means the old carrier results no longer apply
            ...(n !== o.tracking_number ? { carrier_status: null, carrier_est_delivery: null, carrier_delivered_on: null, carrier_summary: null, carrier_checked_at: null, carrier_error: null } : {}) }
        : { tracking_number: null, tracking_url: null, carrier: null, carrier_status: null, carrier_est_delivery: null, carrier_delivered_on: null, carrier_summary: null, carrier_checked_at: null, carrier_error: null };
    if (n && !/^[A-Z0-9]{10,40}$/.test(n)) { alert('That does not look like a tracking number (letters and digits, 10 to 40 characters).'); return; }
    const { error } = await supabase.from('tcg_orders').update(patch).eq('order_number', orderNumber);
    if (error) { alert(`Could not save: ${error.message}`); return; }
    Object.assign(o, patch);
    state.editTrack = null;
    draw(container);
}

async function setReceived(container, orderNumber, received) {
    const patch = received
        ? { received_at: new Date().toISOString(), received_by: 'manual' }
        : { received_at: null, received_by: null };
    const { error } = await supabase.from('tcg_orders').update(patch).eq('order_number', orderNumber);
    if (error) { alert(`Could not update: ${error.message}`); return; }
    Object.assign(state.orders.find(o => o.order_number === orderNumber), patch);
    window.__cbmRefreshIncomingBadge?.();
    draw(container);
}
