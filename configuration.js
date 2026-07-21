// configuration.js
// Configuration section — Sets, Card games, Pricing rules, Listing templates.
// Follows the same renderX(container) pattern used by inventory.js / staging-review.js.

import { supabase, debounce } from './shared.js';

let state = {
    sets: [],
    games: [],
    setCounts: {},   // set_id -> count of card_master rows
    search: '',
    loading: true,
    error: null,
};

let gameState = {
    games: [],
    gameSetCounts: {},  // game_id -> count of card_sets rows
    search: '',
};

let pricingState = {
    tab: 'tiers',          // 'tiers' | 'set-config' | 'overrides' | 'card-type-mapping'
    tiers: [],
    setConfigs: [],
    overrides: [],
    cardTypeMappings: [],
    sets: [],
    cardSearch: '',
    cardResults: [],
};

// tier_card_type domain used by both price_tiers and card_type_mapping
const TIER_CARD_TYPES = ['common', 'holo', 'reverse_holo', 'ultra_rare_rule'];

let templatesState = {
    templates: [],
};

let syncControlsState = {
    statuses: [],
};

let profilesState = {
    profiles: [],
};

// The 7 variant lookup tables card_variants references by `code` — all
// share the identical (code, display_name, sort_order) shape, so one
// generic CRUD component handles all of them instead of 7 near-copies.
const ATTR_TABLES = [
    { table: 'foil_types',    label: 'Foil Types',    variantColumn: 'foil_type' },
    { table: 'foil_patterns', label: 'Foil Patterns', variantColumn: 'foil_pattern' },
    { table: 'textures',      label: 'Textures',      variantColumn: 'texture' },
    { table: 'materials',     label: 'Materials',     variantColumn: 'material' },
    { table: 'sizes',         label: 'Sizes',          variantColumn: 'size' },
    { table: 'stamp_types',   label: 'Stamp Types',    variantColumn: 'stamp_type' },
    { table: 'source_types',  label: 'Source Types',   variantColumn: 'source_type' },
];

let attrState = {
    activeTable: 'foil_types',
    rows: [],
    usageCounts: {},   // code -> count of card_variants rows using it
    search: '',
};

export async function renderConfiguration(container, initialKey = 'sets') {
    if (initialKey === 'sets') {
        state = { sets: [], games: [], setCounts: {}, search: '', loading: true, error: null };
        container.innerHTML = configShell(setsSectionHTML());
        wireConfigNav(container, 'sets');
        await loadSets(container);
    } else if (initialKey === 'card-games') {
        gameState = { games: [], gameSetCounts: {}, search: '' };
        container.innerHTML = configShell(gamesSectionHTML());
        wireConfigNav(container, 'card-games');
        await loadGames(container);
    } else if (initialKey === 'pricing-rules') {
        pricingState = { tab: 'tiers', tiers: [], setConfigs: [], overrides: [], cardTypeMappings: [], sets: [], cardSearch: '', cardResults: [] };
        container.innerHTML = configShell(pricingSectionHTML());
        wireConfigNav(container, 'pricing-rules');
        await loadPricing(container);
    } else if (initialKey === 'listing-templates') {
        templatesState = { templates: [] };
        container.innerHTML = configShell(templatesSectionHTML());
        wireConfigNav(container, 'listing-templates');
        await loadTemplates(container);
    } else if (initialKey === 'variant-attributes') {
        attrState = { activeTable: 'foil_types', rows: [], usageCounts: {}, search: '' };
        container.innerHTML = configShell(attrSectionHTML());
        wireConfigNav(container, 'variant-attributes');
        wireAttrTabs(container);
        await loadAttrTable(container);
    } else if (initialKey === 'sync-controls') {
        syncControlsState = { statuses: [] };
        container.innerHTML = configShell(syncControlsSectionHTML());
        wireConfigNav(container, 'sync-controls');
        await loadSyncControls(container);
    } else if (initialKey === 'pricing-profiles') {
        profilesState = { profiles: [] };
        container.innerHTML = configShell(profilesSectionHTML());
        wireConfigNav(container, 'pricing-profiles');
        await loadProfiles(container);
    } else {
        container.innerHTML = configShell(`<p style="color:var(--text-secondary)">${labelFor(initialKey)} coming soon.</p>`);
        wireConfigNav(container, initialKey);
    }
}

// ── Shared configuration shell ──────────────────────────────────────────────
// Renders the left sub-nav (Sets / Card games / Pricing rules / Listing
// templates) plus a content slot. Other configuration pages can reuse this.

function configShell(bodyHTML) {
    return `
        <div style="display:flex; gap:24px;">
            <div style="width:180px; flex-shrink:0;">
                <div style="font-size:12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.03em; padding:0 4px 8px;">Configuration</div>
                <a href="#sets" data-config-nav="sets" class="config-nav-item">Sets</a>
                <a href="#card-games" data-config-nav="card-games" class="config-nav-item">Card games</a>
                <a href="#pricing-rules" data-config-nav="pricing-rules" class="config-nav-item">Pricing rules</a>
                <a href="#listing-templates" data-config-nav="listing-templates" class="config-nav-item">Listing templates</a>
                <a href="#pricing-profiles" data-config-nav="pricing-profiles" class="config-nav-item">Pricing profiles</a>
                <a href="#variant-attributes" data-config-nav="variant-attributes" class="config-nav-item">Variant attributes</a>
                <a href="#sync-controls" data-config-nav="sync-controls" class="config-nav-item">Sync controls</a>
            </div>
            <div style="flex:1; min-width:0;" id="config-body">
                ${bodyHTML}
            </div>
        </div>
        <style>
            .config-nav-item {
                display:block;
                padding:8px 10px;
                margin-bottom:2px;
                border-radius:6px;
                color:var(--text-secondary);
                text-decoration:none;
                font-size:13px;
            }
            .config-nav-item:hover { background:var(--bg-tertiary); color:var(--text); }
            .config-nav-item.active { background:var(--bg-tertiary); color:var(--accent); }
        </style>
    `;
}

function wireConfigNav(container, activeKey) {
    container.querySelectorAll('.config-nav-item').forEach(a => {
        a.classList.toggle('active', a.dataset.configNav === activeKey);
        a.addEventListener('click', async (e) => {
            e.preventDefault();
            const key = a.dataset.configNav;
            if (key === activeKey) return;
            if (key === 'sets') {
                await renderConfiguration(container);
            } else if (key === 'card-games') {
                await renderConfiguration(container, 'card-games');
            } else if (key === 'pricing-rules') {
                await renderConfiguration(container, 'pricing-rules');
            } else if (key === 'listing-templates') {
                await renderConfiguration(container, 'listing-templates');
            } else if (key === 'variant-attributes') {
                await renderConfiguration(container, 'variant-attributes');
            } else if (key === 'sync-controls') {
                await renderConfiguration(container, 'sync-controls');
            } else if (key === 'pricing-profiles') {
                await renderConfiguration(container, 'pricing-profiles');
            } else {
                // Other configuration sub-pages land here later.
                container.innerHTML = configShell(`<p style="color:var(--text-secondary)">${labelFor(key)} coming soon.</p>`);
                wireConfigNav(container, key);
            }
        });
    });
}

function labelFor(key) {
    return {
        'card-games': 'Card games',
        'pricing-rules': 'Pricing rules',
        'listing-templates': 'Listing templates',
        'sync-controls': 'Sync controls',
        'pricing-profiles': 'Pricing profiles',
    }[key] || key;
}

// ── Sets section ─────────────────────────────────────────────────────────────

function setsSectionHTML() {
    return `
        <div class="filters-bar" style="justify-content:space-between;">
            <input type="search" id="sets-search" placeholder="Search sets..." style="min-width:240px;" />
            <button class="btn btn-primary" id="new-set-btn">+ New set</button>
        </div>
        <div id="sets-table-wrap"><p>Loading...</p></div>
        <div id="set-modal-root"></div>
    `;
}

async function loadSets(container) {
    const wrap = container.querySelector('#sets-table-wrap');
    try {
        const [{ data: sets, error: setsErr }, { data: games, error: gamesErr }, { data: masterRows, error: masterErr }] =
            await Promise.all([
                supabase.from('card_sets').select('*').order('name'),
                supabase.from('card_games').select('id, name'),
                supabase.from('card_master').select('set_id'),
            ]);

        if (setsErr) throw setsErr;
        if (gamesErr) throw gamesErr;
        if (masterErr) throw masterErr;

        const counts = {};
        for (const row of masterRows || []) {
            counts[row.set_id] = (counts[row.set_id] || 0) + 1;
        }

        state.sets = sets || [];
        state.games = games || [];
        state.setCounts = counts;
        state.loading = false;

        renderTable(container);
        wireSetsControls(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load sets: ${err.message}</p>`;
    }
}

function renderTable(container) {
    const wrap = container.querySelector('#sets-table-wrap');
    const gameNameById = Object.fromEntries(state.games.map(g => [g.id, g.name]));

    const q = state.search.trim().toLowerCase();
    const rows = state.sets.filter(s =>
        !q || s.name.toLowerCase().includes(q) || (s.set_code || '').toLowerCase().includes(q)
    );

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No sets found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Set name</th>
                    <th>Game</th>
                    <th>Code</th>
                    <th>Series</th>
                    <th>Year</th>
                    <th>Cards</th>
                    <th style="width:60px;"></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(s => `
                    <tr data-set-id="${s.id}">
                        <td>${escapeHTML(s.name)}</td>
                        <td>${escapeHTML(gameNameById[s.game_id] || '-')}</td>
                        <td>${escapeHTML(s.set_code || '-')}</td>
                        <td>${escapeHTML(s.series || '-')}</td>
                        <td>${s.release_year || '-'}</td>
                        <td>${state.setCounts[s.id] || 0}${s.total_cards ? ' / ' + s.total_cards : ''}</td>
                        <td><button class="btn edit-set-btn" data-id="${s.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('.edit-set-btn').forEach(btn => {
        btn.addEventListener('click', () => openSetModal(container, btn.dataset.id));
    });
}

async function confirmDeleteSet(container, setId) {
    const set = state.sets.find(s => s.id === setId);
    if (!set) return;

    const cardCount = state.setCounts[setId] || 0;
    const warning = cardCount > 0
        ? `"${set.name}" has ${cardCount} card${cardCount === 1 ? '' : 's'} linked to it in card_master. Deleting the set will fail unless those cards are removed or reassigned first.\n\nTry to delete anyway?`
        : `Delete "${set.name}"? This can't be undone.`;

    if (!window.confirm(warning)) return;

    try {
        const { error } = await supabase.from('card_sets').delete().eq('id', setId);
        if (error) throw error;
        await loadSets(container);
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        const msg = isFkViolation
            ? `Can't delete "${set.name}" — it still has cards referencing it in card_master. Remove or reassign those cards first.`
            : `Failed to delete set: ${err.message}`;
        window.alert(msg);
    }
}

function wireSetsControls(container) {
    const searchInput = container.querySelector('#sets-search');
    searchInput.value = state.search;
    searchInput.addEventListener('input', debounce((e) => {
        state.search = e.target.value;
        renderTable(container);
    }, 200));

    container.querySelector('#new-set-btn').addEventListener('click', () => openSetModal(container, null));
}

// ── Create / edit modal ──────────────────────────────────────────────────────

function openSetModal(container, setId) {
    const isEdit = !!setId;
    const existing = isEdit ? state.sets.find(s => s.id === setId) : null;
    const root = container.querySelector('#set-modal-root');

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 16px;">${isEdit ? 'Edit set' : 'New set'}</h3>
                <form id="set-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Game
                            <select name="game_id" required style="width:100%; margin-top:4px;">
                                ${state.games.map(g => `<option value="${g.id}" ${existing && existing.game_id === g.id ? 'selected' : ''}>${escapeHTML(g.name)}</option>`).join('')}
                            </select>
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Set name
                            <input type="text" name="name" required value="${existing ? escapeAttr(existing.name) : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Set code
                            <input type="text" name="set_code" required value="${existing ? escapeAttr(existing.set_code || '') : ''}" style="width:100%; margin-top:4px;" placeholder="e.g. sv8pt5" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Series
                            <input type="text" name="series" value="${existing ? escapeAttr(existing.series || '') : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                        <div style="display:flex; gap:10px;">
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">
                                Release year
                                <input type="number" name="release_year" value="${existing ? (existing.release_year || '') : ''}" style="width:100%; margin-top:4px;" />
                            </label>
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">
                                Total cards
                                <input type="number" name="total_cards" value="${existing ? (existing.total_cards || '') : ''}" style="width:100%; margin-top:4px;" />
                            </label>
                        </div>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Language
                            <input type="text" name="language" value="${existing ? escapeAttr(existing.language || 'English') : 'English'}" style="width:100%; margin-top:4px;" />
                        </label>
                        <div style="border-top:1px solid var(--border); margin-top:4px; padding-top:10px;">
                            <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.03em; color:var(--text-secondary); margin-bottom:8px;">Card numbering</div>
                            <div style="display:flex; flex-direction:column; gap:10px;">
                                <label style="font-size:12px; color:var(--text-secondary);">
                                    Base set number
                                    <input type="text" name="base_set_number" value="${existing ? escapeAttr(existing.base_set_number || '') : ''}" style="width:100%; margin-top:4px;" />
                                </label>
                                <label style="font-size:12px; color:var(--text-secondary);">
                                    On-card code
                                    <input type="text" name="on_card_code" value="${existing ? escapeAttr(existing.on_card_code || '') : ''}" style="width:100%; margin-top:4px;" />
                                </label>
                                <label style="font-size:12px; color:var(--text-secondary);">
                                    Set prefix
                                    <input type="text" name="set_prefix" value="${existing ? escapeAttr(existing.set_prefix || '') : ''}" style="width:100%; margin-top:4px;" />
                                </label>
                            </div>
                        </div>
                    </div>
                    <div id="set-form-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="set-modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete set</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="set-modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create set'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    root.querySelector('#set-modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    if (isEdit) {
        root.querySelector('#set-modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDeleteSet(container, setId);
        });
    }

    root.querySelector('#set-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#set-form-error');
        errBox.textContent = '';

        const fd = new FormData(e.target);
        const payload = {
            game_id: fd.get('game_id'),
            name: fd.get('name').trim(),
            set_code: fd.get('set_code').trim(),
            series: fd.get('series').trim() || null,
            release_year: fd.get('release_year') ? parseInt(fd.get('release_year'), 10) : null,
            total_cards: fd.get('total_cards') ? parseInt(fd.get('total_cards'), 10) : null,
            language: fd.get('language').trim() || 'English',
            base_set_number: fd.get('base_set_number').trim() || null,
            on_card_code: fd.get('on_card_code').trim() || null,
            set_prefix: fd.get('set_prefix').trim() || null,
        };

        try {
            if (isEdit) {
                const { error } = await supabase.from('card_sets').update(payload).eq('id', setId);
                if (error) throw error;
            } else {
                const { error } = await supabase.from('card_sets').insert(payload);
                if (error) throw error;
            }
            root.innerHTML = '';
            await loadSets(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save set.';
        }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function escapeAttr(str) {
    return escapeHTML(str);
}

// ── Pricing rules section (3 sub-tabs: tiers / set-config / overrides) ──────

function pricingSectionHTML() {
    return `
        <div style="display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border);">
            <button class="pricing-tab-btn" data-tab="tiers">Price tiers</button>
            <button class="pricing-tab-btn" data-tab="set-config">Set pricing</button>
            <button class="pricing-tab-btn" data-tab="overrides">Card overrides</button>
            <button class="pricing-tab-btn" data-tab="card-type-mapping">Card type mapping</button>
        </div>
        <div id="pricing-tab-content"><p>Loading...</p></div>
        <div id="pricing-modal-root"></div>
        <style>
            .pricing-tab-btn {
                background:none; border:none; color:var(--text-secondary);
                padding:8px 14px; font-size:13px; cursor:pointer;
                border-bottom:2px solid transparent; margin-bottom:-1px;
            }
            .pricing-tab-btn:hover { color:var(--text); }
            .pricing-tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }
        </style>
    `;
}

async function loadPricing(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    try {
        const [{ data: tiers, error: tiersErr }, { data: setConfigs, error: scErr },
               { data: overrides, error: ovErr }, { data: mappings, error: mapErr },
               { data: sets, error: setsErr }] = await Promise.all([
            supabase.from('price_tiers').select('*').order('platform').order('card_type').order('sort_order'),
            supabase.from('set_pricing_config').select('*').order('created_at', { ascending: false }),
            supabase.from('card_pricing_overrides').select('*').order('updated_at', { ascending: false }),
            supabase.from('card_type_mapping').select('*').order('platform').order('rarity', { nullsFirst: true }),
            supabase.from('card_sets').select('id, name'),
        ]);
        if (tiersErr) throw tiersErr;
        if (scErr) throw scErr;
        if (ovErr) throw ovErr;
        if (mapErr) throw mapErr;
        if (setsErr) throw setsErr;

        pricingState.tiers = tiers || [];
        pricingState.setConfigs = setConfigs || [];
        pricingState.overrides = overrides || [];
        pricingState.cardTypeMappings = mappings || [];
        pricingState.sets = sets || [];

        wirePricingTabs(container);
        renderPricingTab(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load pricing data: ${err.message}</p>`;
    }
}

function wirePricingTabs(container) {
    container.querySelectorAll('.pricing-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === pricingState.tab);
        btn.addEventListener('click', () => {
            pricingState.tab = btn.dataset.tab;
            container.querySelectorAll('.pricing-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === pricingState.tab));
            renderPricingTab(container);
        });
    });
}

function renderPricingTab(container) {
    if (pricingState.tab === 'tiers') renderTiersTab(container);
    else if (pricingState.tab === 'set-config') renderSetConfigTab(container);
    else if (pricingState.tab === 'card-type-mapping') renderCardTypeMappingTab(container);
    else renderOverridesTab(container);
}

// -- Price tiers --

function renderTiersTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const rows = pricingState.tiers;

    wrap.innerHTML = `
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-tier-btn">+ New tier</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Platform</th><th>Account</th><th>Card type</th><th>Market price ≤</th><th>List price</th><th>Sort</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(t => `
                    <tr>
                        <td>${escapeHTML(t.platform)}</td>
                        <td>${t.account ? escapeHTML(t.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${escapeHTML(t.card_type)}</td>
                        <td>${formatPrice(t.market_price_max)}</td>
                        <td>${formatPrice(t.list_price)}</td>
                        <td>${t.sort_order}</td>
                        <td><button class="btn edit-tier-btn" data-id="${t.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No price tiers yet.</p>`}
    `;

    wrap.querySelector('#new-tier-btn').addEventListener('click', () => openTierModal(container, null));
    wrap.querySelectorAll('.edit-tier-btn').forEach(btn => {
        btn.addEventListener('click', () => openTierModal(container, btn.dataset.id));
    });
}

function openTierModal(container, tierId) {
    const isEdit = !!tierId;
    const existing = isEdit ? pricingState.tiers.find(t => t.id === tierId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit price tier' : 'New price tier', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('Card type', 'text', 'card_type', existing?.card_type || '', 'e.g. common, holo, reverse_holo')}
            ${field('Market price max ($)', 'number', 'market_price_max', existing?.market_price_max ?? '', '', '0.01')}
            ${field('List price ($)', 'number', 'list_price', existing?.list_price ?? '', '', '0.01')}
            ${field('Sort order', 'number', 'sort_order', existing?.sort_order ?? '')}
        </div>
    `, isEdit, 'tier');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'price_tiers', tierId, `this price tier`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            card_type: fd.get('card_type').trim(),
            market_price_max: parseFloat(fd.get('market_price_max')),
            list_price: parseFloat(fd.get('list_price')),
            sort_order: parseInt(fd.get('sort_order'), 10),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('price_tiers').update(payload).eq('id', tierId)
                : await supabase.from('price_tiers').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save price tier.';
        }
    });
}

// -- Set pricing config --

function renderSetConfigTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const setNameById = Object.fromEntries(pricingState.sets.map(s => [s.id, s.name]));
    const rows = pricingState.setConfigs;

    wrap.innerHTML = `
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-setconfig-btn">+ New set pricing rule</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Set</th><th>Platform</th><th>Account</th><th>Multiplier</th><th>Ultra rare rule</th><th>Era</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(sc => `
                    <tr>
                        <td>${escapeHTML(setNameById[sc.set_id] || sc.set_id)}</td>
                        <td>${escapeHTML(sc.platform)}</td>
                        <td>${sc.account ? escapeHTML(sc.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${sc.price_multiplier}x</td>
                        <td>${escapeHTML(sc.ultra_rare_rule)}</td>
                        <td>${escapeHTML(sc.era_tag || '-')}</td>
                        <td><button class="btn edit-setconfig-btn" data-id="${sc.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No set pricing rules yet.</p>`}
    `;

    wrap.querySelector('#new-setconfig-btn').addEventListener('click', () => openSetConfigModal(container, null));
    wrap.querySelectorAll('.edit-setconfig-btn').forEach(btn => {
        btn.addEventListener('click', () => openSetConfigModal(container, btn.dataset.id));
    });
}

function openSetConfigModal(container, configId) {
    const isEdit = !!configId;
    const existing = isEdit ? pricingState.setConfigs.find(sc => sc.id === configId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit set pricing rule' : 'New set pricing rule', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            <label style="font-size:12px; color:var(--text-secondary);">
                Set
                <select name="set_id" required style="width:100%; margin-top:4px;">
                    ${pricingState.sets.map(s => `<option value="${s.id}" ${existing?.set_id === s.id ? 'selected' : ''}>${escapeHTML(s.name)}</option>`).join('')}
                </select>
            </label>
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('Price multiplier', 'number', 'price_multiplier', existing?.price_multiplier ?? '1.00', '', '0.01')}
            <div style="display:flex; gap:10px;">
                ${field('Common floor ($)', 'number', 'common_floor', existing?.common_floor ?? '', '', '0.01', true)}
                ${field('Reverse holo floor ($)', 'number', 'reverse_holo_floor', existing?.reverse_holo_floor ?? '', '', '0.01', true)}
                ${field('Holo floor ($)', 'number', 'holo_floor', existing?.holo_floor ?? '', '', '0.01', true)}
            </div>
            <label style="font-size:12px; color:var(--text-secondary);">
                Ultra rare rule
                <select name="ultra_rare_rule" style="width:100%; margin-top:4px;">
                    ${['tier', 'manual', 'multiplier'].map(v => `<option value="${v}" ${existing?.ultra_rare_rule === v ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </label>
            <div style="display:flex; gap:10px;">
                ${field('Ultra rare multiplier', 'number', 'ultra_rare_multiplier', existing?.ultra_rare_multiplier ?? '2.00', '', '0.01', true)}
                ${field('Ultra rare plus ($)', 'number', 'ultra_rare_plus', existing?.ultra_rare_plus ?? '1.00', '', '0.01', true)}
            </div>
            <div style="display:flex; gap:10px;">
                ${field('Common max card #', 'number', 'common_max_card_num', existing?.common_max_card_num ?? '', '', '', true)}
                ${field('Set total cards', 'number', 'set_total_cards', existing?.set_total_cards ?? '', '', '', true)}
            </div>
            ${field('Era tag', 'text', 'era_tag', existing?.era_tag || '', 'popular, vintage, standard, rotation', '', true)}
            ${field('Notes', 'text', 'notes', existing?.notes || '', '', '', true)}
        </div>
    `, isEdit, 'setconfig');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'set_pricing_config', configId, `this set pricing rule`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const num = (name) => fd.get(name) ? parseFloat(fd.get(name)) : null;
        const int = (name) => fd.get(name) ? parseInt(fd.get(name), 10) : null;
        const payload = {
            set_id: fd.get('set_id'),
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            price_multiplier: parseFloat(fd.get('price_multiplier')) || 1.00,
            common_floor: num('common_floor'),
            reverse_holo_floor: num('reverse_holo_floor'),
            holo_floor: num('holo_floor'),
            ultra_rare_rule: fd.get('ultra_rare_rule'),
            ultra_rare_multiplier: num('ultra_rare_multiplier'),
            ultra_rare_plus: num('ultra_rare_plus'),
            common_max_card_num: int('common_max_card_num'),
            set_total_cards: int('set_total_cards'),
            era_tag: fd.get('era_tag').trim() || null,
            notes: fd.get('notes').trim() || null,
            updated_at: new Date().toISOString(),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('set_pricing_config').update(payload).eq('id', configId)
                : await supabase.from('set_pricing_config').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save set pricing rule.';
        }
    });
}

// -- Card pricing overrides --

function renderOverridesTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const rows = pricingState.overrides;

    wrap.innerHTML = `
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-override-btn">+ New card override</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Card ID</th><th>Platform</th><th>Account</th><th>List price</th><th>Notes</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(o => `
                    <tr>
                        <td style="font-family:monospace; font-size:12px;">${o.card_id}</td>
                        <td>${escapeHTML(o.platform)}</td>
                        <td>${o.account ? escapeHTML(o.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${formatPrice(o.list_price)}</td>
                        <td style="color:var(--text-secondary);">${escapeHTML(o.notes || '-')}</td>
                        <td><button class="btn edit-override-btn" data-id="${o.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No card price overrides yet.</p>`}
        <p style="color:var(--text-secondary); font-size:12px; margin-top:8px;">Note: card overrides currently reference card_master by UUID directly — a proper card search/picker can be added once the Catalog page exists.</p>
    `;

    wrap.querySelector('#new-override-btn').addEventListener('click', () => openOverrideModal(container, null));
    wrap.querySelectorAll('.edit-override-btn').forEach(btn => {
        btn.addEventListener('click', () => openOverrideModal(container, btn.dataset.id));
    });
}

function openOverrideModal(container, overrideId) {
    const isEdit = !!overrideId;
    const existing = isEdit ? pricingState.overrides.find(o => o.id === overrideId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit card override' : 'New card override', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Card ID (UUID)', 'text', 'card_id', existing?.card_id || '', 'paste card_master.id')}
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('List price ($)', 'number', 'list_price', existing?.list_price ?? '', '', '0.01')}
            ${field('Notes', 'text', 'notes', existing?.notes || '', '', '', true)}
        </div>
    `, isEdit, 'override');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'card_pricing_overrides', overrideId, `this card override`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            card_id: fd.get('card_id').trim(),
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            list_price: parseFloat(fd.get('list_price')),
            notes: fd.get('notes').trim() || null,
            updated_at: new Date().toISOString(),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('card_pricing_overrides').update(payload).eq('id', overrideId)
                : await supabase.from('card_pricing_overrides').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save card override. Check that the Card ID is a valid card_master UUID.';
        }
    });
}

// -- Card type mapping (rarity + variant_key -> tier_card_type) --------------
// Resolved most-specific-first by importer/ebay_listing_sync.py's
// resolve_tier_card_type(): a row with BOTH rarity and variant_key set
// beats a row with only one set, which beats the all-NULL wildcard.
// `--ebay-recalc-prices --dry-run` flags any card that only matched the
// wildcard row, so new/unmapped rarities don't silently price as common.

function renderCardTypeMappingTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const rows = pricingState.cardTypeMappings;

    wrap.innerHTML = `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Maps a card's rarity (and optionally a variant_key pattern, for
            overrides like reverse-holo) to a pricing tier. Most-specific
            match wins: rarity + variant_key beats rarity-only beats the
            wildcard (blank rarity, blank variant_key) row. Cards that only
            match the wildcard are flagged in <code>--ebay-recalc-prices
            --dry-run</code> output — add a row here for any rarity that
            keeps showing up flagged.
        </p>
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-mapping-btn">+ New mapping</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Platform</th><th>Account</th><th>Rarity</th><th>Variant key pattern</th><th>Tier</th><th>Priority</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(m => `
                    <tr>
                        <td>${escapeHTML(m.platform)}</td>
                        <td>${m.account ? escapeHTML(m.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${m.rarity ? escapeHTML(m.rarity) : '<span style="color:var(--text-secondary);">Any (wildcard)</span>'}</td>
                        <td><code>${m.variant_key ? escapeHTML(m.variant_key) : '(any)'}</code></td>
                        <td>${escapeHTML(m.tier_card_type)}</td>
                        <td>${m.priority}</td>
                        <td><button class="btn edit-mapping-btn" data-id="${m.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No card type mappings yet.</p>`}
    `;

    wrap.querySelector('#new-mapping-btn').addEventListener('click', () => openCardTypeMappingModal(container, null));
    wrap.querySelectorAll('.edit-mapping-btn').forEach(btn => {
        btn.addEventListener('click', () => openCardTypeMappingModal(container, btn.dataset.id));
    });
}

function openCardTypeMappingModal(container, mappingId) {
    const isEdit = !!mappingId;
    const existing = isEdit ? pricingState.cardTypeMappings.find(m => m.id === mappingId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit card type mapping' : 'New card type mapping', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('Rarity (blank = wildcard, matches any)', 'text', 'rarity', existing?.rarity || '', 'e.g. Illustration Rare', '', true)}
            ${field('Variant key pattern (blank = any; % wildcards allowed)', 'text', 'variant_key', existing?.variant_key || '', 'e.g. %reverse_holo%', '', true)}
            <label style="font-size:12px; color:var(--text-secondary);">
                Tier
                <select name="tier_card_type" required style="width:100%; margin-top:4px;">
                    ${TIER_CARD_TYPES.map(v => `<option value="${v}" ${existing?.tier_card_type === v ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </label>
            ${field('Priority (tie-break within equal specificity — higher wins)', 'number', 'priority', existing?.priority ?? '10')}
        </div>
    `, isEdit, 'mapping');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'card_type_mapping', mappingId, `this card type mapping`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            rarity: fd.get('rarity').trim() || null,
            variant_key: fd.get('variant_key').trim() || null,
            tier_card_type: fd.get('tier_card_type'),
            priority: parseInt(fd.get('priority'), 10) || 10,
        };
        try {
            const { error } = isEdit
                ? await supabase.from('card_type_mapping').update(payload).eq('id', mappingId)
                : await supabase.from('card_type_mapping').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save card type mapping.';
        }
    });
}

// ── Listing templates section ───────────────────────────────────────────────

function templatesSectionHTML() {
    return `
        <div class="filters-bar" style="justify-content:flex-end;">
            <button class="btn btn-primary" id="new-template-btn">+ New template</button>
        </div>
        <div id="templates-table-wrap"><p>Loading...</p></div>
        <div id="template-modal-root"></div>
    `;
}

async function loadTemplates(container) {
    const wrap = container.querySelector('#templates-table-wrap');
    try {
        const { data, error } = await supabase.from('listing_templates').select('*').order('platform').order('name');
        if (error) throw error;
        templatesState.templates = data || [];
        renderTemplatesTable(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load listing templates: ${err.message}</p>`;
    }
}

function renderTemplatesTable(container) {
    const wrap = container.querySelector('#templates-table-wrap');
    const rows = templatesState.templates;

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No listing templates yet.</p>`;
    } else {
        wrap.innerHTML = `
            <table>
                <thead><tr>
                    <th>Name</th><th>Platform</th><th>Account</th><th>Kind</th><th>Included types</th><th>Card # range</th><th>Shipping</th><th>Max qty</th><th>Base price</th><th>Priority / Display sort</th><th style="width:60px;"></th>
                </tr></thead>
                <tbody>
                    ${rows.map(t => `
                        <tr>
                            <td>${escapeHTML(t.name)}</td>
                            <td>${escapeHTML(t.platform)}</td>
                            <td>${t.account ? escapeHTML(t.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                            <td>${escapeHTML(t.listing_kind || 'variation')}</td>
                            <td style="color:var(--text-secondary); font-size:12px;">${(t.included_types || []).map(escapeHTML).join(', ') || '-'}</td>
                            <td>${t.card_num_min ?? '-'} – ${t.card_num_max ?? '-'}</td>
                            <td>${formatPrice(t.shipping_base)} + ${formatPrice(t.shipping_per_card)}/card</td>
                            <td>${t.max_quantity}</td>
                            <td>${formatPrice(t.base_price)}</td>
                            <td style="color:var(--text-secondary); font-size:12px;">${escapeHTML(t.priority_rule || 'card_number')} / ${escapeHTML(t.display_sort || 'card_number')}</td>
                            <td><button class="btn edit-template-btn" data-id="${t.id}">Edit</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    container.querySelector('#new-template-btn').addEventListener('click', () => openTemplateModal(container, null));
    wrap.querySelectorAll('.edit-template-btn').forEach(btn => {
        btn.addEventListener('click', () => openTemplateModal(container, btn.dataset.id));
    });
}

function openTemplateModal(container, templateId) {
    const isEdit = !!templateId;
    const existing = isEdit ? templatesState.templates.find(t => t.id === templateId) : null;
    const root = container.querySelector('#template-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit listing template' : 'New listing template', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('Name', 'text', 'name', existing?.name || '', 'e.g. commons')}
            ${field('Description', 'text', 'description', existing?.description || '', '', '', true)}
            ${field('Included types (comma-separated)', 'text', 'included_types', (existing?.included_types || []).join(', '), 'common, holo, double_rare')}
            ${field('Excluded types (comma-separated)', 'text', 'excluded_types', (existing?.excluded_types || []).join(', '), '', '', true)}
            <div style="display:flex; gap:10px;">
                ${field('Card # min', 'number', 'card_num_min', existing?.card_num_min ?? '', '', '', true)}
                ${field('Card # max', 'number', 'card_num_max', existing?.card_num_max ?? '', '', '', true)}
            </div>
            <div style="display:flex; gap:10px;">
                ${field('Shipping base ($)', 'number', 'shipping_base', existing?.shipping_base ?? '0.00', '', '0.01')}
                ${field('Shipping per card ($)', 'number', 'shipping_per_card', existing?.shipping_per_card ?? '0.00', '', '0.01')}
            </div>
            ${field('Max quantity', 'number', 'max_quantity', existing?.max_quantity ?? '250')}

            <div style="border-top:1px solid var(--border); margin-top:4px; padding-top:10px;">
                <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.03em; color:var(--text-secondary); margin-bottom:8px;">
                    Sync engine settings (docs/plans/ebay-listing-sync.md)
                </div>
                <div style="display:flex; flex-direction:column; gap:10px;">
                    <label style="font-size:12px; color:var(--text-secondary);">
                        Listing kind
                        <select name="listing_kind" style="width:100%; margin-top:4px;">
                            <option value="variation" ${(existing?.listing_kind || 'variation') === 'variation' ? 'selected' : ''}>variation (multi-variation listing)</option>
                            <option value="single" ${existing?.listing_kind === 'single' ? 'selected' : ''}>single (one card per listing)</option>
                        </select>
                    </label>
                    ${field('Base price ($) — sync price floor, raise-only', 'number', 'base_price', existing?.base_price ?? '', '', '0.01', true)}
                    ${field('Default quantity limit (per variation)', 'number', 'default_quantity_limit', existing?.default_quantity_limit ?? '', '', '', true)}
                    <div style="display:flex; gap:10px;">
                        ${field('Low-stock threshold', 'number', 'low_stock_threshold', existing?.low_stock_threshold ?? '8', '', '', true)}
                        ${field('Low-stock bump ($)', 'number', 'low_stock_bump', existing?.low_stock_bump ?? '1', '', '0.01', true)}
                    </div>
                    <label style="font-size:12px; color:var(--text-secondary);">
                        Promotion priority (250-cap queue order)
                        <select name="priority_rule" style="width:100%; margin-top:4px;">
                            <option value="card_number" ${(existing?.priority_rule || 'card_number') === 'card_number' ? 'selected' : ''}>card_number (plain numeric)</option>
                            <option value="rh_then_number_holo_last" ${existing?.priority_rule === 'rh_then_number_holo_last' ? 'selected' : ''}>rh_then_number_holo_last (reverse holo first, then number, holo last)</option>
                        </select>
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">
                        Display sort (buyer-facing dropdown order)
                        <select name="display_sort" style="width:100%; margin-top:4px;">
                            <option value="card_number" ${(existing?.display_sort || 'card_number') === 'card_number' ? 'selected' : ''}>card_number</option>
                            <option value="alpha" ${existing?.display_sort === 'alpha' ? 'selected' : ''}>alpha</option>
                            <option value="release_date" ${existing?.display_sort === 'release_date' ? 'selected' : ''}>release_date (reserved — future themed listings)</option>
                        </select>
                    </label>
                    ${field('Name format', 'text', 'name_format', existing?.name_format || '{number}/{set_total} {name} {suffix}', '', '', true)}
                    ${field('Card type filter (comma-separated tier types; blank = all)', 'text', 'card_type_filter', (existing?.card_type_filter || []).join(', '), 'common, holo, reverse_holo, ultra_rare_rule', '', true)}
                </div>
            </div>
        </div>
    `, isEdit, 'template');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'listing_templates', templateId, `this listing template`, () => loadTemplates(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const splitList = (name) => {
            const raw = fd.get(name).trim();
            return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
        };
        const num = (name) => fd.get(name) ? parseFloat(fd.get(name)) : null;
        const int = (name) => fd.get(name) ? parseInt(fd.get(name), 10) : null;
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            name: fd.get('name').trim(),
            description: fd.get('description').trim() || null,
            included_types: splitList('included_types'),
            excluded_types: splitList('excluded_types'),
            card_num_min: fd.get('card_num_min') ? parseInt(fd.get('card_num_min'), 10) : null,
            card_num_max: fd.get('card_num_max') ? parseInt(fd.get('card_num_max'), 10) : null,
            shipping_base: parseFloat(fd.get('shipping_base')) || 0,
            shipping_per_card: parseFloat(fd.get('shipping_per_card')) || 0,
            max_quantity: parseInt(fd.get('max_quantity'), 10) || 250,
            listing_kind: fd.get('listing_kind') || 'variation',
            base_price: num('base_price'),
            default_quantity_limit: int('default_quantity_limit'),
            low_stock_threshold: int('low_stock_threshold') ?? 8,
            low_stock_bump: num('low_stock_bump') ?? 1,
            priority_rule: fd.get('priority_rule') || 'card_number',
            display_sort: fd.get('display_sort') || 'card_number',
            name_format: fd.get('name_format').trim() || '{number}/{set_total} {name} {suffix}',
            card_type_filter: splitList('card_type_filter'),
            updated_at: new Date().toISOString(),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('listing_templates').update(payload).eq('id', templateId)
                : await supabase.from('listing_templates').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadTemplates(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save listing template.';
        }
    });
}

// ── Pricing profiles section (docs/plans/listing-pricing-system.md) ────────
// A profile is a named, reusable tier table (e.g. 'double_rare_rh_ur':
// market < $1 -> 3.99, >= $1 -> 4.99). Listing pricing rules (assigned on
// the Listing pricing page, not here) map a card's rarity/foil_type/set/
// card to one of these profiles. Tier management is a nested view within
// the profile's own modal to keep this screen focused, mirroring how the
// rest of this file uses one modal per concern.

function profilesSectionHTML() {
    return `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Profiles are pure tier tables — they don't know about listings
            or platforms. Assign a profile to a listing via a pricing rule
            on that listing's Listing pricing page.
        </p>
        <div class="filters-bar" style="justify-content:flex-end;">
            <button class="btn btn-primary" id="new-profile-btn">+ New profile</button>
        </div>
        <div id="profiles-table-wrap"><p>Loading...</p></div>
        <div id="profiles-modal-root"></div>
    `;
}

async function loadProfiles(container) {
    const wrap = container.querySelector('#profiles-table-wrap');
    try {
        const { data: profiles, error: pErr } = await supabase.from('pricing_profiles').select('*').order('name');
        if (pErr) throw pErr;
        const { data: tiers, error: tErr } = await supabase.from('pricing_profile_tiers').select('*').order('min_market');
        if (tErr) throw tErr;

        const tiersByProfile = {};
        for (const t of tiers || []) {
            (tiersByProfile[t.profile_id] ??= []).push(t);
        }
        profilesState.profiles = (profiles || []).map(p => ({ ...p, tiers: tiersByProfile[p.id] || [] }));

        renderProfilesTable(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load pricing profiles: ${err.message}</p>`;
    }
}

function tiersSummary(tiers) {
    if (!tiers.length) return '<span style="color:var(--text-secondary);">no tiers</span>';
    return tiers.map(t => {
        const range = t.max_market == null ? `≥ ${formatPrice(t.min_market)}` : `${formatPrice(t.min_market)}–${formatPrice(t.max_market)}`;
        return `${range} → ${formatPrice(t.list_price)}`;
    }).join(', ');
}

function renderProfilesTable(container) {
    const wrap = container.querySelector('#profiles-table-wrap');
    const rows = profilesState.profiles;

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No pricing profiles yet.</p>`;
    } else {
        wrap.innerHTML = `
            <table>
                <thead><tr>
                    <th>Name</th><th>Tiers</th><th>Default low-stock qty</th><th>Notes</th><th style="width:140px;"></th>
                </tr></thead>
                <tbody>
                    ${rows.map(p => `
                        <tr>
                            <td>${escapeHTML(p.name)}</td>
                            <td style="font-size:12px; color:var(--text-secondary);">${tiersSummary(p.tiers)}</td>
                            <td>${p.default_low_stock_qty ?? '-'}</td>
                            <td style="color:var(--text-secondary);">${escapeHTML(p.notes || '-')}</td>
                            <td>
                                <button class="btn edit-profile-btn" data-id="${p.id}">Edit</button>
                                <button class="btn manage-tiers-btn" data-id="${p.id}">Tiers</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    container.querySelector('#new-profile-btn').addEventListener('click', () => openProfileModal(container, null));
    wrap.querySelectorAll('.edit-profile-btn').forEach(btn => {
        btn.addEventListener('click', () => openProfileModal(container, btn.dataset.id));
    });
    wrap.querySelectorAll('.manage-tiers-btn').forEach(btn => {
        btn.addEventListener('click', () => openProfileTiersModal(container, btn.dataset.id));
    });
}

function openProfileModal(container, profileId) {
    const isEdit = !!profileId;
    const existing = isEdit ? profilesState.profiles.find(p => p.id === profileId) : null;
    const root = container.querySelector('#profiles-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit pricing profile' : 'New pricing profile', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Name', 'text', 'name', existing?.name || '', 'e.g. double_rare_rh_ur')}
            ${field('Notes', 'text', 'notes', existing?.notes || '', '', '', true)}
            ${field('Default low-stock qty', 'number', 'default_low_stock_qty', existing?.default_low_stock_qty ?? '', 'holds back this many units from being pushed', '', true)}
        </div>
        ${!isEdit ? '<p style="color:var(--text-secondary); font-size:12px; margin-top:10px;">Add tiers after creating the profile, via the "Tiers" button.</p>' : ''}
    `, isEdit, 'profile');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'pricing_profiles', profileId, `this pricing profile`, () => loadProfiles(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            name: fd.get('name').trim(),
            notes: fd.get('notes').trim() || null,
            default_low_stock_qty: fd.get('default_low_stock_qty') ? parseInt(fd.get('default_low_stock_qty'), 10) : null,
        };
        try {
            const { error } = isEdit
                ? await supabase.from('pricing_profiles').update(payload).eq('id', profileId)
                : await supabase.from('pricing_profiles').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadProfiles(container);
        } catch (err) {
            console.error(err);
            const isDupe = err.code === '23505';
            errBox.textContent = isDupe ? `"${payload.name}" already exists.` : (err.message || 'Failed to save pricing profile.');
        }
    });
}

// -- Tier management (nested within one profile) --

function openProfileTiersModal(container, profileId) {
    const profile = profilesState.profiles.find(p => p.id === profileId);
    if (!profile) return;
    const root = container.querySelector('#profiles-modal-root');
    renderTiersModalBody(root, container, profileId);
}

function renderTiersModalBody(root, container, profileId, editingTierId = null) {
    const profile = profilesState.profiles.find(p => p.id === profileId);
    const tiers = profile.tiers;
    const editingTier = editingTierId ? tiers.find(t => t.id === editingTierId) : (editingTierId === 'new' ? {} : null);
    const isFormOpen = editingTierId !== null;

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:460px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 4px;">Tiers — ${escapeHTML(profile.name)}</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 14px;">
                    Market price brackets: min is inclusive, max is exclusive (blank max = open-ended top tier).
                </p>
                ${tiers.length ? `
                    <table style="margin-bottom:12px;">
                        <thead><tr><th>Min market</th><th>Max market</th><th>List price</th><th style="width:110px;"></th></tr></thead>
                        <tbody>
                            ${tiers.map(t => `
                                <tr>
                                    <td>${formatPrice(t.min_market)}</td>
                                    <td>${t.max_market == null ? '(open-ended)' : formatPrice(t.max_market)}</td>
                                    <td>${formatPrice(t.list_price)}</td>
                                    <td>
                                        <button type="button" class="btn edit-tier-row-btn" data-id="${t.id}" style="padding:2px 8px; font-size:12px;">Edit</button>
                                        <button type="button" class="btn delete-tier-row-btn" data-id="${t.id}" style="padding:2px 8px; font-size:12px; color:var(--danger);">×</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : `<p style="color:var(--text-secondary); font-size:13px;">No tiers yet.</p>`}

                ${isFormOpen ? `
                    <form id="tier-form" style="border-top:1px solid var(--border); padding-top:12px; display:flex; flex-direction:column; gap:10px;">
                        <div style="display:flex; gap:10px;">
                            ${field('Min market ($, inclusive)', 'number', 'min_market', editingTier?.min_market ?? '0.00', '', '0.01')}
                            ${field('Max market ($, exclusive; blank = open-ended)', 'number', 'max_market', editingTier?.max_market ?? '', '', '0.01', true)}
                        </div>
                        ${field('List price ($)', 'number', 'list_price', editingTier?.list_price ?? '', '', '0.01')}
                        <div id="tier-form-error" style="color:var(--danger); font-size:12px;"></div>
                        <div style="display:flex; gap:8px;">
                            <button type="submit" class="btn btn-primary">${editingTierId === 'new' ? 'Add tier' : 'Save tier'}</button>
                            <button type="button" class="btn" id="tier-form-cancel">Cancel</button>
                        </div>
                    </form>
                ` : `<button type="button" class="btn btn-primary" id="add-tier-btn">+ Add tier</button>`}

                <div style="display:flex; justify-content:flex-end; margin-top:16px;">
                    <button type="button" class="btn" id="tiers-modal-close">Close</button>
                </div>
            </div>
        </div>
    `;

    root.querySelector('#tiers-modal-close').addEventListener('click', () => { root.innerHTML = ''; });

    if (!isFormOpen) {
        root.querySelector('#add-tier-btn').addEventListener('click', () => renderTiersModalBody(root, container, profileId, 'new'));
        root.querySelectorAll('.edit-tier-row-btn').forEach(btn => {
            btn.addEventListener('click', () => renderTiersModalBody(root, container, profileId, btn.dataset.id));
        });
        root.querySelectorAll('.delete-tier-row-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!window.confirm('Delete this tier?')) return;
                const { error } = await supabase.from('pricing_profile_tiers').delete().eq('id', btn.dataset.id);
                if (error) { window.alert(`Failed to delete: ${error.message}`); return; }
                await loadProfiles(container);
                renderTiersModalBody(root, container, profileId);
            });
        });
        return;
    }

    root.querySelector('#tier-form-cancel').addEventListener('click', () => renderTiersModalBody(root, container, profileId));
    root.querySelector('#tier-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#tier-form-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            profile_id: profileId,
            min_market: parseFloat(fd.get('min_market')),
            max_market: fd.get('max_market') ? parseFloat(fd.get('max_market')) : null,
            list_price: parseFloat(fd.get('list_price')),
        };
        try {
            const { error } = editingTierId === 'new'
                ? await supabase.from('pricing_profile_tiers').insert(payload)
                : await supabase.from('pricing_profile_tiers').update(payload).eq('id', editingTierId);
            if (error) throw error;
            await loadProfiles(container);
            renderTiersModalBody(root, container, profileId);
        } catch (err) {
            console.error(err);
            // The DB trigger raises a plain RAISE EXCEPTION message for overlaps —
            // surface it directly, it's already human-readable.
            errBox.textContent = err.message || 'Failed to save tier.';
        }
    });
}

// ── Sync controls section (platform_sync_status kill switches) ─────────────
// Emergency freeze for a whole platform or one account. Rows are opt-in —
// a platform/account with NO row here is fully enabled by default; a row
// only exists to turn something OFF (or to explicitly re-confirm it's on).
// This is separate from (and layered UNDER) the per-listing sync_enabled
// toggle on each platform_listings row — both must pass for a listing to
// be touched by --ebay-recalc-prices / --ebay-push-listings.

function syncControlsSectionHTML() {
    return `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Emergency kill switch for the eBay listing sync engine. A
            platform-wide row (blank account) freezes sync for every
            account at once; an account-specific row freezes just that
            account. No row for a platform/account = sync fully enabled —
            rows only exist to turn something OFF.
        </p>
        <div class="filters-bar" style="justify-content:flex-end;">
            <button class="btn btn-primary" id="new-syncstatus-btn">+ New kill switch</button>
        </div>
        <div id="syncstatus-table-wrap"><p>Loading...</p></div>
        <div id="syncstatus-modal-root"></div>
    `;
}

async function loadSyncControls(container) {
    const wrap = container.querySelector('#syncstatus-table-wrap');
    try {
        const { data, error } = await supabase.from('platform_sync_status').select('*').order('platform').order('account', { nullsFirst: true });
        if (error) throw error;
        syncControlsState.statuses = data || [];
        renderSyncControlsTable(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load sync controls: ${err.message}</p>`;
    }
}

function renderSyncControlsTable(container) {
    const wrap = container.querySelector('#syncstatus-table-wrap');
    const rows = syncControlsState.statuses;

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No kill switches configured — sync is fully enabled everywhere.</p>`;
    } else {
        wrap.innerHTML = `
            <table>
                <thead><tr>
                    <th>Platform</th><th>Account</th><th>Sync enabled</th><th>Disabled at</th><th>Notes</th><th style="width:60px;"></th>
                </tr></thead>
                <tbody>
                    ${rows.map(s => `
                        <tr>
                            <td>${escapeHTML(s.platform)}</td>
                            <td>${s.account ? escapeHTML(s.account) : '<span style="color:var(--text-secondary);">Whole platform</span>'}</td>
                            <td>${s.sync_enabled
                                ? '<span style="color:var(--success);">Enabled</span>'
                                : '<span style="color:var(--danger); font-weight:600;">DISABLED</span>'}</td>
                            <td style="color:var(--text-secondary); font-size:12px;">${s.disabled_at ? new Date(s.disabled_at).toLocaleString() : '-'}</td>
                            <td style="color:var(--text-secondary);">${escapeHTML(s.notes || '-')}</td>
                            <td><button class="btn edit-syncstatus-btn" data-id="${s.id}">Edit</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    container.querySelector('#new-syncstatus-btn').addEventListener('click', () => openSyncStatusModal(container, null));
    wrap.querySelectorAll('.edit-syncstatus-btn').forEach(btn => {
        btn.addEventListener('click', () => openSyncStatusModal(container, btn.dataset.id));
    });
}

function openSyncStatusModal(container, statusId) {
    const isEdit = !!statusId;
    const existing = isEdit ? syncControlsState.statuses.find(s => s.id === statusId) : null;
    const root = container.querySelector('#syncstatus-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit kill switch' : 'New kill switch', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = whole platform, all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            <label style="font-size:12px; color:var(--text-secondary); display:flex; align-items:center; gap:8px;">
                <input type="checkbox" name="sync_enabled" ${existing ? (existing.sync_enabled ? 'checked' : '') : 'checked'} />
                Sync enabled (uncheck to freeze sync for this platform/account)
            </label>
            ${field('Notes', 'text', 'notes', existing?.notes || '', 'why this was turned off', '', true)}
        </div>
    `, isEdit, 'syncstatus');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'platform_sync_status', statusId, `this kill switch`, () => loadSyncControls(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const syncEnabled = fd.get('sync_enabled') === 'on';
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            sync_enabled: syncEnabled,
            disabled_at: syncEnabled ? null : new Date().toISOString(),
            notes: fd.get('notes').trim() || null,
        };
        try {
            const { error } = isEdit
                ? await supabase.from('platform_sync_status').update(payload).eq('id', statusId)
                : await supabase.from('platform_sync_status').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadSyncControls(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save kill switch.';
        }
    });
}

// ── Small shared modal helpers (used by pricing + templates) ────────────────

function modalShell(title, bodyHTML, isEdit, formName) {
    return `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:460px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 16px;">${title}</h3>
                <form id="modal-form">
                    ${bodyHTML}
                    <div id="modal-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;
}

function field(label, type, name, value, placeholder = '', step = '', optional = false) {
    return `
        <label style="font-size:12px; color:var(--text-secondary); flex:${optional ? '1' : 'initial'};">
            ${label}
            <input type="${type}" name="${name}" ${step ? `step="${step}"` : ''} ${optional ? '' : (type === 'number' ? '' : 'required')}
                   value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" style="width:100%; margin-top:4px;" />
        </label>
    `;
}

async function confirmDelete(container, table, id, label, onDone) {
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    try {
        const { error } = await supabase.from(table).delete().eq('id', id);
        if (error) throw error;
        await onDone();
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        window.alert(isFkViolation
            ? `Can't delete ${label} — other records still reference it.`
            : `Failed to delete: ${err.message}`);
    }
}

function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '-';
    return '$' + Number(value).toFixed(2);
}

// ── Card games section ───────────────────────────────────────────────────────

function gamesSectionHTML() {
    return `
        <div class="filters-bar" style="justify-content:space-between;">
            <input type="search" id="games-search" placeholder="Search card games..." style="min-width:240px;" />
            <button class="btn btn-primary" id="new-game-btn">+ New card game</button>
        </div>
        <div id="games-table-wrap"><p>Loading...</p></div>
        <div id="game-modal-root"></div>
    `;
}

async function loadGames(container) {
    const wrap = container.querySelector('#games-table-wrap');
    try {
        const [{ data: games, error: gamesErr }, { data: setRows, error: setsErr }] = await Promise.all([
            supabase.from('card_games').select('*').order('name'),
            supabase.from('card_sets').select('game_id'),
        ]);

        if (gamesErr) throw gamesErr;
        if (setsErr) throw setsErr;

        const counts = {};
        for (const row of setRows || []) {
            counts[row.game_id] = (counts[row.game_id] || 0) + 1;
        }

        gameState.games = games || [];
        gameState.gameSetCounts = counts;

        renderGamesTable(container);
        wireGamesControls(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load card games: ${err.message}</p>`;
    }
}

function renderGamesTable(container) {
    const wrap = container.querySelector('#games-table-wrap');
    const q = gameState.search.trim().toLowerCase();
    const rows = gameState.games.filter(g => !q || g.name.toLowerCase().includes(q));

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No card games found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Publisher</th>
                    <th>Notes</th>
                    <th>Sets</th>
                    <th style="width:60px;"></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(g => `
                    <tr data-game-id="${g.id}">
                        <td>${escapeHTML(g.name)}</td>
                        <td>${escapeHTML(g.publisher || '-')}</td>
                        <td style="color:var(--text-secondary);">${escapeHTML(g.notes || '-')}</td>
                        <td>${gameState.gameSetCounts[g.id] || 0}</td>
                        <td><button class="btn edit-game-btn" data-id="${g.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('.edit-game-btn').forEach(btn => {
        btn.addEventListener('click', () => openGameModal(container, btn.dataset.id));
    });
}

function wireGamesControls(container) {
    const searchInput = container.querySelector('#games-search');
    searchInput.value = gameState.search;
    searchInput.addEventListener('input', debounce((e) => {
        gameState.search = e.target.value;
        renderGamesTable(container);
    }, 200));

    container.querySelector('#new-game-btn').addEventListener('click', () => openGameModal(container, null));
}

function openGameModal(container, gameId) {
    const isEdit = !!gameId;
    const existing = isEdit ? gameState.games.find(g => g.id === gameId) : null;
    const root = container.querySelector('#game-modal-root');

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 16px;">${isEdit ? 'Edit card game' : 'New card game'}</h3>
                <form id="game-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Name
                            <input type="text" name="name" required value="${existing ? escapeAttr(existing.name) : ''}" style="width:100%; margin-top:4px;" placeholder="e.g. Pokemon" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Publisher
                            <input type="text" name="publisher" value="${existing ? escapeAttr(existing.publisher || '') : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Notes
                            <input type="text" name="notes" value="${existing ? escapeAttr(existing.notes || '') : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                    </div>
                    <div id="game-form-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="game-modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete game</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="game-modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create game'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    root.querySelector('#game-modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    if (isEdit) {
        root.querySelector('#game-modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDeleteGame(container, gameId);
        });
    }

    root.querySelector('#game-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#game-form-error');
        errBox.textContent = '';

        const fd = new FormData(e.target);
        const payload = {
            name: fd.get('name').trim(),
            publisher: fd.get('publisher').trim() || null,
            notes: fd.get('notes').trim() || null,
        };

        try {
            if (isEdit) {
                const { error } = await supabase.from('card_games').update(payload).eq('id', gameId);
                if (error) throw error;
            } else {
                const { error } = await supabase.from('card_games').insert(payload);
                if (error) throw error;
            }
            root.innerHTML = '';
            await loadGames(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save card game.';
        }
    });
}

async function confirmDeleteGame(container, gameId) {
    const game = gameState.games.find(g => g.id === gameId);
    if (!game) return;

    const setCount = gameState.gameSetCounts[gameId] || 0;
    const warning = setCount > 0
        ? `"${game.name}" has ${setCount} set${setCount === 1 ? '' : 's'} linked to it. Deleting the game will fail unless those sets are removed or reassigned first.\n\nTry to delete anyway?`
        : `Delete "${game.name}"? This can't be undone.`;

    if (!window.confirm(warning)) return;

    try {
        const { error } = await supabase.from('card_games').delete().eq('id', gameId);
        if (error) throw error;
        await loadGames(container);
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        const msg = isFkViolation
            ? `Can't delete "${game.name}" — it still has sets referencing it. Remove or reassign those sets first.`
            : `Failed to delete card game: ${err.message}`;
        window.alert(msg);
    }
}

// ── Variant attributes ───────────────────────────────────────────────────
// One generic CRUD component for all 7 lookup tables card_variants
// references by `code` (foil_types, foil_patterns, textures, materials,
// sizes, stamp_types, source_types). All 7 share the identical
// (code, display_name, sort_order) shape.

function attrSectionHTML() {
    return `
        <div style="display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap;">
            ${ATTR_TABLES.map(t => `
                <button class="btn attr-tab-btn" data-table="${t.table}"
                        style="${t.table === attrState.activeTable ? 'background:var(--accent); color:white;' : ''}">
                    ${t.label}
                </button>
            `).join('')}
        </div>
        <div class="filters-bar" style="justify-content:space-between;">
            <input type="search" id="attr-search" placeholder="Search..." style="min-width:240px;" />
            <button class="btn btn-primary" id="new-attr-btn">+ New value</button>
        </div>
        <div id="attr-table-wrap"><p>Loading...</p></div>
        <div id="attr-modal-root"></div>
    `;
}

function wireAttrTabs(container) {
    container.querySelectorAll('.attr-tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            attrState.activeTable = btn.dataset.table;
            attrState.search = '';
            // Re-render the tab bar itself so the active highlight moves.
            container.querySelector('#config-body').innerHTML = attrSectionHTML();
            wireAttrTabs(container);
            await loadAttrTable(container);
        });
    });
}

function currentAttrDef() {
    return ATTR_TABLES.find(t => t.table === attrState.activeTable);
}

async function loadAttrTable(container) {
    const wrap = container.querySelector('#attr-table-wrap');
    const def = currentAttrDef();

    try {
        const [{ data: rows, error: rowsErr }, { data: usageRows, error: usageErr }] = await Promise.all([
            supabase.from(def.table).select('*').order('sort_order').order('display_name'),
            supabase.from('card_variants').select(def.variantColumn),
        ]);

        if (rowsErr) throw rowsErr;
        if (usageErr) throw usageErr;

        const counts = {};
        for (const row of usageRows || []) {
            const val = row[def.variantColumn];
            if (!val) continue;
            counts[val] = (counts[val] || 0) + 1;
        }

        attrState.rows = rows || [];
        attrState.usageCounts = counts;

        renderAttrTable(container);
        wireAttrControls(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load ${def.label}: ${err.message}</p>`;
    }
}

function renderAttrTable(container) {
    const wrap = container.querySelector('#attr-table-wrap');
    const def = currentAttrDef();
    const q = attrState.search.trim().toLowerCase();
    const rows = attrState.rows.filter(r =>
        !q || r.code.toLowerCase().includes(q) || r.display_name.toLowerCase().includes(q));

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No ${def.label.toLowerCase()} found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Code</th>
                    <th>Display name</th>
                    <th style="width:80px;">Sort order</th>
                    <th style="width:100px;">In use</th>
                    <th style="width:60px;"></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(r => `
                    <tr data-code="${escapeAttr(r.code)}">
                        <td><code>${escapeHTML(r.code)}</code></td>
                        <td>${escapeHTML(r.display_name)}</td>
                        <td>${r.sort_order ?? 0}</td>
                        <td>${attrState.usageCounts[r.code] || 0}</td>
                        <td><button class="btn edit-attr-btn" data-code="${escapeAttr(r.code)}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('.edit-attr-btn').forEach(btn => {
        btn.addEventListener('click', () => openAttrModal(container, btn.dataset.code));
    });
}

function wireAttrControls(container) {
    const searchInput = container.querySelector('#attr-search');
    searchInput.value = attrState.search;
    searchInput.addEventListener('input', debounce((e) => {
        attrState.search = e.target.value;
        renderAttrTable(container);
    }, 200));

    container.querySelector('#new-attr-btn').addEventListener('click', () => openAttrModal(container, null));
}

function openAttrModal(container, code) {
    const def = currentAttrDef();
    const isEdit = !!code;
    const existing = isEdit ? attrState.rows.find(r => r.code === code) : null;
    const root = container.querySelector('#attr-modal-root');

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 16px;">${isEdit ? `Edit ${def.label.slice(0, -1)}` : `New ${def.label.slice(0, -1)}`}</h3>
                <form id="attr-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Code ${isEdit ? '<span style="color:var(--text-secondary);">(locked — referenced by existing variants)</span>' : ''}
                            <input type="text" name="code" required value="${existing ? escapeAttr(existing.code) : ''}"
                                   ${isEdit ? 'readonly style="width:100%; margin-top:4px; opacity:0.6;"' : 'style="width:100%; margin-top:4px;"'}
                                   placeholder="e.g. Confetti" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Display name
                            <input type="text" name="display_name" required value="${existing ? escapeAttr(existing.display_name) : ''}" style="width:100%; margin-top:4px;" placeholder="e.g. Confetti" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Sort order
                            <input type="number" name="sort_order" value="${existing ? existing.sort_order ?? 0 : 0}" style="width:100%; margin-top:4px;" />
                        </label>
                    </div>
                    <div id="attr-form-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="attr-modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="attr-modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    root.querySelector('#attr-modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    if (isEdit) {
        root.querySelector('#attr-modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDeleteAttr(container, code);
        });
    }

    root.querySelector('#attr-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#attr-form-error');
        errBox.textContent = '';

        const fd = new FormData(e.target);
        const payload = {
            code: fd.get('code').trim(),
            display_name: fd.get('display_name').trim(),
            sort_order: parseInt(fd.get('sort_order'), 10) || 0,
        };

        try {
            if (isEdit) {
                // code is locked/readonly in the form, so only display_name
                // and sort_order can actually change here.
                const { error } = await supabase.from(def.table)
                    .update({ display_name: payload.display_name, sort_order: payload.sort_order })
                    .eq('code', code);
                if (error) throw error;
            } else {
                const { error } = await supabase.from(def.table).insert(payload);
                if (error) throw error;
            }
            root.innerHTML = '';
            await loadAttrTable(container);
        } catch (err) {
            console.error(err);
            const isDupe = err.code === '23505';
            errBox.textContent = isDupe
                ? `"${payload.code}" already exists in ${def.label}.`
                : (err.message || `Failed to save ${def.label.toLowerCase()} value.`);
        }
    });
}

async function confirmDeleteAttr(container, code) {
    const def = currentAttrDef();
    const row = attrState.rows.find(r => r.code === code);
    if (!row) return;

    const usageCount = attrState.usageCounts[code] || 0;
    const warning = usageCount > 0
        ? `"${row.display_name}" is used by ${usageCount} existing card variant${usageCount === 1 ? '' : 's'}. Deleting it will fail unless those variants are updated first.\n\nTry to delete anyway?`
        : `Delete "${row.display_name}"? This can't be undone.`;

    if (!window.confirm(warning)) return;

    try {
        const { error } = await supabase.from(def.table).delete().eq('code', code);
        if (error) throw error;
        await loadAttrTable(container);
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        const msg = isFkViolation
            ? `Can't delete "${row.display_name}" — it's still referenced by existing card variants. Update those variants first.`
            : `Failed to delete: ${err.message}`;
        window.alert(msg);
    }
}
