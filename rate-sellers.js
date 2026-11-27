// rate-sellers.js
// "Rate sellers" tab of the Incoming page: every order TCGplayer still lets you rate (it shows the
// Rate Transaction button) can be rated here, whatever its status. Each row starts with a suggested
// rating built from what the app knows; you change anything, then Approve. Grok submits it on
// TCGplayer from a file the desktop writes. A rating is public and posted under your name, so nothing
// is sent without your Approve click.
// SQL: sql/tcg_ratings.sql. Pipeline: importer/tcg_outbox.py (rate_<id>.json / rate_result_<id>.json).

import { supabase } from './shared.js';
import { callDesktop } from './desktop-api.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : ''; };
const daysSince = (d) => Math.floor((Date.now() - new Date(String(d).slice(0, 10) + 'T12:00:00').getTime()) / 86400000);
const MAX = 400;
const STATUS_LABEL = { not_shipped: 'not shipped', shipped_no_tracking: 'shipped, no tracking', shipped_tracking: 'shipped', cancelled: 'cancelled' };

// ── the suggestion ────────────────────────────────────────────────────────────
// Your rules: 5 stars when the order is fine or its issues are settled; a lower rating with a
// condition comment when something is wrong and still open; 1-2 for a seller that never ships or
// cancels. The three answers follow the facts; you change any of it.
export function suggest(c) {
    const received = !!c.received_at;
    const late = c.late_days == null ? null : Number(c.late_days);
    const n = Number(c.cond_issue || 0);
    const issues = [];
    let stars = null, comment = '', desc = null, ontime = null, comm = null, why = '';
    const communicated = Number(c.seller_msgs) > 0 ? 'yes' : Number(c.threads) > 0 ? 'no' : 'no_contact';

    if (c.status === 'cancelled') {
        stars = 1; comment = 'Seller cancelled the order without shipping.'; ontime = 'no'; comm = communicated; why = 'cancelled by the seller';
    } else if (!received && c.status === 'not_shipped') {
        const d = daysSince(c.ordered_on);
        stars = d >= 14 ? 1 : d >= 7 ? 2 : null;
        comment = d >= 7 ? `Order has not shipped after ${d} days.` : '';
        ontime = d >= 7 ? 'no' : null; comm = communicated;
        why = d >= 7 ? `not shipped after ${d} days` : 'not shipped yet, too early to judge';
    } else if (!received) {
        why = 'not received yet'; comm = Number(c.threads) > 0 ? communicated : null;
    } else {
        stars = 5; desc = n > 0 ? 'no' : 'yes'; ontime = late != null && late >= 4 ? 'no' : 'yes'; comm = communicated;
        const names = (c.cond_names || '').split(', ').filter(Boolean);
        const open = Number(c.open_held) > 0 || Number(c.open_short) > 0;
        if (n > 0) issues.push(`${n === 1 ? 'a card was' : n + ' cards were'} not in the listed condition${names.length ? ' (' + names.slice(0, 3).join(', ') + ')' : ''}`);
        if (Number(c.short_total) > 0) issues.push(`${Number(c.short_total) === 1 ? 'a card was' : c.short_total + ' cards were'} missing from the package${c.short_names ? ' (' + c.short_names.split(', ').slice(0, 3).join(', ') + ')' : ''}`);
        const slow = late != null && late >= 4;
        // no held/short cards, but a message thread about a problem exists: it was probably handled in messages
        const subj = String(c.issue_subjects || '');
        let threadIssue = '';
        if (!issues.length && subj) {
            const cond = /Condition|Wrong|Damaged/i.test(subj), miss = /Missing/i.test(subj) && !/Damaged/i.test(subj);
            if (cond) desc = 'no';
            threadIssue = cond && miss ? 'a condition problem and a missing card' : cond ? 'a condition problem' : 'a missing card';
            const settled = Number(c.seller_msgs) > 0 && !c.unanswered;
            if (!settled) stars = 4;
            comment = settled ? `Had ${threadIssue}, but the seller handled it. Thank you!`
                              : `Had ${threadIssue} that is still being sorted out. Otherwise well packed.`;
            why = settled ? `a "${subj}" conversation exists and the seller answered: check it is settled` : `a "${subj}" conversation has no seller answer yet`;
        }
        if (threadIssue) {
            // handled above
        } else if (!issues.length) {
            comment = slow ? 'Well packed and as described, but shipping was slower than estimated. Thank you!' : 'Well packed and arrived as described. Thank you!';
            why = slow ? `${late} days later than estimated` : 'no problems';
        } else if (open) {
            stars = 4;
            comment = `Order arrived, but ${issues.join(' and ')}. Otherwise well packed.`;
            why = 'a problem is still open';
        } else {
            comment = `Had an issue (${issues.join(' and ')}), but the seller resolved it. Thank you!`;
            why = 'issues settled';
        }
        if (slow && (issues.length || threadIssue)) comment += ' Shipping was also slower than estimated.';
    }
    comment = comment.replace(/[\r\n<>]+/g, ' ').trim().slice(0, MAX);
    return { stars, comment, desc, ontime, comm, why };
}

// ── data ──────────────────────────────────────────────────────────────────────
const st = { cands: [], outbox: [], edits: new Map(), msg: '', busy: false };

async function load() {
    const [c, o] = await Promise.all([
        supabase.from('v_tcg_rate_candidates').select('*').order('ordered_on', { ascending: false }),
        supabase.from('tcg_rating_outbox').select('*').order('created_at', { ascending: false }).limit(300),
    ]);
    if (c.error || o.error) throw new Error((c.error || o.error).message);
    st.cands = c.data || [];
    st.outbox = o.data || [];
    for (const cand of st.cands) {
        if (st.edits.has(cand.order_number)) continue;
        const draft = st.outbox.find(r => r.order_number === cand.order_number && ['draft', 'failed'].includes(r.status));
        st.edits.set(cand.order_number, draft
            ? { stars: draft.stars, comment: draft.comment, desc: draft.as_described, ontime: draft.arrived_on_time, comm: draft.communication, draftId: draft.status === 'draft' ? draft.id : null, why: draft.status === 'failed' ? 'the last try failed' : 'your saved draft', error: draft.status === 'failed' ? draft.error : null }
            : { ...suggest(cand), draftId: null, error: null });
    }
}

const YN = [['', '—'], ['yes', 'Yes'], ['no', 'No']];
const COMM = [['', '—'], ['yes', 'Yes'], ['no', 'No'], ['no_contact', 'No contact']];
const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${(cur || '') === v ? 'selected' : ''}>${l}</option>`).join('');

function chips(c) {
    const out = [`<span style="color:var(--text-secondary);">${esc(STATUS_LABEL[c.status] || c.status)}${c.received_at ? ', received' : ''}</span>`];
    if (Number(c.cond_issue)) out.push(`<span style="color:var(--warning);">${c.cond_issue} not as listed</span>`);
    if (Number(c.short_total)) out.push(`<span style="color:var(--warning);">${c.short_total} missing${Number(c.open_short) ? ' (open)' : ''}</span>`);
    if (Number(c.open_held)) out.push('<span style="color:var(--warning);">held card open</span>');
    if (Number(c.seller_msgs)) out.push('<span style="color:var(--text-secondary);">seller replied</span>');
    if (c.late_days != null) out.push(`<span style="color:var(--text-secondary);">${Number(c.late_days) > 0 ? c.late_days + ' days late' : Number(c.late_days) < 0 ? Math.abs(c.late_days) + ' days early' : 'on time'}</span>`);
    return out.join(' · ');
}

function rowHtml(c) {
    const e = st.edits.get(c.order_number);
    return `
    <div class="rs-row" data-order="${esc(c.order_number)}" style="border:1px solid var(--border); border-radius:8px; padding:8px 12px; margin-bottom:10px;">
        <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap;">
            <strong>${esc(c.seller)}</strong>
            <span style="font-size:12px; color:var(--text-secondary);">${esc(c.order_number)} · ordered ${esc(fmtDate(c.ordered_on))} · $${Number(c.total || 0).toFixed(2)}</span>
            <span style="font-size:12px;">${chips(c)}</span>
        </div>
        <div style="font-size:11px; color:var(--text-secondary); margin:2px 0 6px;">Suggested because: ${esc(e.why || '')}</div>
        ${e.error ? `<div style="font-size:12px; color:var(--danger); margin-bottom:4px;">Last try failed: ${esc(e.error)}</div>` : ''}
        <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; font-size:13px;">
            <label>Stars <select class="rs-stars"><option value="">pick...</option>${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${e.stars === n ? 'selected' : ''}>${'★'.repeat(n)}${'☆'.repeat(5 - n)} ${n}</option>`).join('')}</select></label>
            <label>As described <select class="rs-desc">${opts(YN, e.desc)}</select></label>
            <label>Arrived when expected <select class="rs-ontime">${opts(YN, e.ontime)}</select></label>
            <label>Communication <select class="rs-comm">${opts(COMM, e.comm)}</select></label>
        </div>
        <textarea class="rs-comment" rows="2" maxlength="${MAX}" style="width:100%; margin-top:6px; font-family:inherit; font-size:13px;" placeholder="Comment (public, max ${MAX} characters, no line breaks)">${esc(e.comment)}</textarea>
        <div style="display:flex; gap:8px; align-items:center; margin-top:4px; flex-wrap:wrap;">
            <span class="rs-count" style="font-size:11px; color:var(--text-secondary);">${(e.comment || '').length} / ${MAX}</span>
            <button class="btn btn-primary rs-approve" style="margin-left:auto; font-size:12px;">Approve &amp; send to Grok</button>
            <button class="btn rs-save" style="font-size:12px;">Save draft</button>
            <button class="btn rs-skip" style="font-size:12px;" title="Hide this order from the list; you can bring it back below">Skip</button>
        </div>
        <div class="rs-note" style="font-size:12px; min-height:16px;"></div>
    </div>`;
}

const OB_LABEL = { approved: 'approved, waiting to be handed to Grok', exported: 'waiting for Grok to submit it', sent: 'rated', failed: 'FAILED', unknown: 'no answer from Grok, check TCGplayer', skipped: 'skipped', draft: 'draft' };

function recentHtml() {
    const rows = st.outbox.filter(r => r.status !== 'draft').slice(0, 15);
    if (!rows.length) return '';
    return `
    <h4 style="margin:18px 0 6px;">Recent ratings</h4>
    ${rows.map(r => `
        <div style="font-size:12px; padding:3px 0; border-top:1px solid var(--border);">
            <strong>${esc(r.seller)}</strong> ${r.stars ? '★'.repeat(r.stars) : ''} ·
            <span style="color:${r.status === 'sent' ? 'var(--success)' : ['failed', 'unknown'].includes(r.status) ? 'var(--danger)' : 'var(--text-secondary)'};">${esc(OB_LABEL[r.status] || r.status)}</span>
            ${r.sent_at ? `<span style="color:var(--text-secondary);">${esc(new Date(r.sent_at).toLocaleString())}</span>` : ''}
            ${r.comment ? `<span style="color:var(--text-secondary);"> · ${esc(r.comment.slice(0, 90))}</span>` : ''}
            ${r.error ? `<span style="color:var(--danger);"> · ${esc(r.error)}</span>` : ''}
            ${r.status === 'skipped' ? `<button class="btn rs-unskip" data-id="${esc(r.id)}" style="font-size:11px; margin-left:6px;">Bring back</button>` : ''}
            ${['approved', 'exported'].includes(r.status) ? `<button class="btn rs-withdraw" data-id="${esc(r.id)}" style="font-size:11px; margin-left:6px;" title="Take it back to a draft so you can edit it. Works until Grok has submitted it.">Withdraw to edit</button>` : ''}
        </div>`).join('')}`;
}

// ── page ──────────────────────────────────────────────────────────────────────
export async function renderRateSellers(el, opts = {}) {
    const draw = () => {
        const clean = st.cands.filter(isClean);
        el.innerHTML = `
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 8px;">
            Orders TCGplayer still lets you rate. Any status works. Each row starts with a suggestion from what the app knows; change anything, then Approve.
            A rating is public and posted under your name, so nothing is sent until you click Approve.</p>
        <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
            <span style="font-size:13px;"><strong>${st.cands.length}</strong> to rate</span>
            ${clean.length ? `<button class="btn" id="rs-all" style="font-size:12px;">Approve all clean 5-star ones (${clean.length})</button>` : ''}
            <span id="rs-msg" style="font-size:12px; color:var(--text-secondary);">${esc(st.msg)}</span>
        </div>
        ${st.cands.length ? st.cands.map(rowHtml).join('') : '<p style="color:var(--text-secondary);">Nothing to rate right now.</p>'}
        ${recentHtml()}`;
        wire();
    };
    const isClean = (c) => {
        const e = st.edits.get(c.order_number);
        return e && e.stars === 5 && c.received_at && !Number(c.cond_issue) && !Number(c.short_total) && !Number(c.open_held)
            && e.comment && e.comment.trim().length >= 3 && !e.draftId;
    };
    const say = (m) => { st.msg = m; const s = el.querySelector('#rs-msg'); if (s) s.textContent = m; };

    const readRow = (row) => {
        const order = row.dataset.order;
        const e = st.edits.get(order);
        e.stars = row.querySelector('.rs-stars').value ? Number(row.querySelector('.rs-stars').value) : null;
        e.desc = row.querySelector('.rs-desc').value || null;
        e.ontime = row.querySelector('.rs-ontime').value || null;
        e.comm = row.querySelector('.rs-comm').value || null;
        e.comment = row.querySelector('.rs-comment').value.replace(/[\r\n]+/g, ' ');
        return e;
    };
    const toRow = (order, e) => {
        const c = st.cands.find(x => x.order_number === order);
        return { order_number: order, seller: c.seller, stars: e.stars, comment: e.comment || '', as_described: e.desc, arrived_on_time: e.ontime, communication: e.comm, status: 'draft' };
    };
    // writes (or updates) the draft row and returns its id
    const saveDraft = async (order, e) => {
        const row = toRow(order, e);
        if (e.draftId) {
            const { error } = await supabase.from('tcg_rating_outbox').update(row).eq('id', e.draftId).eq('status', 'draft');
            if (error) throw new Error(error.message);
            return e.draftId;
        }
        const { data, error } = await supabase.from('tcg_rating_outbox').insert(row).select('id').single();
        if (error) throw new Error(error.message);
        e.draftId = data.id;
        return data.id;
    };
    const handToGrok = async () => {
        try {
            const r = await callDesktop('/api/tcg/messages/export');
            return r.summary?.exported ? 'Written for Grok. Tell Grok "do ratings" to submit.' : 'Approved.';
        } catch (err) {
            return `Approved, but the desktop could not be reached (${err.message}). It is written for Grok the next time you click Sync.`;
        }
    };
    const refresh = async () => { st.edits = new Map([...st.edits].filter(([, v]) => v.draftId)); await load(); draw(); opts.onChange?.(st.cands.length); };

    const wire = () => {
        el.querySelectorAll('.rs-row').forEach(row => {
            const order = row.dataset.order;
            const note = row.querySelector('.rs-note');
            const ta = row.querySelector('.rs-comment');
            ta.addEventListener('input', () => { ta.value = ta.value.replace(/[\r\n]+/g, ' '); row.querySelector('.rs-count').textContent = `${ta.value.length} / ${MAX}`; });
            const flash = (m, color) => { note.innerHTML = `<span style="color:${color || 'var(--text-secondary)'};">${esc(m)}</span>`; };
            row.querySelector('.rs-save').addEventListener('click', async () => {
                try { await saveDraft(order, readRow(row)); flash('Draft saved.', 'var(--success)'); } catch (err) { flash(err.message, 'var(--danger)'); }
            });
            row.querySelector('.rs-skip').addEventListener('click', async () => {
                const c = st.cands.find(x => x.order_number === order);
                const { error } = await supabase.from('tcg_rating_outbox').insert({ order_number: order, seller: c.seller, comment: '', status: 'skipped' });
                if (error) { flash(error.message, 'var(--danger)'); return; }
                if (st.edits.get(order)?.draftId) await supabase.from('tcg_rating_outbox').delete().eq('id', st.edits.get(order).draftId);
                st.edits.delete(order);
                await refresh();
            });
            row.querySelector('.rs-approve').addEventListener('click', async () => {
                if (st.busy) return;
                const e = readRow(row);
                if (!e.stars) { flash('Pick the stars first.', 'var(--danger)'); return; }
                if (!e.comment || e.comment.trim().length < 3) { flash('Write a short comment.', 'var(--danger)'); return; }
                st.busy = true;
                row.querySelectorAll('button').forEach(b => { b.disabled = true; });
                try {
                    const id = await saveDraft(order, e);
                    const { error } = await supabase.rpc('tcg_approve_rating', { p_id: id });
                    if (error) throw new Error(error.message);
                    const msg = await handToGrok();
                    st.edits.delete(order);
                    st.msg = `${st.cands.find(x => x.order_number === order)?.seller}: ${msg}`;
                    st.busy = false;
                    await refresh();
                } catch (err) {
                    flash(err.message, 'var(--danger)');
                    st.busy = false;
                    row.querySelectorAll('button').forEach(b => { b.disabled = false; });
                }
            });
        });
        el.querySelector('#rs-all')?.addEventListener('click', async () => {
            const clean = st.cands.filter(isClean);
            if (!clean.length || st.busy) return;
            if (!confirm(`Approve ${clean.length} five-star rating${clean.length === 1 ? '' : 's'} with the suggested comments?\n\n${clean.map(c => '• ' + c.seller).join('\n')}\n\nThey are posted publicly under your name.`)) return;
            st.busy = true;
            let ok = 0, fail = '';
            for (const c of clean) {
                try {
                    const id = await saveDraft(c.order_number, st.edits.get(c.order_number));
                    const { error } = await supabase.rpc('tcg_approve_rating', { p_id: id });
                    if (error) throw new Error(error.message);
                    st.edits.delete(c.order_number);
                    ok++;
                } catch (err) { fail = `${c.seller}: ${err.message}`; break; }
            }
            st.busy = false;
            st.msg = (ok ? `${ok} approved. ${await handToGrok()}` : '') + (fail ? ` Stopped at ${fail}` : '');
            await refresh();
        });
        el.querySelectorAll('.rs-unskip').forEach(b => b.addEventListener('click', async () => {
            const { error } = await supabase.from('tcg_rating_outbox').delete().eq('id', b.dataset.id).eq('status', 'skipped');
            if (error) { say(error.message); return; }
            await refresh();
        }));
        el.querySelectorAll('.rs-withdraw').forEach(b => b.addEventListener('click', async () => {
            const { error } = await supabase.rpc('tcg_withdraw_rating', { p_id: b.dataset.id });
            if (error) { say(error.message); return; }
            callDesktop('/api/tcg/messages/export').catch(() => { /* the next sync removes the file */ });
            await refresh();
        }));
    };

    el.innerHTML = '<p>Loading...</p>';
    try { await load(); } catch (err) { el.innerHTML = `<p style="color:var(--danger)">Could not load ratings: ${esc(err.message)}</p>`; return; }
    draw();
}

export async function countRateCandidates() {
    const { count } = await supabase.from('v_tcg_rate_candidates').select('order_number', { count: 'exact', head: true });
    return count ?? 0;
}
