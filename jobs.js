// jobs.js
// Jobs page: control room for long-running background work that runs on
// picking_api.py's generic job registry (importer/job_runner.py on the
// CBMM side). Two job types so far: market price refresh, and Excel-to-
// staging import. Adding another one later means adding one more POST
// endpoint in picking_api.py plus one more "start" box below; the job
// list itself is generic (keyed by job_type/label/status/progress) and
// needs no changes beyond a jobProgressText() case for the new type's
// shape. See docs/plans/listing-pricing-system.md.
//
// Job state lives in picking_api.py's process memory only (lost on
// restart) — this page just polls it. Polling only runs while at least
// one listed job is still 'running', and stops itself once everything's
// settled, so this isn't a permanent background timer.

import { supabase } from './shared.js';

const PICKING_API_URL = 'https://desktop-tu1m2fc.tail2c58d7.ts.net:8765';
// const PICKING_API_URL = 'http://192.168.1.186:8765'  // home-LAN fallback
// const PICKING_API_URL = 'http://localhost:8765'
const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';

const POLL_INTERVAL_MS = 2500;

const state = {
    sets: [],
    cardResults: [],
    selectedCard: null,   // {id, label}
    jobs: [],
    pollTimer: null,
};

function escapeHtml(s) {
    return (s ?? '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function apiPost(path, body) {
    const resp = await fetch(`${PICKING_API_URL}${path}`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${detail}`);
    }
    return resp.json();
}

async function apiGet(path) {
    const resp = await fetch(`${PICKING_API_URL}${path}`, {
        headers: { 'x-picking-token': PICKING_API_TOKEN },
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${detail}`);
    }
    return resp.json();
}

export async function renderJobs(container) {
    const { data: sets } = await supabase.from('card_sets').select('name').order('name');
    state.sets = (sets || []).map(s => s.name);
    state.selectedCard = null;

    container.innerHTML = `
        <h2 style="margin:0 0 16px;">Jobs</h2>

        <div style="border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:24px;">
            <h3 style="margin:0 0 6px;">Refresh market prices</h3>
            <p style="color:var(--text-secondary); font-size:12px; margin:0 0 14px;">
                Pulls current prices from the Pokemon TCG API and updates market_prices.
                Refreshing a set skips any card whose prices were already refreshed today —
                only stale ones are re-hit. Runs in the background (up to 15 cards at once);
                a big set can still take a while since the API itself is slow.
            </p>
            <div style="display:flex; gap:24px; flex-wrap:wrap;">
                <div style="min-width:240px;">
                    <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:4px;">By set</label>
                    <div style="display:flex; gap:8px;">
                        <select id="jobs-set-select" style="flex:1;">
                            <option value="">Choose a set...</option>
                            ${state.sets.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
                        </select>
                        <button class="btn btn-primary" id="jobs-start-set-btn">Refresh set</button>
                    </div>
                </div>
                <div style="min-width:280px; position:relative;">
                    <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:4px;">By card</label>
                    <div style="display:flex; gap:8px;">
                        <input type="text" id="jobs-card-search" placeholder="Search card name..." style="flex:1;" autocomplete="off" />
                        <button class="btn btn-primary" id="jobs-start-card-btn" disabled>Refresh card</button>
                    </div>
                    <div id="jobs-card-results" style="position:absolute; top:100%; left:0; right:70px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px; max-height:220px; overflow-y:auto; z-index:10; display:none;"></div>
                </div>
            </div>
            <div id="jobs-start-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
        </div>

        <div style="border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:24px;">
            <h3 style="margin:0 0 6px;">Import cards from Excel</h3>
            <p style="color:var(--text-secondary); font-size:12px; margin:0 0 14px;">
                Upload a filled-out spreadsheet (see docs/plans/card_import_template.xlsx in the
                Card-Board-MasterMind repo for the expected columns) — matches each row to your
                catalog, falls back to a live PokemonTCG API search, then creates the card
                directly from the sheet as a last resort. Lands in staging just like any other
                import; review/approve from the Staging Review page afterward.
            </p>
            <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
                <input type="file" id="jobs-excel-file" accept=".xlsx" />
                <label style="font-size:12px; color:var(--text-secondary); display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="jobs-excel-dryrun" checked /> Dry run (preview only, writes nothing)
                </label>
                <button class="btn btn-primary" id="jobs-start-excel-btn">Start import</button>
            </div>
            <div id="jobs-excel-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
        </div>

        <h3 style="margin:0 0 8px;">Recent jobs</h3>
        <div id="jobs-list-wrap"><p style="color:var(--text-secondary);">Loading...</p></div>
    `;

    wireStartControls(container);
    await refreshJobsList(container);
}

function wireStartControls(container) {
    const searchInput = container.querySelector('#jobs-card-search');
    const resultsBox = container.querySelector('#jobs-card-results');
    const cardBtn = container.querySelector('#jobs-start-card-btn');
    const errBox = container.querySelector('#jobs-start-error');

    let searchDebounce;
    searchInput.addEventListener('input', () => {
        state.selectedCard = null;
        cardBtn.disabled = true;
        clearTimeout(searchDebounce);
        const q = searchInput.value.trim();
        if (!q) { resultsBox.style.display = 'none'; return; }
        searchDebounce = setTimeout(async () => {
            const { data, error } = await supabase
                .from('card_master')
                .select('id, name, card_number, card_sets(name)')
                .ilike('name', `%${q}%`)
                .limit(25);
            if (error) { console.error(error); return; }
            state.cardResults = data || [];
            resultsBox.innerHTML = state.cardResults.length
                ? state.cardResults.map(c => `
                    <div class="jobs-card-result" data-id="${c.id}" data-label="${escapeHtml(`${c.name} (${c.card_sets?.name || '?'} #${c.card_number})`)}"
                         style="padding:6px 10px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);">
                        ${escapeHtml(c.name)} <span style="color:var(--text-secondary);">— ${escapeHtml(c.card_sets?.name || '?')} #${escapeHtml(c.card_number)}</span>
                    </div>
                `).join('')
                : `<div style="padding:6px 10px; font-size:13px; color:var(--text-secondary);">No matches.</div>`;
            resultsBox.style.display = 'block';

            resultsBox.querySelectorAll('.jobs-card-result').forEach(el => {
                el.addEventListener('click', () => {
                    state.selectedCard = { id: el.dataset.id, label: el.dataset.label };
                    searchInput.value = el.dataset.label;
                    resultsBox.style.display = 'none';
                    cardBtn.disabled = false;
                });
            });
        }, 300);
    });

    container.querySelector('#jobs-start-set-btn').addEventListener('click', async () => {
        errBox.textContent = '';
        const setName = container.querySelector('#jobs-set-select').value;
        if (!setName) { errBox.textContent = 'Choose a set first.'; return; }
        try {
            await apiPost('/api/jobs/market-price-refresh', { set_name: setName });
        } catch (err) {
            errBox.textContent = `Failed to start job: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?`;
            return;
        }
        await refreshJobsList(container);
    });

    cardBtn.addEventListener('click', async () => {
        errBox.textContent = '';
        if (!state.selectedCard) { errBox.textContent = 'Pick a card from the search results first.'; return; }
        try {
            await apiPost('/api/jobs/market-price-refresh', { card_id: state.selectedCard.id });
        } catch (err) {
            errBox.textContent = `Failed to start job: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?`;
            return;
        }
        searchInput.value = '';
        state.selectedCard = null;
        cardBtn.disabled = true;
        await refreshJobsList(container);
    });

    const excelErrBox = container.querySelector('#jobs-excel-error');
    container.querySelector('#jobs-start-excel-btn').addEventListener('click', async () => {
        excelErrBox.textContent = '';
        const fileInput = container.querySelector('#jobs-excel-file');
        const dryRun = container.querySelector('#jobs-excel-dryrun').checked;
        const file = fileInput.files[0];
        if (!file) { excelErrBox.textContent = 'Choose a spreadsheet first.'; return; }

        const form = new FormData();
        form.append('file', file);
        form.append('dry_run', String(dryRun));

        try {
            const resp = await fetch(`${PICKING_API_URL}/api/jobs/excel-import`, {
                method: 'POST',
                headers: { 'x-picking-token': PICKING_API_TOKEN },
                body: form,
            });
            if (!resp.ok) {
                const detail = await resp.text().catch(() => '');
                throw new Error(`${resp.status} ${detail}`);
            }
        } catch (err) {
            excelErrBox.textContent = `Failed to start import: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?`;
            return;
        }
        fileInput.value = '';
        await refreshJobsList(container);
    });
}

function jobStatusBadge(status) {
    const colors = {
        running: 'var(--accent)',
        done: 'var(--success)',
        failed: 'var(--danger)',
    };
    return `<span style="color:${colors[status] || 'var(--text-secondary)'}; font-weight:600; font-size:12px;">${escapeHtml(status)}</span>`;
}

function jobProgressText(job) {
    const p = job.progress || {};
    if (job.job_type === 'market_price_refresh' && p.total != null) {
        const parts = [`${p.done ?? 0}/${p.total} cards`];
        if (p.variants_updated != null) parts.push(`${p.variants_updated} prices updated`);
        if (p.failed) parts.push(`${p.failed} failed`);
        return parts.join(' · ');
    }
    if (job.job_type === 'excel_import') {
        if (p.phase === 'parsing') return 'Parsing spreadsheet...';
        if (p.phase === 'api_lookup') return `Checking PokemonTCG API: ${p.done ?? 0}/${p.total ?? '?'}`;
        if (p.phase === 'writing') return 'Writing to staging...';
        if (p.phase === 'done' || job.result) {
            const r = job.result || p;
            if (r.error) return r.error;
            const created = (r.created_api ?? 0) + (r.created_manual ?? 0);
            return `${r.staged ?? 0} staged · ${r.matched ?? 0} matched (${created} new) · `
                + `${r.ambiguous ?? 0} ambiguous · ${r.skipped ?? 0} skipped`;
        }
    }
    if (job.status === 'failed' && job.error) return job.error;
    return '-';
}

function fmtTime(epochSeconds) {
    if (!epochSeconds) return '-';
    return new Date(epochSeconds * 1000).toLocaleTimeString();
}

async function refreshJobsList(container) {
    const wrap = container.querySelector('#jobs-list-wrap');
    try {
        const { jobs } = await apiGet('/api/jobs');
        state.jobs = jobs || [];
    } catch (err) {
        wrap.innerHTML = `<p style="color:var(--danger);">Failed to load jobs: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?</p>`;
        return;
    }

    if (!state.jobs.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary);">No jobs have been run yet.</p>`;
    } else {
        wrap.innerHTML = `
            <table>
                <thead><tr><th>Job</th><th>Status</th><th>Progress</th><th>Started</th><th>Finished</th></tr></thead>
                <tbody>
                    ${state.jobs.map(j => `
                        <tr>
                            <td>${escapeHtml(j.label)}</td>
                            <td>${jobStatusBadge(j.status)}</td>
                            <td style="font-size:12px; color:var(--text-secondary);">${escapeHtml(jobProgressText(j))}</td>
                            <td style="font-size:12px;">${fmtTime(j.started_at)}</td>
                            <td style="font-size:12px;">${fmtTime(j.finished_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    // Keep polling only while something in the list is still running —
    // avoids an unbounded background timer once everything's settled.
    clearTimeout(state.pollTimer);
    const anyRunning = state.jobs.some(j => j.status === 'running');
    if (anyRunning && document.body.contains(wrap)) {
        state.pollTimer = setTimeout(() => refreshJobsList(container), POLL_INTERVAL_MS);
    }
}
