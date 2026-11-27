// auto-sync.js
// Runs the TCGplayer "Sync" (read what Grok saved in Dropbox, hand over approved messages/ratings,
// refresh the follow-up list) on its own, and shows a small indicator in the top corner of every page.
//
// When it runs: ONLY while the Incoming page is open.
//   - when you open the Incoming page (or load the app straight onto it), if the last sync is over 5 minutes old
//   - every 60 s while the Incoming page stays open (same 5-minute rule)
//   - the Sync button on Incoming and "Sync now" in the sync log run it right now
// On every other page nothing syncs by itself. The indicator is still shown everywhere.
// If the PC cannot be reached it stays quiet and does not retry on its own for 10 minutes.
//
// Pages hear about it through window events:
//   'cbm-sync-state'  detail {running, msg, error}   (start / end, for button + message text)
//   'cbm-sync-done'   detail {ok, summary}           (the data changed: pages refresh only what changed)

import { callDesktop } from './desktop-api.js';
import { supabase } from './shared.js';

const STALE_MS = 5 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 75 * 1000;          // no answer from the PC by then = failed (the API may be down)
const LOG_MAX = 25;

// survives page-module re-imports (see CLAUDE.md: module state resets on navigation)
const S = (window.__cbmSync ||= { running: false, last: null, msg: '', error: null, nextAuto: 0, lastPending: 0, started: false, log: [] });
try { if (!S.log.length) S.log = JSON.parse(localStorage.getItem('cbmSyncLog') || '[]'); } catch { /* storage blocked */ }
try { const v = Number(localStorage.getItem('cbmLastSync')); if (v && !S.last) S.last = v; } catch { /* storage blocked */ }

function say() {
    window.dispatchEvent(new CustomEvent('cbm-sync-state', { detail: { running: S.running, msg: S.msg, error: S.error } }));
    paint();
}

function paint() {
    const chip = document.getElementById('sync-chip');
    if (!chip) return;
    const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (S.running) {
        chip.className = 'running';
        chip.innerHTML = '<span class="sync-spin"></span>Syncing…';
        chip.title = 'Reading what Grok saved and refreshing your orders';
    } else if (S.error) {
        chip.className = 'error';
        chip.innerHTML = '⚠ Sync failed';
        chip.title = `${S.error}\nClick to see the sync log.`;
    } else if (S.last) {
        chip.className = 'ok';
        chip.innerHTML = `✓ Synced ${t(S.last)}`;
        chip.title = `${S.msg || 'Up to date'}\nClick to see the sync log.`;
    } else {
        chip.className = '';
        chip.innerHTML = 'Not synced yet';
        chip.title = 'Click to see the sync log.';
    }
}

// ── sync log: what each sync read and changed (kept in this browser, last 25) ──
function saveLog() { try { localStorage.setItem('cbmSyncLog', JSON.stringify(S.log.slice(0, LOG_MAX))); } catch { /* ignore */ } }

function describe(sm) {
    const bits = [];
    if (sm.files) bits.push(`read ${sm.files} file(s)` + (Object.keys(sm.kinds || {}).length ? ' (' + Object.entries(sm.kinds).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ') + ')' : ''));
    if (sm.new_messages) bits.push(`${sm.new_messages} new seller message(s)`);
    if (sm.results) bits.push(`${sm.results} result(s) back from Grok`);
    if (sm.exported) bits.push(`${sm.exported} item(s) handed to Grok`);
    if (sm.unknown) bits.push(`${sm.unknown} marked no-answer`);
    if (sm.settling) bits.push(`${sm.settling} new file(s) from Grok still being saved, syncing again in about 2 minutes`);
    return bits.length ? bits.join(' · ') : 'nothing new from Grok';
}

// Incoming reports which orders actually changed on screen; it is attached to the latest log line
window.__cbmSyncLogChanges = (changes) => { if (S.log[0] && changes?.length) { S.log[0].changes = changes.slice(0, 30); saveLog(); renderLog(); } };

function renderLog() {
    const pop = document.getElementById('sync-pop');
    if (!pop || pop.style.display === 'none') return;
    const tm = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    pop.innerHTML = `<div style="display:flex; align-items:center; margin-bottom:6px;"><strong>Sync log</strong>
        <button class="btn btn-primary" id="sync-now" style="margin-left:auto; font-size:12px;" ${S.running ? 'disabled' : ''}>${S.running ? 'Syncing...' : 'Sync now'}</button></div>
        ${S.log.length ? S.log.map(l => `<div style="padding:5px 0; border-top:1px solid var(--border);">
            <span style="color:${l.ok ? 'var(--success)' : 'var(--warning)'};">${l.ok ? '✓' : '⚠'}</span> <span style="color:var(--text-secondary);">${esc(tm(l.at))}</span> ${l.manual ? '<span style="color:var(--text-secondary);">(you)</span>' : ''}<br>
            ${esc(l.text)}
            ${(l.changes || []).length ? `<div style="color:var(--text-secondary); margin-top:2px;">Updated: ${l.changes.map(c => esc(c)).join(', ')}</div>` : ''}</div>`).join('') : '<div style="color:var(--text-secondary);">No syncs yet in this browser.</div>'}`;
    pop.querySelector('#sync-now')?.addEventListener('click', () => runSync({ manual: true }));
}


const onIncoming = () => location.hash.replace('#', '').split('/')[0] === 'incoming';

export async function runSync({ manual = false } = {}) {
    if (S.running) return;
    S.running = true; S.error = null; S.msg = 'Reading Grok\'s files (can take up to a minute)...';
    say(); renderLog();
    let ok = false, summary = {};
    try {
        const r = await callDesktop('/api/tcg/messages/sync', TIMEOUT_MS);
        summary = r.summary || {};
        if (summary.error) throw new Error(summary.error);
        const kinds = Object.entries(summary.kinds || {}).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
        S.msg = summary.files
            ? `Read ${summary.files} file(s) (${kinds}); ${summary.new_messages || 0} new message(s). ${summary.followups ?? '?'} orders on the follow-up list.`
            : summary.settling ? `${summary.settling} new file(s) from Grok are still being saved. Syncing again in about 2 minutes.`
                : `Nothing new from Grok. Follow-up list refreshed (${summary.followups ?? '?'} orders).`;
        S.last = Date.now();
        if (summary.settling) setTimeout(() => { if (onIncoming()) runSync(); }, 100 * 1000);   // Grok's files are still settling: look again once they have (only if you are still on Incoming)
        try { localStorage.setItem('cbmLastSync', String(S.last)); } catch { /* ignore */ }
        ok = true;
    } catch (e) {
        S.error = /too long/i.test(e.message) ? `Timed out: your PC did not answer within ${TIMEOUT_MS / 1000} seconds. The desktop program may be down.` : e.message;
        S.msg = `Sync did not work: ${S.error}`;
        S.nextAuto = Date.now() + BACKOFF_MS;
    }
    S.running = false;
    S.log.unshift({ at: Date.now(), ok, manual, text: ok ? describe(summary) : S.error });
    S.log.length = Math.min(S.log.length, LOG_MAX);
    saveLog();
    say(); renderLog();
    window.__cbmRefreshIncomingBadge?.();
    window.__cbmRefreshHeldBadge?.();
    if (ok) window.dispatchEvent(new CustomEvent('cbm-sync-done', { detail: { ok, summary } }));
}

// run only if the last sync is old and we are not in a back-off after a failure
export function maybeSync() {
    if (S.running || Date.now() < S.nextAuto) return;
    if (S.last && Date.now() - S.last < STALE_MS) return;
    runSync();
}

export function initAutoSync() {
    if (S.started) return;
    S.started = true;
    const style = document.createElement('style');
    style.textContent = `
        #sync-chip { position: fixed; top: 10px; right: 14px; z-index: 50; font-size: 12px; padding: 4px 12px; border-radius: 14px;
            border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; user-select: none; }
        #sync-chip.running { color: var(--accent); border-color: var(--accent); }
        #sync-chip.ok { color: var(--success); }
        #sync-chip.error { color: var(--warning); border-color: var(--warning); }
        .sync-spin { display: inline-block; width: 10px; height: 10px; margin-right: 7px; border: 2px solid currentColor; border-top-color: transparent;
            border-radius: 50%; animation: cbm-spin .8s linear infinite; vertical-align: -1px; }
        @keyframes cbm-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
    const chip = document.createElement('div');
    chip.id = 'sync-chip';
    document.body.appendChild(chip);
    const pop = document.createElement('div');
    pop.id = 'sync-pop';
    pop.style.cssText = 'display:none; position:fixed; top:42px; right:14px; z-index:60; width:min(420px, 92vw); max-height:60vh; overflow:auto; font-size:12px; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-secondary); box-shadow:0 6px 24px rgba(0,0,0,.5);';
    document.body.appendChild(pop);
    chip.addEventListener('click', (e) => { e.stopPropagation(); pop.style.display = pop.style.display === 'none' ? 'block' : 'none'; renderLog(); });
    document.addEventListener('click', (e) => { if (!pop.contains(e.target) && e.target !== chip) pop.style.display = 'none'; });
    paint();

    window.addEventListener('hashchange', () => { if (onIncoming()) maybeSync(); });
    setInterval(() => { if (onIncoming() && !document.hidden) maybeSync(); }, 60 * 1000);
    if (onIncoming()) maybeSync();
}
