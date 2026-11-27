// escalate.js
// "Escalate" tab of the Incoming page: orders where our last message to the seller is 3+ days old with no
// reply and the order still has a problem. Each row has a ready email to TCGplayer in Fei's own wording.
// Approve hands it to Grok, who sends it from flyworld2002@hotmail.com with "do messages" (same handshake as
// seller messages). Nothing is sent without that Approve click, and only @tcgplayer.com addresses are allowed.
// SQL: sql/tcg_escalate.sql, sql/tcg_escalate_send.sql. Pipeline: importer/tcg_outbox.py (email_<id>.json).

import { supabase } from './shared.js';
import { callDesktop } from './desktop-api.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : ''; };
const DEFAULT_TO = 'sales@tcgplayer.com';
const TO_OK = /^[^@\s,;]+@tcgplayer\.com$/i;
const getTo = () => { try { return localStorage.getItem('cbmEscalateTo') || DEFAULT_TO; } catch { return DEFAULT_TO; } };
const setTo = (v) => { try { localStorage.setItem('cbmEscalateTo', v); } catch { /* ignore */ } };

// the email, in the wording Fei used before ("Hi TCGplayer team, Sorry to bother. ...")
export function draftEmail(c) {
    const cond = c.cond_items || [], miss = c.short_items || [];
    const items = (list) => list.map(i => `X${i.qty} ${i.name}`).join('\n\n');
    let problem;
    if (cond.length && miss.length) problem = 'some cards are not in the right condition and some were missing from the package';
    else if (cond.length) problem = 'couple cards not in the right condition';
    else if (miss.length) problem = 'some cards were missing from the package';
    else if (c.status === 'not_shipped') problem = `it has not shipped yet (ordered ${fmtDate(c.ordered_on)})`;
    else if (c.status === 'shipped_no_tracking') problem = `it shows shipped but there is no tracking (ordered ${fmtDate(c.ordered_on)})`;
    else if (!c.received_at) problem = `I have not received it (ordered ${fmtDate(c.ordered_on)})`;
    else problem = 'there is a problem with it';
    const lines = [
        'Hi TCGplayer team,',
        '',
        `Sorry to bother. I have this order, ${problem}. Reached out to the seller (${c.seller}) on ${fmtDate(c.our_last_date)} (${c.subject}), and have not heard anything from the seller since, ${c.days_waiting} days. Please help with this.`,
    ];
    if (cond.length) lines.push('damaged card condition involves card below:', '', items(cond));
    if (miss.length) lines.push(...(cond.length ? [''] : []), 'cards missing from the package:', '', items(miss));
    lines.push('', 'Sincerely,', 'Fei');
    return { subject: `${c.order_number} - Issues`, body: lines.join('\n') };
}

const st = { cands: [], emails: [], edits: new Map(), msg: '', busy: false };

async function load() {
    const [c, e] = await Promise.all([
        supabase.from('v_tcg_escalate_candidates').select('*').order('days_waiting', { ascending: false }),
        supabase.from('tcg_escalations').select('*').order('escalated_at', { ascending: false }).limit(60),
    ]);
    if (c.error || e.error) throw new Error((c.error || e.error).message);
    st.cands = c.data || [];
    st.emails = e.data || [];
    for (const cand of st.cands) {
        if (st.edits.has(cand.order_number)) continue;
        const d = st.emails.find(x => x.order_number === cand.order_number && x.kind === 'escalated' && ['draft', 'failed'].includes(x.status));
        st.edits.set(cand.order_number, d
            ? { subject: d.subject, body: d.body, to: d.to_addr, draftId: d.status === 'draft' ? d.id : null, error: d.status === 'failed' ? d.error : null, saved: true }
            : { ...draftEmail(cand), to: getTo(), draftId: null, error: null, saved: false });
    }
}

const OB_LABEL = { approved: 'approved, waiting to be handed to Grok', exported: 'waiting for Grok to send it', sent: 'sent', failed: 'FAILED', unknown: 'no answer from Grok, check your Hotmail Sent folder', draft: 'draft' };
const waited = (r) => r.status === 'exported' && r.exported_at ? Math.floor((Date.now() - new Date(r.exported_at).getTime()) / 3600000) : 0;

const rowHtml = (c) => {
    const e = st.edits.get(c.order_number);
    const chips = [`<span style="color:var(--danger); font-weight:600;">${c.days_waiting} days without a reply</span>`,
        `<span style="color:var(--text-secondary);">${esc(c.subject)}</span>`,
        `<span style="color:var(--text-secondary);">${esc(c.status.replace(/_/g, ' '))}</span>`];
    return `
    <div class="es-row" data-order="${esc(c.order_number)}" style="border:1px solid var(--border); border-radius:8px; padding:8px 12px; margin-bottom:10px;">
        <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap;">
            <strong>${esc(c.seller)}</strong>
            <span style="font-size:12px; color:var(--text-secondary);">${esc(c.order_number)} · ordered ${esc(fmtDate(c.ordered_on))} · $${Number(c.total || 0).toFixed(2)}</span>
            <span style="font-size:12px;">${chips.join(' · ')}</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin:4px 0;">Your last message (${esc(fmtDate(c.our_last_date))}): ${esc((c.our_last_body || '').replace(/\s+/g, ' ').slice(0, 140))}</div>
        ${e.error ? `<div style="font-size:12px; color:var(--danger); margin-bottom:4px;">Last try failed: ${esc(e.error)}</div>` : ''}
        <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:13px; margin-bottom:4px;">
            <label>To <input type="text" class="es-to" value="${esc(e.to || getTo())}" style="width:230px;" /></label>
            <label style="flex:1; min-width:260px;">Subject <input type="text" class="es-subject" value="${esc(e.subject)}" style="width:calc(100% - 60px);" /></label>
        </div>
        <div style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;">Grok sends it from flyworld2002@hotmail.com. Only @tcgplayer.com addresses are allowed.</div>
        <textarea class="es-body" rows="10" style="width:100%; font-family:inherit; font-size:13px;">${esc(e.body)}</textarea>
        <div style="display:flex; gap:8px; align-items:center; margin-top:4px; flex-wrap:wrap;">
            <button class="btn btn-primary es-approve" style="font-size:12px;">Approve &amp; send to Grok</button>
            <button class="btn es-save" style="font-size:12px;">Save draft</button>
            <button class="btn es-copy" style="font-size:12px;">Copy email</button>
            <button class="btn es-skip" style="font-size:12px; margin-left:auto;" title="Hide until you send the seller another message that goes unanswered">Not needed</button>
        </div>
        <div class="es-note" style="font-size:12px; min-height:16px;"></div>
    </div>`;
};

const recentHtml = () => {
    const rows = st.emails.filter(r => r.status !== 'draft' && !(r.kind === 'escalated' && !r.status)).slice(0, 15);
    if (!rows.length) return '';
    return `<h4 style="margin:18px 0 6px;">Recent</h4>${rows.map(r => `
        <div style="font-size:12px; padding:3px 0; border-top:1px solid var(--border);">
            ${r.kind === 'dismissed'
                ? `<span style="color:var(--text-secondary);">not needed</span> · ${esc(r.order_number)}
                   <button class="btn es-undo" data-id="${esc(r.id)}" style="font-size:11px; margin-left:6px;">Bring back</button>`
                : `<span style="color:${r.status === 'sent' ? 'var(--success)' : ['failed', 'unknown'].includes(r.status) ? 'var(--danger)' : 'var(--text-secondary)'};">${esc(OB_LABEL[r.status] || r.status)}</span>
                   · ${esc(r.order_number)} · ${esc(r.to_addr || '')}
                   ${r.sent_at ? `<span style="color:var(--text-secondary);">${esc(new Date(r.sent_at).toLocaleString())}</span>` : ''}
                   ${waited(r) >= 2 ? `<span style="color:var(--danger);"> · no answer from Grok for ${waited(r)} hours</span>` : ''}
                   ${r.error ? `<span style="color:var(--danger);"> · ${esc(r.error)}</span>` : ''}
                   ${['exported', 'unknown'].includes(r.status) ? `<button class="btn es-sent" data-id="${esc(r.id)}" style="font-size:11px; margin-left:6px;" title="Use this when the email is in your Sent folder but Grok did not report back">I checked, it was sent</button>` : ''}
                   ${['approved', 'exported'].includes(r.status) ? `<button class="btn es-withdraw" data-id="${esc(r.id)}" style="font-size:11px; margin-left:6px;" title="Take it back to a draft so you can edit it. Works until Grok has sent it.">Withdraw to edit</button>` : ''}`}
        </div>`).join('')}`;
};

export async function renderEscalate(el, opts = {}) {
    const draw = () => {
        el.innerHTML = `
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 8px;">
            Orders where your last message to the seller got no reply for 3+ days and the order still has a problem
            (a card on hold, a missing card, a refund to review, or it has not arrived). Each row has an email to TCGplayer in your own wording.
            Approve it and tell Grok "do messages": Grok sends it from your Hotmail. Nothing is sent until you approve.</p>
        <div style="font-size:13px; margin-bottom:10px;"><strong>${st.cands.length}</strong> to escalate
            <span id="es-msg" style="font-size:12px; color:var(--text-secondary); margin-left:8px;">${esc(st.msg)}</span></div>
        ${st.cands.length ? st.cands.map(rowHtml).join('') : '<p style="color:var(--text-secondary);">No seller has been silent for 3+ days on an order with a problem.</p>'}
        ${recentHtml()}`;
        wire();
    };
    const refresh = async () => { st.edits = new Map([...st.edits].filter(([, v]) => v.draftId)); await load(); draw(); opts.onChange?.(st.cands.length); };
    const read = (row) => {
        const e = st.edits.get(row.dataset.order);
        e.subject = row.querySelector('.es-subject').value.trim();
        e.body = row.querySelector('.es-body').value;
        e.to = row.querySelector('.es-to').value.trim();
        return e;
    };
    const saveDraft = async (order, e) => {
        const c = st.cands.find(x => x.order_number === order);
        const row = { order_number: order, thread_id: c?.thread_id || null, kind: 'escalated', status: 'draft', to_addr: e.to, subject: e.subject, body: e.body };
        if (e.draftId) {
            const { error } = await supabase.from('tcg_escalations').update(row).eq('id', e.draftId).eq('status', 'draft');
            if (error) throw new Error(error.message);
            return e.draftId;
        }
        const { data, error } = await supabase.from('tcg_escalations').insert(row).select('id').single();
        if (error) throw new Error(error.message);
        e.draftId = data.id;
        return data.id;
    };
    const handToGrok = async () => {
        try {
            const r = await callDesktop('/api/tcg/messages/export');
            return r.summary?.exported ? 'Written for Grok. Tell Grok "do messages" to send it.' : 'Approved.';
        } catch (err) {
            return `Approved, but the desktop could not be reached (${err.message}). It is written for Grok the next time a sync runs.`;
        }
    };
    const wire = () => {
        el.querySelectorAll('.es-row').forEach(row => {
            const order = row.dataset.order;
            const note = (m, color) => { row.querySelector('.es-note').innerHTML = `<span style="color:${color || 'var(--text-secondary)'};">${esc(m)}</span>`; };
            const check = (e) => {
                if (!TO_OK.test(e.to)) return 'The To address must be one address ending in @tcgplayer.com.';
                if (e.subject.length < 3) return 'Add a subject.';
                if (e.body.trim().length < 20) return 'Write the email text.';
                return '';
            };
            row.querySelector('.es-save').addEventListener('click', async () => {
                try { const e = read(row); await saveDraft(order, e); if (TO_OK.test(e.to)) setTo(e.to); note('Draft saved.', 'var(--success)'); } catch (err) { note(err.message, 'var(--danger)'); }
            });
            row.querySelector('.es-copy').addEventListener('click', async () => {
                const e = read(row);
                try { await navigator.clipboard.writeText(`To: ${e.to}\nSubject: ${e.subject}\n\n${e.body}`); note('Copied.', 'var(--success)'); }
                catch { note('Could not copy. Select the text and copy it by hand.', 'var(--danger)'); }
            });
            row.querySelector('.es-skip').addEventListener('click', async () => {
                const c = st.cands.find(x => x.order_number === order);
                const { error } = await supabase.from('tcg_escalations').insert({ order_number: order, thread_id: c?.thread_id || null, kind: 'dismissed' });
                if (error) { note(error.message, 'var(--danger)'); return; }
                if (st.edits.get(order)?.draftId) await supabase.from('tcg_escalations').delete().eq('id', st.edits.get(order).draftId).eq('status', 'draft');
                st.edits.delete(order);
                st.msg = `${c?.seller}: hidden.`;
                await refresh();
            });
            row.querySelector('.es-approve').addEventListener('click', async () => {
                if (st.busy) return;
                const e = read(row);
                const bad = check(e);
                if (bad) { note(bad, 'var(--danger)'); return; }
                st.busy = true;
                row.querySelectorAll('button').forEach(b => { b.disabled = true; });
                try {
                    const id = await saveDraft(order, e);
                    const { error } = await supabase.rpc('tcg_approve_escalation', { p_id: id });
                    if (error) throw new Error(error.message);
                    setTo(e.to);
                    const msg = await handToGrok();
                    st.msg = `${st.cands.find(x => x.order_number === order)?.seller}: ${msg}`;
                    st.edits.delete(order);
                    st.busy = false;
                    await refresh();
                } catch (err) {
                    note(err.message, 'var(--danger)');
                    st.busy = false;
                    row.querySelectorAll('button').forEach(b => { b.disabled = false; });
                }
            });
        });
        const rpc = async (fn, id, confirmText, removeFile) => {
            if (confirmText && !confirm(confirmText)) return;
            const { error } = await supabase.rpc(fn, { p_id: id });
            if (error) { st.msg = error.message; draw(); return; }
            if (removeFile) callDesktop('/api/tcg/messages/export').catch(() => { /* the next sync removes the file */ });
            await refresh();
        };
        el.querySelectorAll('.es-withdraw').forEach(b => b.addEventListener('click', () => rpc('tcg_withdraw_escalation', b.dataset.id, null, true)));
        el.querySelectorAll('.es-sent').forEach(b => b.addEventListener('click', () => rpc('tcg_mark_escalation_sent', b.dataset.id, 'Mark this email as sent? Only do this if you saw it in your Hotmail Sent folder.', true)));
        el.querySelectorAll('.es-undo').forEach(b => b.addEventListener('click', async () => {
            const { error } = await supabase.from('tcg_escalations').delete().eq('id', b.dataset.id).eq('kind', 'dismissed');
            if (error) { st.msg = error.message; draw(); return; }
            await refresh();
        }));
    };
    el.innerHTML = '<p>Loading...</p>';
    try { await load(); } catch (err) { el.innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(err.message)}</p>`; return; }
    draw();
}

export async function countEscalate() {
    const { count } = await supabase.from('v_tcg_escalate_candidates').select('order_number', { count: 'exact', head: true });
    return count ?? 0;
}
