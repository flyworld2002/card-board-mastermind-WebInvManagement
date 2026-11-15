// price-refresh.js
// Price Refresh page: schedule + settings for the weekly market-price
// refresh that runs on the desktop (Card-Board-MasterMind
// importer/price_refresh_job.py, started by the CBMPriceRefresh scheduled
// task), and the results of each run.
//
// Two tabs:
//   Schedule — which set is refreshed on which day, per-set on/off, and the
//              job's settings (start time, eBay push time/mode, guard).
//   Results  — prices the guard held back (approve/reject here), then what
//              each run did.
//
// Everything here is plain Supabase reads/writes against the
// price_refresh_* tables (sql/price_refresh.sql). The desktop job reads
// those tables at the start of every run, so a change made here takes
// effect on the next run with nothing to restart. This page never talks
// to eBay or the picking API itself.

import { supabase, formatPrice, loadAxisOptions, axisDisplay } from './shared.js';

const DAYS = [
    [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'],
    [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday'],
];
const DAY_NAME = Object.fromEntries(DAYS);
const DAY_SHORT = Object.fromEntries(DAYS.map(([n, name]) => [n, name.slice(0, 3)]));

const HOLD_REASONS = {
    swing: 'Big price move',
    low_listings: 'Few TCGplayer listings',
    set_hold: 'Whole set held',
};

const state = {
    tab: 'schedule',
    settings: null,
    sets: [],            // rows of v_price_refresh_sets
    holds: [],           // price_refresh_changes rows with status = 'held'
    approvedWaiting: 0,  // approved but not pushed to eBay yet
    runs: [],
    openRunId: null,
    runDetail: {},       // run_id -> { sets, pushes }
    selectedHolds: new Set(),
    busy: false,
};

function esc(s) {
    return (s ?? '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function todayIsoDay() {
    const d = new Date().getDay();   // 0 = Sunday
    return d === 0 ? 7 : d;
}

function fmtTime(t) {
    // '04:00:00' -> '4:00 AM'
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtDateTime(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export async function renderPriceRefresh(container) {
    state.tab = window.__cbmPriceRefreshTab || 'schedule';
    state.selectedHolds = new Set();

    container.innerHTML = `
        <h2 style="margin:0 0 12px;">Price refresh</h2>
        <div style="display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border);">
            <button class="pr-tab-btn" data-tab="schedule">Schedule</button>
            <button class="pr-tab-btn" data-tab="results">Results <span id="pr-holds-count" class="badge badge-restock" style="display:none;"></span></button>
        </div>
        <div id="pr-content"><p>Loading...</p></div>
        <style>
            .pr-tab-btn {
                background:none; border:none; color:var(--text-secondary);
                padding:8px 14px; font-size:13px; cursor:pointer;
                border-bottom:2px solid transparent; margin-bottom:-1px;
            }
            .pr-tab-btn:hover { color:var(--text); }
            .pr-tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }

            .pr-strip {
                display:flex; gap:16px; flex-wrap:wrap; align-items:center;
                border:1px solid var(--border); border-radius:8px;
                padding:10px 14px; margin-bottom:16px; font-size:13px;
            }
            .pr-board {
                display:grid; gap:10px; margin-bottom:24px;
                grid-template-columns:repeat(auto-fill, minmax(190px, 1fr));
            }
            .pr-col {
                border:1px solid var(--border); border-radius:8px;
                background:var(--bg-secondary); min-height:120px;
                display:flex; flex-direction:column;
            }
            .pr-col.today { border-color:var(--accent); }
            .pr-col.drop-target { outline:2px dashed var(--accent); outline-offset:-2px; }
            .pr-col-head { padding:10px 10px 6px; border-bottom:1px solid var(--border); }
            .pr-col-title { font-weight:600; font-size:13px; }
            .pr-col-load { font-size:11px; color:var(--text-secondary); margin-top:2px; }
            .pr-col-body { padding:8px; display:flex; flex-direction:column; gap:8px; flex:1; }
            .pr-card {
                background:var(--bg-tertiary); border:1px solid var(--border);
                border-radius:6px; padding:8px; cursor:grab; font-size:13px;
            }
            .pr-card.off { opacity:0.5; }
            .pr-card-name { font-weight:500; overflow-wrap:anywhere; }
            .pr-card-meta { font-size:11px; color:var(--text-secondary); margin:3px 0 6px; }
            .pr-card-actions { display:flex; gap:6px; align-items:center; }
            .pr-card-actions label { font-size:11px; color:var(--text-secondary); display:flex; align-items:center; gap:3px; }
            .pr-card-actions select { font-size:11px; padding:3px 4px; flex:1; min-width:0; }
            .pr-tag {
                display:inline-block; font-size:10px; padding:1px 6px; border-radius:8px;
                background:rgba(74,140,255,0.15); color:var(--accent); margin-left:4px;
            }
            .pr-panel { border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:24px; }
            .pr-panel h3 { margin:0 0 4px; font-size:15px; }
            .pr-panel .pr-help { color:var(--text-secondary); font-size:12px; margin:0 0 14px; }
            .pr-form { display:grid; gap:14px 24px; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); }
            .pr-field label { display:block; font-size:12px; color:var(--text-secondary); margin-bottom:4px; }
            .pr-field .pr-note { font-size:11px; color:var(--text-secondary); margin-top:4px; }
            .pr-field input[type="time"] {
                background:var(--bg-tertiary); border:1px solid var(--border); color:var(--text);
                padding:6px 8px; border-radius:4px; font-size:13px; color-scheme:dark;
            }
            .pr-field input[type="number"] { width:70px; flex:none; }
            .pr-inline { display:flex; align-items:center; gap:6px; font-size:13px; white-space:nowrap; }
            .pr-up { color:var(--danger); }
            .pr-down { color:var(--success); }
            .pr-run-head { cursor:pointer; }
            .pr-msg { font-size:12px; margin-left:10px; }
        </style>
    `;

    container.querySelectorAll('.pr-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.tab = btn.dataset.tab;
            window.__cbmPriceRefreshTab = state.tab;
            renderTab(container);
        });
    });

    try {
        await Promise.all([loadAxisOptions(), loadSchedule(), loadHolds()]);
    } catch (err) {
        console.error(err);
        container.querySelector('#pr-content').innerHTML =
            `<p style="color:var(--danger)">Failed to load price refresh data: ${esc(err.message)}</p>`;
        return;
    }
    renderTab(container);
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadSchedule() {
    const [{ data: settings, error: sErr }, { data: sets, error: vErr }] = await Promise.all([
        supabase.from('price_refresh_settings').select('*').eq('id', 1).maybeSingle(),
        supabase.from('v_price_refresh_sets').select('*').order('name'),
    ]);
    if (sErr) throw sErr;
    if (vErr) throw vErr;
    state.settings = settings;
    state.sets = sets || [];
}

async function loadHolds() {
    const [{ data: holds, error: hErr }, { count, error: cErr }] = await Promise.all([
        supabase.from('price_refresh_changes')
            .select(`id, set_id, variant_id, old_price, new_price, source, listing_count, hold_reason, created_at,
                     card_sets(name),
                     card_variants(foil_type, foil_pattern, stamp_type, card_master(name, card_number, card_number_numeric))`)
            .eq('status', 'held')
            .order('created_at', { ascending: false })
            .limit(1000),
        supabase.from('price_refresh_changes')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'approved').is('pushed_at', null),
    ]);
    if (hErr) throw hErr;
    if (cErr) throw cErr;
    state.holds = holds || [];
    state.approvedWaiting = count || 0;
    const known = new Set(state.holds.map(h => h.id));
    state.selectedHolds = new Set([...state.selectedHolds].filter(id => known.has(id)));
}

async function loadRuns() {
    const { data, error } = await supabase.from('price_refresh_runs')
        .select('*').order('started_at', { ascending: false }).limit(21);
    if (error) throw error;
    state.runs = data || [];
}

async function loadRunDetail(runId) {
    const [{ data: sets, error: sErr }, { data: pushes, error: pErr }] = await Promise.all([
        supabase.from('price_refresh_run_sets').select('*').eq('run_id', runId).order('started_at', { nullsFirst: false }),
        supabase.from('price_refresh_pushes').select('*').eq('run_id', runId).order('created_at'),
    ]);
    if (sErr) throw sErr;
    if (pErr) throw pErr;
    state.runDetail[runId] = { sets: sets || [], pushes: pushes || [] };
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function renderTab(container) {
    container.querySelectorAll('.pr-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    updateHoldsBadges(container);
    if (state.tab === 'results') renderResultsTab(container);
    else renderScheduleTab(container);
}

function updateHoldsBadges(container) {
    const badge = container.querySelector('#pr-holds-count');
    if (badge) {
        badge.textContent = state.holds.length;
        badge.style.display = state.holds.length ? 'inline-block' : 'none';
    }
    if (typeof window.__cbmRefreshPriceHoldsBadge === 'function') window.__cbmRefreshPriceHoldsBadge();
}

// ── Schedule tab ────────────────────────────────────────────────────────────

function renderScheduleTab(container) {
    const wrap = container.querySelector('#pr-content');
    const s = state.settings || {};
    const today = todayIsoDay();
    const unscheduled = state.sets.filter(x => !x.days || !x.days.length);

    const pushWhen = s.push_timing === 'fixed_time' && s.push_time
        ? `at ${fmtTime(s.push_time)}` : 'right after each set';

    wrap.innerHTML = `
        <div class="pr-strip">
            <span>Scheduled refresh: <strong style="color:${s.enabled ? 'var(--success)' : 'var(--danger)'}">${s.enabled ? 'On' : 'Off'}</strong></span>
            <span>Starts: <strong>${esc(fmtTime(s.refresh_start_time))}</strong> desktop time</span>
            <span>eBay push: <strong>${esc(pushWhen)}</strong></span>
            <span>Mode: <strong style="color:${s.push_mode === 'live' ? 'var(--success)' : 'var(--warning)'}">${s.push_mode === 'live' ? 'Live' : 'Dry run (report only)'}</strong></span>
        </div>

        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 10px;">
            Drag a set to another day, or use its menu. Hold Ctrl while dropping to keep it on both days.
            Sets under “Not scheduled” are never refreshed automatically.
        </p>
        <div class="pr-board">
            ${DAYS.map(([n, name]) => dayColumnHTML(n, name, n === today)).join('')}
            ${dayColumnHTML(0, 'Not scheduled', false, unscheduled)}
        </div>
        <div id="pr-board-error" style="color:var(--danger); font-size:12px; margin:-12px 0 16px;"></div>

        ${settingsPanelHTML(s)}
    `;

    wireBoard(container);
    wireSettings(container);
}

function setsForDay(day) {
    return state.sets
        .filter(x => (x.days || []).includes(day))
        .sort((a, b) => (b.is_newest - a.is_newest) || (b.listed_variants - a.listed_variants));
}

function dayColumnHTML(day, title, isToday, setsOverride = null) {
    const sets = setsOverride || setsForDay(day);
    const active = sets.filter(x => x.enabled);
    const cards = active.reduce((sum, x) => sum + (x.listed_variants || 0), 0);
    const load = day === 0
        ? `${sets.length} set${sets.length === 1 ? '' : 's'}`
        : `${active.length} set${active.length === 1 ? '' : 's'} · ${cards.toLocaleString()} cards`;
    return `
        <div class="pr-col ${isToday ? 'today' : ''}" data-day="${day}">
            <div class="pr-col-head">
                <div class="pr-col-title">${esc(title)}${isToday ? ' <span class="pr-tag">today</span>' : ''}</div>
                <div class="pr-col-load">${load}</div>
            </div>
            <div class="pr-col-body">
                ${sets.map(x => setCardHTML(x, day)).join('') || `<div style="font-size:12px; color:var(--text-secondary);">${day === 0 ? 'Every listed set is scheduled.' : 'Nothing scheduled.'}</div>`}
            </div>
        </div>
    `;
}

function setCardHTML(x, day) {
    const otherDays = (x.days || []).filter(d => d !== day);
    const also = otherDays.length ? ` · also ${otherDays.map(d => DAY_SHORT[d]).join(', ')}` : '';
    const moveOpts = DAYS.filter(([n]) => n !== day && !(x.days || []).includes(n))
        .map(([n, name]) => `<option value="move:${n}">${day === 0 ? 'Schedule on' : 'Move to'} ${name}</option>`).join('');
    const alsoOpts = day === 0 ? '' : DAYS.filter(([n]) => !(x.days || []).includes(n))
        .map(([n, name]) => `<option value="copy:${n}">Also run on ${name}</option>`).join('');
    return `
        <div class="pr-card ${x.enabled ? '' : 'off'}" draggable="true" data-set-id="${x.set_id}" data-day="${day}">
            <div class="pr-card-name">${esc(x.name)}${x.is_newest ? '<span class="pr-tag" title="Newest set: goes to TCGplayer after 2 API tries">newest</span>' : ''}</div>
            <div class="pr-card-meta">${(x.listed_variants || 0).toLocaleString()} cards · ${x.listings} listing${x.listings === 1 ? '' : 's'}${also}</div>
            <div class="pr-card-actions">
                <label title="Turn this set's refresh on or off"><input type="checkbox" class="pr-enabled" ${x.enabled ? 'checked' : ''} /> On</label>
                <select class="pr-menu">
                    <option value="">Move…</option>
                    ${moveOpts}
                    ${alsoOpts}
                    ${day !== 0 ? `<option value="remove">Remove from ${DAY_NAME[day]}</option>` : ''}
                    <option value="newest">${x.is_newest ? 'Not a newest set (try API fully)' : 'Mark as newest set (TCGplayer first)'}</option>
                </select>
            </div>
        </div>
    `;
}

function wireBoard(container) {
    const errBox = container.querySelector('#pr-board-error');

    const run = async (fn) => {
        if (state.busy) return;
        state.busy = true;
        errBox.textContent = '';
        try {
            await fn();
            await loadSchedule();
        } catch (err) {
            console.error(err);
            state.busy = false;
            errBox.textContent = `Could not save: ${err.message}`;
            return;
        }
        state.busy = false;
        renderScheduleTab(container);
    };

    container.querySelectorAll('.pr-card').forEach(card => {
        const setId = card.dataset.setId;
        const day = Number(card.dataset.day);

        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', JSON.stringify({ setId, fromDay: day }));
            e.dataTransfer.effectAllowed = 'copyMove';
        });

        card.querySelector('.pr-enabled').addEventListener('change', (e) => {
            const enabled = e.target.checked;
            run(() => saveSetOption(setId, { enabled }));
        });

        card.querySelector('.pr-menu').addEventListener('change', (e) => {
            const v = e.target.value;
            if (!v) return;
            if (v === 'remove') return run(() => removeFromDay(setId, day));
            if (v === 'newest') {
                const cur = state.sets.find(x => x.set_id === setId);
                return run(() => saveSetOption(setId, { is_newest: !(cur && cur.is_newest) }));
            }
            const [action, target] = v.split(':');
            const toDay = Number(target);
            if (action === 'copy') return run(() => addToDay(setId, toDay));
            return run(async () => {
                await addToDay(setId, toDay);
                if (day !== 0) await removeFromDay(setId, day);
            });
        });
    });

    container.querySelectorAll('.pr-col').forEach(col => {
        const toDay = Number(col.dataset.day);
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop-target'); });
        col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
        col.addEventListener('drop', (e) => {
            e.preventDefault();
            col.classList.remove('drop-target');
            let payload;
            try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
            const { setId, fromDay } = payload || {};
            if (!setId || fromDay === toDay) return;
            const keepBoth = e.ctrlKey && fromDay !== 0 && toDay !== 0;
            run(async () => {
                if (toDay !== 0) await addToDay(setId, toDay);
                if (fromDay !== 0 && !keepBoth) await removeFromDay(setId, fromDay);
            });
        });
    });
}

async function addToDay(setId, day) {
    const sortOrder = setsForDay(day).length + 1;
    const { error } = await supabase.from('price_refresh_schedule')
        .upsert({ set_id: setId, day_of_week: day, sort_order: sortOrder }, { onConflict: 'set_id,day_of_week' });
    if (error) throw error;
}

async function removeFromDay(setId, day) {
    const { error } = await supabase.from('price_refresh_schedule')
        .delete().eq('set_id', setId).eq('day_of_week', day);
    if (error) throw error;
}

async function saveSetOption(setId, patch) {
    const { error } = await supabase.from('price_refresh_sets')
        .upsert({ set_id: setId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'set_id' });
    if (error) throw error;
}

// ── Settings panel ──────────────────────────────────────────────────────────

function settingsPanelHTML(s) {
    const t = (v) => (v || '').slice(0, 5);
    return `
        <div class="pr-panel">
            <h3>Settings</h3>
            <p class="pr-help">
                The desktop checks these every 15 minutes, so a change here needs no restart.
                All times are the desktop's local time.
            </p>
            <div class="pr-form">
                <div class="pr-field">
                    <label>Scheduled refresh</label>
                    <select id="pr-enabled">
                        <option value="true" ${s.enabled ? 'selected' : ''}>On</option>
                        <option value="false" ${!s.enabled ? 'selected' : ''}>Off (nothing runs)</option>
                    </select>
                </div>
                <div class="pr-field">
                    <label>Refresh start time</label>
                    <input type="time" id="pr-start" value="${esc(t(s.refresh_start_time))}" />
                </div>
                <div class="pr-field">
                    <label>When to push prices to eBay</label>
                    <select id="pr-push-timing">
                        <option value="after_refresh" ${s.push_timing !== 'fixed_time' ? 'selected' : ''}>Right after each set is refreshed</option>
                        <option value="fixed_time" ${s.push_timing === 'fixed_time' ? 'selected' : ''}>At a set time, same day</option>
                    </select>
                    <div id="pr-push-time-wrap" style="margin-top:6px; ${s.push_timing === 'fixed_time' ? '' : 'display:none;'}">
                        <input type="time" id="pr-push-time" value="${esc(t(s.push_time) || '09:00')}" />
                    </div>
                </div>
                <div class="pr-field">
                    <label>eBay push mode</label>
                    <select id="pr-push-mode">
                        <option value="dry_run" ${s.push_mode !== 'live' ? 'selected' : ''}>Dry run — report only, eBay untouched</option>
                        <option value="live" ${s.push_mode === 'live' ? 'selected' : ''}>Live — change prices on eBay</option>
                    </select>
                    <div class="pr-note">Market prices in the database are updated in both modes.</div>
                </div>
                <div class="pr-field">
                    <label>After I approve a held price, push it</label>
                    <select id="pr-approval-mode">
                        <option value="next_run" ${s.approval_push_mode !== 'immediate' ? 'selected' : ''}>On the next scheduled run</option>
                        <option value="immediate" ${s.approval_push_mode === 'immediate' ? 'selected' : ''}>Right away (within 15 minutes)</option>
                    </select>
                </div>
                <div class="pr-field">
                    <label>Hold a price when it moves more than</label>
                    <div class="pr-inline">
                        <input type="number" id="pr-swing-pct" min="1" step="1" value="${esc(Number(s.swing_pct))}" /> <span>% and $</span>
                        <input type="number" id="pr-swing-min" min="0" step="0.25" value="${esc(Number(s.swing_min_dollars))}" />
                    </div>
                    <div class="pr-note">Both must be true. Held prices wait on the Results tab.</div>
                </div>
                <div class="pr-field">
                    <label>Hold when TCGplayer has fewer than</label>
                    <div class="pr-inline">
                        <input type="number" id="pr-min-listings" min="0" step="1" value="${esc(s.min_listings)}" /> <span>listings</span>
                    </div>
                </div>
                <div class="pr-field">
                    <label>Hold the whole set when more than</label>
                    <div class="pr-inline">
                        <input type="number" id="pr-set-hold" min="1" max="100" step="1" value="${esc(Math.round(Number(s.set_hold_fraction) * 100))}" /> <span>% of its cards are held</span>
                    </div>
                </div>
                <div class="pr-field">
                    <label>Price API tries before TCGplayer</label>
                    <div class="pr-inline">
                        <span>Older sets</span> <input type="number" id="pr-tries-older" min="1" max="10" step="1" value="${esc(s.api_tries_older)}" />
                        <span>Newest sets</span> <input type="number" id="pr-tries-newest" min="0" max="10" step="1" value="${esc(s.api_tries_newest)}" />
                    </div>
                </div>
            </div>
            <div style="margin-top:16px;">
                <button class="btn btn-primary" id="pr-save-settings">Save settings</button>
                <span id="pr-settings-msg" class="pr-msg"></span>
            </div>
        </div>
    `;
}

function wireSettings(container) {
    const q = (id) => container.querySelector(id);
    const msg = q('#pr-settings-msg');

    q('#pr-push-timing').addEventListener('change', (e) => {
        q('#pr-push-time-wrap').style.display = e.target.value === 'fixed_time' ? '' : 'none';
    });

    q('#pr-save-settings').addEventListener('click', async () => {
        msg.style.color = 'var(--danger)';
        msg.textContent = '';

        const num = (id) => Number(q(id).value);
        const pushTiming = q('#pr-push-timing').value;
        const patch = {
            enabled: q('#pr-enabled').value === 'true',
            refresh_start_time: q('#pr-start').value,
            push_timing: pushTiming,
            push_time: pushTiming === 'fixed_time' ? q('#pr-push-time').value : null,
            push_mode: q('#pr-push-mode').value,
            approval_push_mode: q('#pr-approval-mode').value,
            swing_pct: num('#pr-swing-pct'),
            swing_min_dollars: num('#pr-swing-min'),
            min_listings: num('#pr-min-listings'),
            set_hold_fraction: num('#pr-set-hold') / 100,
            api_tries_older: num('#pr-tries-older'),
            api_tries_newest: num('#pr-tries-newest'),
            updated_at: new Date().toISOString(),
        };

        if (!patch.refresh_start_time) { msg.textContent = 'Set a refresh start time.'; return; }
        if (pushTiming === 'fixed_time' && !patch.push_time) { msg.textContent = 'Set the eBay push time.'; return; }
        if (pushTiming === 'fixed_time' && patch.push_time < patch.refresh_start_time) {
            msg.textContent = 'The push time must be later than the refresh start time on the same day.'; return;
        }
        const bad = ['swing_pct', 'swing_min_dollars', 'min_listings', 'set_hold_fraction', 'api_tries_older', 'api_tries_newest']
            .find(k => !Number.isFinite(patch[k]) || patch[k] < 0);
        if (bad) { msg.textContent = 'Every number must be zero or more.'; return; }

        const goingLive = patch.push_mode === 'live' && (state.settings || {}).push_mode !== 'live';
        if (goingLive && !window.confirm('Switch to live? From the next run on, refreshed prices will be changed on eBay automatically.')) return;

        const { error } = await supabase.from('price_refresh_settings').update(patch).eq('id', 1);
        if (error) { msg.textContent = `Could not save: ${error.message}`; return; }

        await loadSchedule();
        renderScheduleTab(container);
        const done = container.querySelector('#pr-settings-msg');
        done.style.color = 'var(--success)';
        done.textContent = 'Saved.';
    });
}

// ── Results tab ─────────────────────────────────────────────────────────────

async function renderResultsTab(container) {
    const wrap = container.querySelector('#pr-content');
    wrap.innerHTML = '<p>Loading...</p>';
    try {
        await Promise.all([loadHolds(), loadRuns()]);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load results: ${esc(err.message)}</p>`;
        return;
    }
    if (state.tab !== 'results') return;
    updateHoldsBadges(container);

    wrap.innerHTML = `
        <div class="pr-panel" id="pr-holds-panel">${holdsPanelHTML()}</div>
        <h3 style="margin:0 0 8px; font-size:15px;">Recent runs</h3>
        <div id="pr-runs">${runsHTML()}</div>
    `;
    wireHolds(container);
    wireRuns(container);
}

function variantLabel(v) {
    if (!v) return '';
    const parts = [axisDisplay('foil_type', v.foil_type), axisDisplay('foil_pattern', v.foil_pattern),
                   axisDisplay('stamp_type', v.stamp_type)].filter(Boolean);
    return parts.join(' · ');
}

function changeHTML(oldPrice, newPrice) {
    if (oldPrice == null) return '<span style="color:var(--text-secondary)">new</span>';
    const diff = Number(newPrice) - Number(oldPrice);
    const pct = Number(oldPrice) > 0 ? (diff / Number(oldPrice)) * 100 : null;
    const cls = diff > 0 ? 'pr-up' : 'pr-down';
    const sign = diff > 0 ? '+' : '−';
    return `<span class="${cls}">${sign}$${Math.abs(diff).toFixed(2)}${pct == null ? '' : ` (${sign}${Math.abs(pct).toFixed(0)}%)`}</span>`;
}

function reasonText(h) {
    const codes = (h.hold_reason || '').split(',').map(x => x.trim()).filter(Boolean);
    return codes.map(c => {
        if (c === 'low_listings' && h.listing_count != null) return `Only ${h.listing_count} listings`;
        return HOLD_REASONS[c] || c;
    }).join(', ');
}

function holdsPanelHTML() {
    const s = state.settings || {};
    const waiting = state.approvedWaiting
        ? `<p class="pr-help" style="margin-top:8px; margin-bottom:0;">${state.approvedWaiting} approved price${state.approvedWaiting === 1 ? '' : 's'} will go to eBay ${s.approval_push_mode === 'immediate' ? 'within 15 minutes' : 'on the next scheduled run'}${s.push_mode === 'live' ? '' : ' (dry run mode: reported only)'}.</p>`
        : '';

    if (!state.holds.length) {
        return `
            <h3>Held prices</h3>
            <p class="pr-help" style="margin-bottom:0;">Nothing is waiting for approval.</p>
            ${waiting}
        `;
    }

    const bySet = new Map();
    for (const h of state.holds) {
        const name = h.card_sets?.name || 'Unknown set';
        if (!bySet.has(name)) bySet.set(name, []);
        bySet.get(name).push(h);
    }
    for (const rows of bySet.values()) {
        rows.sort((a, b) => (a.card_variants?.card_master?.card_number_numeric ?? 1e9) - (b.card_variants?.card_master?.card_number_numeric ?? 1e9));
    }

    const sel = state.selectedHolds.size;
    return `
        <h3>Held prices <span class="badge badge-restock">${state.holds.length}</span></h3>
        <p class="pr-help">
            These moved too much or had too few listings to trust, so they were not saved and the old price is still live.
            Approve to use the new price, reject to keep the old one.
        </p>
        <div class="filters-bar" style="margin-bottom:10px;">
            <button class="btn btn-primary" id="pr-approve-btn" ${sel ? '' : 'disabled'}>Approve selected${sel ? ` (${sel})` : ''}</button>
            <button class="btn" id="pr-reject-btn" ${sel ? '' : 'disabled'}>Reject selected${sel ? ` (${sel})` : ''}</button>
            <span id="pr-holds-msg" class="pr-msg" style="color:var(--danger);"></span>
        </div>
        <div style="overflow-x:auto;">
        <table>
            <thead><tr>
                <th style="width:28px;"><input type="checkbox" id="pr-hold-all" ${sel === state.holds.length ? 'checked' : ''} /></th>
                <th>Card</th><th>Variant</th><th>Old</th><th>New</th><th>Change</th><th>Why held</th><th>Found</th>
            </tr></thead>
            <tbody>
                ${[...bySet.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([setName, rows]) => `
                    <tr>
                        <td><input type="checkbox" class="pr-hold-set" data-set="${esc(setName)}" ${rows.every(r => state.selectedHolds.has(r.id)) ? 'checked' : ''} /></td>
                        <td colspan="7" style="font-weight:600;">${esc(setName)} <span style="color:var(--text-secondary); font-weight:400;">· ${rows.length} held</span></td>
                    </tr>
                    ${rows.map(h => {
                        const cm = h.card_variants?.card_master;
                        return `
                        <tr>
                            <td><input type="checkbox" class="pr-hold-one" data-id="${h.id}" ${state.selectedHolds.has(h.id) ? 'checked' : ''} /></td>
                            <td>${esc(cm ? `#${cm.card_number} ${cm.name}` : h.variant_id)}</td>
                            <td style="color:var(--text-secondary);">${esc(variantLabel(h.card_variants))}</td>
                            <td>${formatPrice(h.old_price)}</td>
                            <td><strong>${formatPrice(h.new_price)}</strong></td>
                            <td>${changeHTML(h.old_price, h.new_price)}</td>
                            <td>${esc(reasonText(h))}</td>
                            <td style="font-size:12px; color:var(--text-secondary);">${esc(fmtDateTime(h.created_at))}</td>
                        </tr>`;
                    }).join('')}
                `).join('')}
            </tbody>
        </table>
        </div>
        ${waiting}
    `;
}

function wireHolds(container) {
    const panel = container.querySelector('#pr-holds-panel');
    if (!panel) return;
    const rerender = () => { panel.innerHTML = holdsPanelHTML(); wireHolds(container); };

    panel.querySelector('#pr-hold-all')?.addEventListener('change', (e) => {
        state.selectedHolds = e.target.checked ? new Set(state.holds.map(h => h.id)) : new Set();
        rerender();
    });
    panel.querySelectorAll('.pr-hold-set').forEach(cb => cb.addEventListener('change', () => {
        for (const h of state.holds) {
            if ((h.card_sets?.name || 'Unknown set') !== cb.dataset.set) continue;
            if (cb.checked) state.selectedHolds.add(h.id); else state.selectedHolds.delete(h.id);
        }
        rerender();
    }));
    panel.querySelectorAll('.pr-hold-one').forEach(cb => cb.addEventListener('change', () => {
        if (cb.checked) state.selectedHolds.add(cb.dataset.id); else state.selectedHolds.delete(cb.dataset.id);
        rerender();
    }));

    const decide = async (approve) => {
        const ids = [...state.selectedHolds];
        if (!ids.length || state.busy) return;
        state.busy = true;
        const msg = panel.querySelector('#pr-holds-msg');
        let error;
        if (approve) {
            ({ error } = await supabase.rpc('approve_price_refresh_changes', { p_ids: ids }));
        } else {
            ({ error } = await supabase.from('price_refresh_changes')
                .update({ status: 'rejected', decided_at: new Date().toISOString() })
                .in('id', ids).eq('status', 'held'));
        }
        state.busy = false;
        if (error) { msg.textContent = `Could not save: ${error.message}`; return; }
        state.selectedHolds = new Set();
        try { await loadHolds(); } catch (err) { console.error(err); }
        updateHoldsBadges(container);
        rerender();
    };
    panel.querySelector('#pr-approve-btn')?.addEventListener('click', () => decide(true));
    panel.querySelector('#pr-reject-btn')?.addEventListener('click', () => decide(false));
}

// ── Runs ────────────────────────────────────────────────────────────────────

function statusBadge(status) {
    const colors = {
        running: 'var(--accent)', awaiting_push: 'var(--accent)', pending: 'var(--text-secondary)',
        api: 'var(--accent)', fallback: 'var(--accent)', guard: 'var(--accent)',
        done: 'var(--success)', ok: 'var(--success)', failed: 'var(--danger)', skipped: 'var(--text-secondary)',
    };
    const labels = { awaiting_push: 'waiting to push', api: 'price API', fallback: 'TCGplayer', guard: 'checking' };
    return `<span style="color:${colors[status] || 'var(--text-secondary)'}; font-weight:600; font-size:12px;">${esc(labels[status] || status)}</span>`;
}

function runsHTML() {
    if (!state.runs.length) {
        return `<p style="color:var(--text-secondary);">No runs yet. The first one starts at ${esc(fmtTime((state.settings || {}).refresh_start_time))} desktop time.</p>`;
    }
    return `
        <table>
            <thead><tr><th>Run</th><th>Status</th><th>eBay</th><th>Sets</th><th>Updated</th><th>Held</th><th>Needs manual</th><th>Pushes</th></tr></thead>
            <tbody>
                ${state.runs.map(r => {
                    const m = r.summary || {};
                    const pushes = m.pushes_ok != null
                        ? `${m.pushes_ok} ok${m.pushes_failed ? ` · <span style="color:var(--danger)">${m.pushes_failed} failed</span>` : ''}`
                        : '-';
                    return `
                    <tr class="pr-run-head" data-run-id="${r.id}">
                        <td>${state.openRunId === r.id ? '▾' : '▸'} ${esc(fmtDateTime(r.started_at))}${r.trigger !== 'scheduled' ? ` <span class="pr-tag">${esc(r.trigger)}</span>` : ''}</td>
                        <td>${statusBadge(r.status)}</td>
                        <td>${r.push_mode === 'live' ? 'Live' : 'Dry run'}</td>
                        <td>${m.sets ?? '-'}</td>
                        <td>${m.applied ?? '-'}</td>
                        <td>${m.held ? `<span style="color:var(--warning)">${m.held}</span>` : (m.held ?? '-')}</td>
                        <td>${m.needs_manual ?? '-'}</td>
                        <td>${pushes}</td>
                    </tr>
                    ${state.openRunId === r.id ? `<tr><td colspan="8" style="background:var(--bg-secondary); padding:12px;">${runDetailHTML(r)}</td></tr>` : ''}`;
                }).join('')}
            </tbody>
        </table>
    `;
}

function runDetailHTML(run) {
    const d = state.runDetail[run.id];
    if (!d) return '<p style="margin:0;">Loading...</p>';
    const notes = (run.summary && run.summary.notes) || [];
    const manual = d.sets.flatMap(s => (s.needs_manual || []).map(n => ({ ...n, set_name: s.set_name })));

    return `
        ${run.error ? `<p style="color:var(--danger); margin:0 0 10px;">${esc(run.error)}</p>` : ''}
        ${notes.length ? `<ul style="margin:0 0 10px; padding-left:18px; font-size:12px; color:var(--warning);">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <table style="margin-bottom:12px;">
            <thead><tr><th>Set</th><th>Status</th><th>Cards</th><th>From API</th><th>From TCGplayer</th><th>Unchanged</th><th>Updated</th><th>Held</th><th>Needs manual</th></tr></thead>
            <tbody>
                ${d.sets.map(s => `
                    <tr>
                        <td>${esc(s.set_name)}${s.set_held ? ' <span class="badge badge-restock">whole set held</span>' : ''}</td>
                        <td>${statusBadge(s.status)}${s.error ? `<div style="font-size:11px; color:var(--danger);">${esc(s.error)}</div>` : ''}</td>
                        <td>${s.variants_in_scope ?? '-'}</td>
                        <td>${s.api_priced}${s.api_tries ? ` <span style="color:var(--text-secondary); font-size:11px;">(${s.api_tries} ${s.api_tries === 1 ? 'try' : 'tries'})</span>` : ''}</td>
                        <td>${s.fallback_priced}</td>
                        <td>${s.unchanged}</td>
                        <td>${s.applied}</td>
                        <td>${s.held ? `<span style="color:var(--warning)">${s.held}</span>` : 0}</td>
                        <td>${(s.needs_manual || []).length}</td>
                    </tr>
                `).join('') || '<tr><td colspan="9" style="color:var(--text-secondary);">No sets were scheduled for this run.</td></tr>'}
            </tbody>
        </table>

        ${d.pushes.length ? `
            <div style="font-weight:600; font-size:13px; margin-bottom:6px;">eBay listings</div>
            <table style="margin-bottom:12px;">
                <thead><tr><th>Listing</th><th>Account</th><th>Result</th><th>${run.push_mode === 'live' ? 'Prices changed' : 'Would change'}</th><th>Notes</th></tr></thead>
                <tbody>
                    ${d.pushes.map(p => `
                        <tr>
                            <td>${esc(p.title || p.listing_id)} <span style="color:var(--text-secondary); font-size:11px;">${esc(p.listing_id)}</span></td>
                            <td>${esc(p.account || '-')}</td>
                            <td>${statusBadge(p.status)}${p.dry_run ? ' <span style="color:var(--text-secondary); font-size:11px;">dry run</span>' : ''}</td>
                            <td>${p.changed ?? '-'}</td>
                            <td style="font-size:12px; color:var(--text-secondary);">${esc(p.error || ((p.warnings || []).length ? `${p.warnings.length} warning${p.warnings.length === 1 ? '' : 's'}: ${p.warnings.slice(0, 3).join('; ')}` : ''))}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        ` : ''}

        ${manual.length ? `
            <div style="font-weight:600; font-size:13px; margin-bottom:6px;">Needs a manual price</div>
            <table>
                <thead><tr><th>Set</th><th>Card</th><th>Why</th></tr></thead>
                <tbody>
                    ${manual.map(n => `<tr><td>${esc(n.set_name)}</td><td>${esc(n.card || n.variant_id || '')}</td><td style="color:var(--text-secondary);">${esc(n.reason || '')}</td></tr>`).join('')}
                </tbody>
            </table>
        ` : ''}
    `;
}

function wireRuns(container) {
    const wrap = container.querySelector('#pr-runs');
    if (!wrap) return;
    const rerender = () => { wrap.innerHTML = runsHTML(); wireRuns(container); };

    wrap.querySelectorAll('.pr-run-head').forEach(row => {
        row.addEventListener('click', async () => {
            const id = row.dataset.runId;
            if (state.openRunId === id) { state.openRunId = null; rerender(); return; }
            state.openRunId = id;
            rerender();
            try {
                await loadRunDetail(id);
            } catch (err) {
                console.error(err);
                state.runDetail[id] = { sets: [], pushes: [] };
            }
            if (state.openRunId === id) rerender();
        });
    });
}
