// escalate.js
// The "Escalate" button on an order's detail (Incoming page): an email to TCGplayer about that order, in Fei's own
// wording, for when a seller does not respond or an order is not resolved. Approve hands it to Grok, who sends it
// from flyworld2002@hotmail.com with "do messages" (same handshake as seller messages). Nothing is sent without
// the Approve click, and only @tcgplayer.com addresses are allowed.
// SQL: sql/tcg_escalate_order.sql (facts), sql/tcg_escalate_send.sql (tcg_escalations + approve/withdraw/mark sent).
// Pipeline: importer/tcg_outbox.py (email_<id>.json / email_result_<id>.json).

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
    let reach;
    if (!c.last_msg_date) reach = ` The seller is ${c.seller}.`;
    else if (c.last_msg_dir === 'out') reach = ` Reached out to the seller (${c.seller}) on ${fmtDate(c.last_msg_date)} (${c.subject}), ${c.days_since >= 2 ? `and have not heard anything from the seller since, ${c.days_since} days.` : 'and have not heard back yet.'}`;
    else reach = ` Reached out to the seller (${c.seller}) about it (${c.subject}); they replied on ${fmtDate(c.last_msg_date)} but it is still not resolved.`;
    const lines = ['Hi TCGplayer team,', '', `Sorry to bother. I have this order, ${problem}.${reach} Please help with this.`];
    if (cond.length) lines.push('damaged card condition involves card below:', '', items(cond));
    if (miss.length) lines.push(...(cond.length ? [''] : []), 'cards missing from the package:', '', items(miss));
    lines.push('', 'Sincerely,', 'Fei');
    return { subject: `${c.order_number} - Issues`, body: lines.join('\n') };
}

const OB_LABEL = { approved: 'approved, waiting to be handed to Grok', exported: 'waiting for Grok to send it', sent: 'sent', failed: 'FAILED', unknown: 'no answer from Grok, check your Hotmail Sent folder', draft: 'draft' };
const waited = (r) => r.status === 'exported' && r.exported_at ? Math.floor((Date.now() - new Date(r.exported_at).getTime()) / 3600000) : 0;
const ACTIVE = ['approved', 'exported', 'sent', 'unknown'];

export async function openEscalateModal(orderNumber, onDone) {
    if (document.getElementById('escalate-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'escalate-modal';
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.65); display:flex; align-items:center; justify-content:center; z-index:900;';
    overlay.innerHTML = `
        <div style="background:var(--bg); border:1px solid var(--border); border-radius:10px; width:min(820px, 96vw); max-height:92vh; display:flex; flex-direction:column;">
            <div style="display:flex; align-items:center; padding:8px 14px; border-bottom:1px solid var(--border);">
                <strong>Escalate to TCGplayer</strong>
                <button class="btn" id="esc-x" style="margin-left:auto;" title="Close (Esc)">✕</button>
            </div>
            <div id="esc-body" style="overflow:auto; padding:12px 18px 18px;"></div>
        </div>`;
    document.body.appendChild(overlay);
    const body = overlay.querySelector('#esc-body');
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', close); onDone?.(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#esc-x').addEventListener('click', close);

    const st = { facts: null, emails: [], edit: null, msg: '', busy: false };

    const load = async () => {
        const [f, e] = await Promise.all([
            supabase.from('v_tcg_escalate_order').select('*').eq('order_number', orderNumber).single(),
            supabase.from('tcg_escalations').select('*').eq('order_number', orderNumber).eq('kind', 'escalated').order('escalated_at', { ascending: false }).limit(10),
        ]);
        if (f.error || e.error) throw new Error((f.error || e.error).message);
        st.facts = f.data;
        st.emails = e.data || [];
        if (!st.edit) {
            const d = st.emails.find(x => ['draft', 'failed'].includes(x.status));
            st.edit = d ? { subject: d.subject, body: d.body, to: d.to_addr, draftId: d.status === 'draft' ? d.id : null, error: d.status === 'failed' ? d.error : null }
                        : { ...draftEmail(st.facts), to: getTo(), draftId: null, error: null };
        }
    };

    const draw = () => {
        const c = st.facts, e = st.edit;
        const active = st.emails.find(x => ACTIVE.includes(x.status) && Date.now() - new Date(x.approved_at || x.escalated_at).getTime() < 7 * 86400000);
        const facts = [`<strong>${esc(c.seller)}</strong>`, `<span style="color:var(--text-secondary);">${esc(c.order_number)} · ordered ${esc(fmtDate(c.ordered_on))} · $${Number(c.total || 0).toFixed(2)} · ${esc(String(c.status).replace(/_/g, ' '))}</span>`];
        const convo = c.last_msg_date
            ? `<div style="font-size:12px; color:var(--text-secondary); margin:4px 0 8px;">${c.last_msg_dir === 'out' ? `Your last message (${esc(fmtDate(c.last_msg_date))}, ${c.days_since} days ago, ${esc(c.subject)}) has no reply` : `The seller replied ${esc(fmtDate(c.last_msg_date))} (${esc(c.subject)})`}: ${esc((c.last_msg_body || '').replace(/\s+/g, ' ').slice(0, 140))}</div>`
            : '<div style="font-size:12px; color:var(--text-secondary); margin:4px 0 8px;">No messages with this seller yet.</div>';
        const history = st.emails.filter(x => x.status !== 'draft').map(r => `
            <div style="font-size:12px; padding:3px 0; border-top:1px solid var(--border);">
                <span style="color:${r.status === 'sent' ? 'var(--success)' : ['failed', 'unknown'].includes(r.status) ? 'var(--danger)' : 'var(--text-secondary)'}; font-weight:600;">${esc(OB_LABEL[r.status] || r.status)}</span>
                · ${esc(r.to_addr || '')} ${r.sent_at ? `<span style="color:var(--text-secondary);">${esc(new Date(r.sent_at).toLocaleString())}</span>` : ''}
                ${waited(r) >= 2 ? `<span style="color:var(--danger);"> · no answer from Grok for ${waited(r)} hours</span>` : ''}
                ${r.error ? `<span style="color:var(--danger);"> · ${esc(r.error)}</span>` : ''}
                ${['exported', 'unknown'].includes(r.status) ? `<button class="btn es-sent" data-id="${esc(r.id)}" style="font-size:11px; margin-left:6px;" title="Use this when the email is in your Sent folder but Grok did not report back">I checked, it was sent</button>` : ''}
                ${['approved', 'exported'].includes(r.status) ? `<button class="btn es-withdraw" data-id="${esc(r.id)}" style="font-size:11px; margin-left:6px;" title="Take it back to a draft so you can edit it. Works until Grok has sent it.">Withdraw to edit</button>` : ''}
            </div>`).join('');
        const form = active ? `<p style="color:var(--text-secondary); font-size:13px;">An email about this order is already ${esc(OB_LABEL[active.status] || active.status)}. A new one can be written 7 days after it was approved.</p>` : `
            ${e.error ? `<div style="font-size:12px; color:var(--danger); margin-bottom:4px;">Last try failed: ${esc(e.error)}</div>` : ''}
            <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:13px; margin-bottom:4px;">
                <label>To <input type="text" id="es-to" value="${esc(e.to || getTo())}" style="width:230px;" /></label>
                <label style="flex:1; min-width:260px;">Subject <input type="text" id="es-subject" value="${esc(e.subject)}" style="width:calc(100% - 60px);" /></label>
            </div>
            <div style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;">Grok sends it from flyworld2002@hotmail.com when you say "do messages". Only @tcgplayer.com addresses are allowed. Nothing is sent until you approve.</div>
            <textarea id="es-body" rows="12" style="width:100%; font-family:inherit; font-size:13px;">${esc(e.body)}</textarea>
            <div style="display:flex; gap:8px; align-items:center; margin-top:4px; flex-wrap:wrap;">
                <button class="btn btn-primary" id="es-approve" style="font-size:12px;">Approve &amp; send to Grok</button>
                <button class="btn" id="es-save" style="font-size:12px;">Save draft</button>
                <button class="btn" id="es-copy" style="font-size:12px;">Copy email</button>
            </div>
            <div id="es-note" style="font-size:12px; min-height:16px;"></div>`;
        body.innerHTML = `
            <div style="display:flex; gap:12px; align-items:baseline; flex-wrap:wrap;">${facts.join('')}</div>
            ${convo}
            ${st.msg ? `<div style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;">${esc(st.msg)}</div>` : ''}
            ${form}
            ${history ? `<h4 style="margin:14px 0 4px;">Emails about this order</h4>${history}` : ''}`;
        wire(active);
    };

    const refresh = async () => { await load(); draw(); };
    const rpc = async (fn, id, confirmText) => {
        if (confirmText && !confirm(confirmText)) return;
        const { error } = await supabase.rpc(fn, { p_id: id });
        if (error) { st.msg = error.message; draw(); return; }
        callDesktop('/api/tcg/messages/export').catch(() => { /* the next sync removes the file */ });
        st.edit = null;
        await refresh();
    };

    const wire = (active) => {
        body.querySelectorAll('.es-withdraw').forEach(b => b.addEventListener('click', () => rpc('tcg_withdraw_escalation', b.dataset.id)));
        body.querySelectorAll('.es-sent').forEach(b => b.addEventListener('click', () => rpc('tcg_mark_escalation_sent', b.dataset.id, 'Mark this email as sent? Only do this if you saw it in your Hotmail Sent folder.')));
        if (active) return;
        const note = (m, color) => { body.querySelector('#es-note').innerHTML = `<span style="color:${color || 'var(--text-secondary)'};">${esc(m)}</span>`; };
        const read = () => {
            st.edit.to = body.querySelector('#es-to').value.trim();
            st.edit.subject = body.querySelector('#es-subject').value.trim();
            st.edit.body = body.querySelector('#es-body').value;
            return st.edit;
        };
        const saveDraft = async (e) => {
            const row = { order_number: orderNumber, thread_id: st.facts.thread_id || null, kind: 'escalated', status: 'draft', to_addr: e.to, subject: e.subject, body: e.body };
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
        body.querySelector('#es-save').addEventListener('click', async () => {
            try { const e = read(); await saveDraft(e); if (TO_OK.test(e.to)) setTo(e.to); note('Draft saved.', 'var(--success)'); } catch (err) { note(err.message, 'var(--danger)'); }
        });
        body.querySelector('#es-copy').addEventListener('click', async () => {
            const e = read();
            try { await navigator.clipboard.writeText(`To: ${e.to}\nSubject: ${e.subject}\n\n${e.body}`); note('Copied.', 'var(--success)'); }
            catch { note('Could not copy. Select the text and copy it by hand.', 'var(--danger)'); }
        });
        body.querySelector('#es-approve').addEventListener('click', async () => {
            if (st.busy) return;
            const e = read();
            if (!TO_OK.test(e.to)) { note('The To address must be one address ending in @tcgplayer.com.', 'var(--danger)'); return; }
            if (e.subject.length < 3) { note('Add a subject.', 'var(--danger)'); return; }
            if (e.body.trim().length < 20) { note('Write the email text.', 'var(--danger)'); return; }
            st.busy = true;
            body.querySelectorAll('button').forEach(b => { b.disabled = true; });
            try {
                const id = await saveDraft(e);
                const { error } = await supabase.rpc('tcg_approve_escalation', { p_id: id });
                if (error) throw new Error(error.message);
                setTo(e.to);
                try {
                    const r = await callDesktop('/api/tcg/messages/export');
                    st.msg = r.summary?.exported ? 'Written for Grok. Tell Grok "do messages" to send it.' : 'Approved.';
                } catch (err) { st.msg = `Approved, but the desktop could not be reached (${err.message}). It is written for Grok the next time a sync runs.`; }
                st.edit = null; st.busy = false;
                await refresh();
            } catch (err) {
                note(err.message, 'var(--danger)');
                st.busy = false;
                body.querySelectorAll('button').forEach(b => { b.disabled = false; });
            }
        });
    };

    body.innerHTML = '<p>Loading...</p>';
    try { await load(); } catch (err) { body.innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(err.message)}</p>`; return; }
    draw();
}
