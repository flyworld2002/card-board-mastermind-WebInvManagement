// message-seller.js
// "Message seller": a window that drafts a TCGplayer message to a seller, lets you edit it, and on
// Approve hands it to Grok (through the desktop program) to send. Nothing is sent without that click.
// Plan: Card-Board-MasterMind/docs/plans/tcg-seller-messages.md (Phase 3). SQL: sql/tcg_messages_send.sql.
//
// A message is either a NEW thread (subject from TCGplayer's 8) or a REPLY inside an existing
// thread (11 subjects). The text comes from a template that lists the affected cards with what was
// paid and, only if you tick "Include photo link" and the order has photos, the order's gallery link.
// "Plain reply" is an empty box for ordinary back-and-forth.

import { supabase } from './shared.js';
import { callDesktop } from './desktop-api.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
// "Nov 20, 2026" in every browser (the text goes to a seller, so it must not depend on locale settings)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => {
    if (!d) return '';
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(d);
};

// TCGplayer's subject lists (see the pages Grok saved): the first 8 exist on a new thread, all 11 on a reply.
export const NEW_SUBJECTS = ['Cancellation Request', 'Address or Shipping Change', 'Where Is My Order', 'Condition Issue',
    'Item(s) Missing From Order', 'Received Wrong Item', 'Received Wrong Package', 'Other'];
export const REPLY_SUBJECTS = [...NEW_SUBJECTS, 'General Inquiry', 'Product Missing/Damaged', 'Order Refund'];

const KINDS = [
    ['condition', 'Condition issue', 'Condition Issue'],
    ['missing', 'Missing from the order', 'Item(s) Missing From Order'],
    ['wrong_item', 'Received the wrong item', 'Received Wrong Item'],
    ['where', 'Where is my order', 'Where Is My Order'],
    ['cancel', 'Cancellation request', 'Cancellation Request'],
    ['followup', 'Follow up on my earlier message', null],
    ['plain', 'Plain reply (I write it)', null],
];
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9()]/g, '');
const subjectIn = (list, s) => list.find(x => norm(x) === norm(s));

// ── the text ──────────────────────────────────────────────────────────────────

function cardLine(c) {
    if (c.type === 'short') return `- ${c.name}${c.number ? ` #${c.number}` : ''} x${c.qty} (I paid ${money(c.paid)} each)`;
    if (c.type === 'wrong_item') return `- I ordered ${c.name}${c.number ? ` #${c.number}` : ''}${c.listed ? ` (${c.listed})` : ''}${c.note ? `, but received: ${c.note}` : ', but received a different card'}`;
    return `- ${c.name}${c.number ? ` #${c.number}` : ''} (listed as ${c.listed || 'the condition on the listing'}${c.note ? `; ${c.note}` : ''}; I paid ${money(c.paid)})`;
}

export function buildBody(s) {
    const o = s.order;
    const hi = `Hi ${o.seller || 'there'},`;
    const link = s.includeLink && s.photoLink ? `\nPhotos: ${s.photoLink}\n` : '';
    const cards = s.cards.filter(c => s.selected.has(c.key));
    const sum = cards.reduce((a, c) => a + (c.type === 'short' ? c.paid * c.qty : c.paid), 0);
    switch (s.kind) {
        case 'condition':
            return `${hi}\n\nThank you for order ${o.order_number}. It arrived, but ${cards.length === 1 ? 'this card is' : 'these cards are'} not in the condition listed:\n${cards.map(cardLine).join('\n') || '- (pick the cards above)'}\n${link}\nCould you please refund ${cards.length === 1 ? 'it' : 'them'}${sum ? ` (${money(sum)})` : ''}, or let me know how you would like to handle it? Thank you!`;
        case 'missing':
            return `${hi}\n\nOrder ${o.order_number} has arrived, but ${cards.length === 1 ? 'this card was' : 'these cards were'} not in the package:\n${cards.map(cardLine).join('\n') || '- (pick the cards above)'}\n${link}\nCould you please send ${cards.length === 1 ? 'it' : 'them'} or refund ${sum ? money(sum) : 'the difference'}? Thank you!`;
        case 'wrong_item':
            return `${hi}\n\nOrder ${o.order_number} has arrived, but I received a different card than I ordered:\n${cards.map(cardLine).join('\n') || '- (pick the cards above)'}\n${link}\nCould you please send the correct card, or refund it? Thank you!`;
        case 'where': {
            const st = o.status === 'not_shipped' ? 'It still shows "Shipping Not Confirmed"'
                : o.status === 'shipped_no_tracking' ? 'It shows as shipped, but there is no tracking number'
                : 'The tracking has not updated';
            const est = o.est_delivery ? ` (estimated delivery was ${fmtDate(o.est_delivery)})` : '';
            return `${hi}\n\nI placed order ${o.order_number} on ${fmtDate(o.ordered_on)}. ${st}${est}.\n\nCould you please let me know when it will ship, or send the tracking number? Thank you!`;
        }
        case 'cancel':
            return `${hi}\n\nOrder ${o.order_number} (placed ${fmtDate(o.ordered_on)}) still has not shipped. Could you please cancel it and refund me? Thank you!`;
        case 'followup': {
            const t = s.threads.find(x => String(x.thread_id) === String(s.threadId));
            return `${hi}\n\nJust following up on my earlier message about order ${o.order_number}${t?.last_date ? ` (last message ${fmtDate(t.last_date)})` : ''}.\n${link}\nCould you please let me know where this stands? Thank you!`;
        }
        default:
            return '';
    }
}

// ── the window ────────────────────────────────────────────────────────────────

async function loadContext(orderNumber) {
    const [o, th, held, shortRows, photos, orderPhotos, outbox] = await Promise.all([

        supabase.from('tcg_orders').select('*').eq('order_number', orderNumber).single(),
        supabase.from('tcg_msg_threads').select('*').eq('order_number', orderNumber).order('last_date', { ascending: false }),
        supabase.from('tcg_held_cards').select('*').eq('order_number', orderNumber).eq('status', 'held'),
        supabase.from('tcg_staged_lines').select('*').eq('order_number', orderNumber).gt('short_qty', 0).is('short_resolved_at', null),
        supabase.from('tcg_held_photos').select('id').eq('order_number', orderNumber),
        supabase.from('tcg_order_photos').select('id').eq('order_number', orderNumber).eq('show_to_seller', true).not('public_path', 'is', null),
        supabase.from('tcg_msg_outbox').select('*').eq('order_number', orderNumber).order('created_at', { ascending: false }),
    ]);
    const err = o.error || th.error || held.error || shortRows.error || photos.error || orderPhotos.error || outbox.error;
    if (err) throw new Error(err.message);
    let lines = [];
    const ids = (shortRows.data || []).map(r => r.line_id).filter(Boolean);
    if (ids.length) {
        const r = await supabase.from('tcg_order_lines').select('id, card_name, card_number, unit_price').in('id', ids);
        if (r.error) throw new Error(r.error.message);
        lines = r.data || [];
    }
    const cards = [];
    for (const h of held.data || []) {
        const flags = h.flags || [];
        cards.push({ key: `h:${h.id}`, type: flags.includes('wrong_item') ? 'wrong_item' : 'condition', name: h.card_name, number: h.card_number,
            listed: h.condition_raw, paid: Number(h.unit_cost || 0), note: h.note || '', flags });
    }
    for (const r of shortRows.data || []) {
        const l = lines.find(x => x.id === r.line_id) || {};
        cards.push({ key: `s:${r.staging_id}`, type: 'short', name: l.card_name || 'card', number: l.card_number, qty: r.short_qty,
            paid: Number(l.unit_price || 0), note: r.short_note || '', flags: [] });
    }
    return { order: o.data, threads: th.data || [], cards, photoCount: (photos.data || []).length + (orderPhotos.data || []).length, outbox: outbox.data || [] };
}

function defaultKind(ctx) {
    if (ctx.cards.some(c => c.type === 'short')) return 'missing';
    if (ctx.cards.some(c => c.type === 'wrong_item')) return 'wrong_item';
    if (ctx.cards.some(c => c.type === 'condition')) return 'condition';
    const o = ctx.order;
    if (!o.received_at && o.status !== 'cancelled' && (o.status === 'not_shipped' || o.status === 'shipped_no_tracking')) return 'where';
    return ctx.threads.length ? 'followup' : 'plain';
}

// opts: { orderNumber, kind?, draft?, onDone? }
export async function openMessageSeller(opts) {
    let ctx;
    try { ctx = await loadContext(opts.orderNumber); } catch (e) { alert(`Could not open the message window: ${e.message}`); return; }
    const o = ctx.order;
    const link = ctx.order.gallery_token ? `${location.origin}/gallery.html?t=${ctx.order.gallery_token}` : '';
    const d = opts.draft || null;
    const st = {
        order: o, threads: ctx.threads, cards: ctx.cards, photoLink: link, savedId: d?.id || null,
        kind: d?.kind || opts.kind || defaultKind(ctx),
        mode: d?.mode || 'new', threadId: d?.thread_id || null, subject: d?.subject || '',
        responseNeeded: d ? d.response_needed : true, includeLink: d ? d.include_link : false,
        selected: new Set(), body: d?.body || '', edited: !!d, busy: false,
    };

    // choose reply/new + thread + subject for a kind (only when not editing an existing draft)
    const applyKind = () => {
        const kindRow = KINDS.find(k => k[0] === st.kind);
        const wanted = kindRow?.[2] || null;
        const sameSubject = wanted ? ctx.threads.find(t => norm(t.subject) === norm(wanted)) : null;
        if (st.kind === 'followup' || st.kind === 'plain') {
            st.mode = ctx.threads.length ? 'reply' : 'new';
            st.threadId = ctx.threads[0]?.thread_id ?? null;
            st.subject = ctx.threads[0] ? (subjectIn(REPLY_SUBJECTS, ctx.threads[0].subject) || 'General Inquiry') : 'Other';
        } else if (sameSubject) {
            st.mode = 'reply'; st.threadId = sameSubject.thread_id; st.subject = wanted;
        } else {
            st.mode = 'new'; st.threadId = null; st.subject = wanted;
        }
        // cards that fit the kind start ticked
        st.selected = new Set(ctx.cards.filter(c => (st.kind === 'missing' && c.type === 'short')
            || (st.kind === 'wrong_item' && c.type === 'wrong_item')
            || (st.kind === 'condition' && c.type === 'condition')).map(c => c.key));
        st.includeLink = ctx.photoCount > 0 && st.mode === 'new' && ['condition', 'missing', 'wrong_item'].includes(st.kind);
        st.responseNeeded = true;
    };
    if (!d) applyKind();
    else if (d.kind) st.selected = new Set();   // an existing draft keeps its own text

    const regen = () => { st.body = buildBody(st); st.edited = false; };
    if (!d) regen();

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.65); display:flex; align-items:center; justify-content:center; z-index:1000;';
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && !st.busy) close(); };
    document.addEventListener('keydown', onKey);

    const subjects = () => st.mode === 'reply' ? REPLY_SUBJECTS : NEW_SUBJECTS;

    const draw = () => {
        const cardKinds = ['condition', 'missing', 'wrong_item'].includes(st.kind);
        const shown = ctx.cards.filter(c => st.kind === 'missing' ? c.type === 'short' : st.kind === 'wrong_item' ? c.type === 'wrong_item' : st.kind === 'condition' ? c.type !== 'short' : false);
        const waiting = ctx.outbox.filter(m => ['approved', 'exported'].includes(m.status));
        overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:18px 22px; width:700px; max-width:94vw; max-height:92vh; overflow:auto;">
            <h3 style="margin:0 0 2px;">Message ${esc(o.seller)}</h3>
            <div style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">Order ${esc(o.order_number)} · ordered ${esc(fmtDate(o.ordered_on))}. Nothing is sent until you click Approve.</div>
            ${waiting.length ? `<div style="font-size:12px; color:var(--warning); margin-bottom:8px;">⚠ ${waiting.length} message${waiting.length === 1 ? '' : 's'} for this order ${waiting.length === 1 ? 'is' : 'are'} already waiting for Grok.</div>` : ''}
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
                <label style="font-size:13px;">What is it about
                    <select id="ms-kind" style="margin-left:4px;">${KINDS.map(k => `<option value="${k[0]}" ${st.kind === k[0] ? 'selected' : ''}>${esc(k[1])}</option>`).join('')}</select></label>
            </div>
            <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-bottom:8px; font-size:13px;">
                <label><input type="radio" name="ms-mode" value="reply" ${st.mode === 'reply' ? 'checked' : ''} ${ctx.threads.length ? '' : 'disabled'} /> Reply in an existing thread</label>
                ${st.mode === 'reply' ? `<select id="ms-thread">${ctx.threads.map(t => `<option value="${t.thread_id}" ${String(t.thread_id) === String(st.threadId) ? 'selected' : ''}>${esc(t.subject || 'Thread')} · ${esc(fmtDate(t.last_date))} · ${t.message_count ?? '?'} msg</option>`).join('')}</select>` : ''}
                <label><input type="radio" name="ms-mode" value="new" ${st.mode === 'new' ? 'checked' : ''} /> Start a new thread</label>
            </div>
            <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-bottom:8px; font-size:13px;">
                <label>Subject <select id="ms-subject">${subjects().map(x => `<option ${x === st.subject ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
                <span>Response needed?
                    <label><input type="radio" name="ms-resp" value="yes" ${st.responseNeeded ? 'checked' : ''} /> Yes</label>
                    <label><input type="radio" name="ms-resp" value="no" ${st.responseNeeded ? '' : 'checked'} /> No</label></span>
            </div>
            ${cardKinds ? `
            <div style="border:1px solid var(--border); border-radius:6px; padding:6px 10px; margin-bottom:8px; font-size:13px;">
                <div style="color:var(--text-secondary); font-size:12px; margin-bottom:3px;">Which cards</div>
                ${shown.length ? shown.map(c => `<label style="display:block;"><input type="checkbox" class="ms-card" value="${esc(c.key)}" ${st.selected.has(c.key) ? 'checked' : ''} />
                    ${esc(c.name)}${c.number ? ` #${esc(c.number)}` : ''}${c.type === 'short' ? ` x${c.qty} (short)` : ` (held${c.flags.length ? ': ' + esc(c.flags.join(', ').replace(/_/g, ' ')) : ''})`}
                    <span style="color:var(--text-secondary);"> · paid ${money(c.paid)}${c.note ? ' · ' + esc(c.note) : ''}</span></label>`).join('')
                    : `<span style="color:var(--text-secondary);">No ${st.kind === 'missing' ? 'cards marked Short' : st.kind === 'wrong_item' ? 'held cards with the Wrong item reason' : 'held cards'} on this order yet. Mark them in Staging Review (Short / Hold) first, or write the text yourself below.</span>`}
            </div>` : ''}
            <label style="display:flex; gap:6px; align-items:center; font-size:13px; margin-bottom:8px; ${ctx.photoCount ? '' : 'color:var(--text-secondary);'}">
                <input type="checkbox" id="ms-link" ${st.includeLink && ctx.photoCount ? 'checked' : ''} ${ctx.photoCount ? '' : 'disabled'} />
                Include photo link ${ctx.photoCount ? `(${ctx.photoCount} photo${ctx.photoCount === 1 ? '' : 's'} on this order)` : '(no photos on this order yet, so no link)'}</label>
            <textarea id="ms-body" rows="11" style="width:100%; font-family:inherit; font-size:13px;" placeholder="Write your message here">${esc(st.body)}</textarea>
            <div id="ms-msg" style="font-size:13px; min-height:20px; margin:6px 0;"></div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button class="btn" id="ms-cancel">Close</button>
                <button class="btn" id="ms-save">Save draft</button>
                <button class="btn btn-primary" id="ms-approve">Approve &amp; send to Grok</button>
            </div>
        </div>`;
        wire();
    };

    const keepEdits = () => !st.edited || confirm('You have changed the text. Replace it with a new template text?');
    const rebuild = () => { regen(); draw(); };

    const wire = () => {
        const q = (sel) => overlay.querySelector(sel);
        q('#ms-kind').addEventListener('change', (e) => {
            if (!keepEdits()) { draw(); return; }
            st.kind = e.target.value; applyKind(); rebuild();
        });
        overlay.querySelectorAll('input[name="ms-mode"]').forEach(r => r.addEventListener('change', (e) => {
            st.mode = e.target.value;
            if (st.mode === 'reply') { st.threadId = st.threadId || ctx.threads[0]?.thread_id; const t = ctx.threads.find(x => String(x.thread_id) === String(st.threadId)); if (t && !subjectIn(REPLY_SUBJECTS, st.subject)) st.subject = subjectIn(REPLY_SUBJECTS, t.subject) || 'General Inquiry'; }
            else { st.threadId = null; if (!NEW_SUBJECTS.includes(st.subject)) st.subject = (KINDS.find(k => k[0] === st.kind)?.[2]) || 'Other'; }
            if (!st.edited) regen();
            draw();
        }));
        q('#ms-thread')?.addEventListener('change', (e) => {
            st.threadId = e.target.value;
            const t = ctx.threads.find(x => String(x.thread_id) === String(st.threadId));
            st.subject = subjectIn(REPLY_SUBJECTS, t?.subject) || st.subject;
            if (!st.edited) regen();
            draw();
        });
        q('#ms-subject').addEventListener('change', (e) => { st.subject = e.target.value; });
        overlay.querySelectorAll('input[name="ms-resp"]').forEach(r => r.addEventListener('change', (e) => { st.responseNeeded = e.target.value === 'yes'; }));
        overlay.querySelectorAll('.ms-card').forEach(cb => cb.addEventListener('change', () => {
            if (!keepEdits()) { draw(); return; }
            cb.checked ? st.selected.add(cb.value) : st.selected.delete(cb.value);
            rebuild();
        }));
        q('#ms-link')?.addEventListener('change', (e) => {
            st.includeLink = e.target.checked;
            // add or remove just the link line when the text has not been edited, otherwise leave the text alone
            if (!st.edited) regen();
            draw();
        });
        q('#ms-body').addEventListener('input', (e) => { st.body = e.target.value; st.edited = true; });
        q('#ms-cancel').addEventListener('click', () => { if (!st.busy) close(); });
        q('#ms-save').addEventListener('click', () => save(false));
        q('#ms-approve').addEventListener('click', () => save(true));
    };

    const say = (html, color) => { const m = overlay.querySelector('#ms-msg'); if (m) m.innerHTML = `<span style="color:${color || 'var(--text-secondary)'};">${html}</span>`; };

    const save = async (approve) => {
        if (st.busy) return;
        const body = st.body.trim();
        if (!body) { say('Write the message first.', 'var(--danger)'); return; }
        if (!st.subject) { say('Pick a subject.', 'var(--danger)'); return; }
        if (st.mode === 'reply' && !st.threadId) { say('Pick the thread to reply in.', 'var(--danger)'); return; }
        if (approve && ctx.outbox.some(m => ['approved', 'exported'].includes(m.status))
            && !confirm('A message for this order is already waiting for Grok. Add another one?')) return;
        st.busy = true;
        overlay.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const row = {
            order_number: o.order_number, seller: o.seller, mode: st.mode, thread_id: st.mode === 'reply' ? Number(st.threadId) : null,
            subject: st.subject, response_needed: st.responseNeeded, body, include_link: !!(st.includeLink && ctx.photoCount), kind: st.kind, status: 'draft',
        };
        try {
            if (st.savedId) {
                const { error } = await supabase.from('tcg_msg_outbox').update(row).eq('id', st.savedId).eq('status', 'draft');
                if (error) throw new Error(error.message);
            } else {
                const { data, error } = await supabase.from('tcg_msg_outbox').insert(row).select('id').single();
                if (error) throw new Error(error.message);
                st.savedId = data.id;
            }
            if (!approve) { say('Draft saved.', 'var(--success)'); opts.onDone?.(); setTimeout(close, 700); return; }
            const { data: ap, error: apErr } = await supabase.rpc('tcg_approve_message', { p_id: st.savedId });
            if (apErr) throw new Error(apErr.message);
            let handed = '';
            try {
                const r = await callDesktop('/api/tcg/messages/export');
                handed = r.summary?.exported ? 'It is written for Grok now. Tell Grok "do messages" to send it.' : 'Approved.';
            } catch (e) {
                handed = `Approved, but the desktop could not be reached (${esc(e.message)}). It is written for Grok the next time you click Sync.`;
            }
            say(`✓ ${handed} <span style="color:var(--text-secondary);">(${ap.approved_today} of ${ap.daily_limit} messages approved today)</span>`, 'var(--success)');
            opts.onDone?.();
            overlay.querySelector('#ms-cancel').disabled = false;
            st.busy = false;
            return;
        } catch (e) {
            say(esc(e.message), 'var(--danger)');
        }
        st.busy = false;
        overlay.querySelectorAll('button').forEach(b => { b.disabled = false; });
    };

    draw();
}
