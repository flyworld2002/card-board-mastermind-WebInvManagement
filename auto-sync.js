// auto-sync.js
// Runs the TCGplayer "Sync" (read what Grok saved in Dropbox, hand over approved messages/ratings,
// refresh the follow-up list) on its own, and shows a small indicator in the top corner of every page.
//
// When it runs:
//   - when the app opens, and when you open the Incoming page, if the last sync is over 5 minutes old
//   - every 60 s while the Incoming page is open (same 5-minute rule)
//   - every 2 minutes (page visible) while something approved is still waiting on Grok, so Grok's
//     result shows up by itself
//   - the Sync button on Incoming and a click on the indicator run it right now
// If the PC cannot be reached it stays quiet and does not retry on its own for 10 minutes.
//
// Pages hear about it through window events:
//   'cbm-sync-state'  detail {running, msg, error}   (start / end, for button + message text)
//   'cbm-sync-done'   detail {ok, summary}           (the data changed: pages refresh only what changed)

import { callDesktop } from './desktop-api.js';
import { supabase } from './shared.js';

const STALE_MS = 5 * 60 * 1000;
const PENDING_POLL_MS = 2 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;

// survives page-module re-imports (see CLAUDE.md: module state resets on navigation)
const S = (window.__cbmSync ||= { running: false, last: null, msg: '', error: null, nextAuto: 0, lastPending: 0, started: false });
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
        chip.innerHTML = '⚠ Couldn’t reach your PC';
        chip.title = `${S.error}\nClick to try again.`;
    } else if (S.last) {
        chip.className = 'ok';
        chip.innerHTML = `✓ Synced ${t(S.last)}`;
        chip.title = `${S.msg || 'Up to date'}\nClick to sync now.`;
    } else {
        chip.className = '';
        chip.innerHTML = 'Not synced yet';
        chip.title = 'Click to sync now.';
    }
}

export async function runSync({ manual = false } = {}) {
    if (S.running) return;
    S.running = true; S.error = null; S.msg = 'Reading Grok\'s files (can take up to a minute)...';
    say();
    let ok = false, summary = {};
    try {
        const r = await callDesktop('/api/tcg/messages/sync');
        summary = r.summary || {};
        if (summary.error) throw new Error(summary.error);
        const kinds = Object.entries(summary.kinds || {}).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
        S.msg = summary.files
            ? `Read ${summary.files} file(s) (${kinds}); ${summary.new_messages || 0} new message(s). ${summary.followups ?? '?'} orders on the follow-up list.`
            : `Nothing new from Grok. Follow-up list refreshed (${summary.followups ?? '?'} orders).`;
        S.last = Date.now();
        try { localStorage.setItem('cbmLastSync', String(S.last)); } catch { /* ignore */ }
        ok = true;
    } catch (e) {
        S.error = e.message;
        S.msg = `Sync did not work: ${e.message}`;
        S.nextAuto = Date.now() + BACKOFF_MS;
    }
    S.running = false;
    say();
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

async function pendingWork() {
    const [m, r] = await Promise.all(['tcg_msg_outbox', 'tcg_rating_outbox'].map(t =>
        supabase.from(t).select('id', { count: 'exact', head: true }).in('status', ['approved', 'exported'])));
    return (m.count || 0) + (r.count || 0);
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
    chip.addEventListener('click', () => runSync({ manual: true }));
    document.body.appendChild(chip);
    paint();

    const onIncoming = () => location.hash.replace('#', '').split('/')[0] === 'incoming';
    window.addEventListener('hashchange', () => { if (onIncoming()) maybeSync(); });
    setInterval(() => { if (onIncoming() && !document.hidden) maybeSync(); }, 60 * 1000);
    setInterval(async () => {
        if (document.hidden || S.running || Date.now() < S.nextAuto) return;
        try { if (await pendingWork() > 0) runSync(); } catch { /* try again next time */ }
    }, PENDING_POLL_MS);
    maybeSync();
}
