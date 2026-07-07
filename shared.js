// shared.js
// Supabase client setup + auth helpers shared across all pages.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = 'https://kfxukzvuufmowapjagro.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_D6suMyjdFr7vKDgGdo5DJQ_v36kiBUe';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ----------------------------------------------------------------
// Auth helpers
// ----------------------------------------------------------------

/**
 * Returns the current session, or null if not signed in.
 */
export async function getSession() {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
        console.error('getSession error:', error);
        return null;
    }
    return data.session;
}

/**
 * Starts Google OAuth sign-in flow.
 * NOTE: Google provider must be enabled in Supabase
 * (Authentication -> Providers -> Google) before this works.
 */
export async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: window.location.origin + window.location.pathname,
        },
    });
    if (error) {
        console.error('signInWithGoogle error:', error);
        alert('Sign-in failed: ' + error.message);
    }
}

export async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) {
        console.error('signOut error:', error);
    }
    window.location.reload();
}

/**
 * Ensures the user is signed in. If not, renders a sign-in screen
 * into the given container and returns null. If signed in, returns
 * the session.
 *
 * Usage:
 *   const session = await requireAuth(document.getElementById('app'));
 *   if (!session) return; // sign-in screen is shown, stop here
 */
export async function requireAuth(container) {
    const session = await getSession();
    if (session) return session;

    container.innerHTML = `
        <div class="auth-screen">
            <h1>Card-Board-MasterMind</h1>
            <p>Sign in to manage inventory.</p>
            <button id="google-signin-btn" class="btn btn-primary">
                Sign in with Google
            </button>
        </div>
    `;
    container.querySelector('#google-signin-btn')
        .addEventListener('click', signInWithGoogle);

    return null;
}

// ----------------------------------------------------------------
// Small shared utilities
// ----------------------------------------------------------------

/**
 * Debounce helper for search inputs etc.
 */
export function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

/**
 * Format a number as USD currency, or '-' if null/undefined.
 */
export function formatPrice(value) {
    if (value === null || value === undefined) return '-';
    return '$' + Number(value).toFixed(2);
}

// ----------------------------------------------------------------
// Variant attribute options — shared across Staging Review, Inventory,
// and Catalog. Loaded once from the real lookup tables (foil_types,
// foil_patterns, textures, materials, sizes, stamp_types, source_types)
// so dropdowns/labels everywhere stay in sync with whatever's been added
// via Configuration -> Variant attributes, instead of each page keeping
// its own hardcoded (or separately-loaded) copy that can drift out of
// sync with the others.
//
// AXIS_OPTIONS and AXIS_DISPLAY are exported as live bindings -- importers
// see them update in place once loadAxisOptions() resolves, as long as
// they reference properties at render time (e.g. AXIS_OPTIONS.foil_type)
// rather than destructuring/copying at import time.
// ----------------------------------------------------------------

export const AXIS_TABLES = {
    foil_type:    'foil_types',
    foil_pattern: 'foil_patterns',
    texture:      'textures',
    material:     'materials',
    size:         'sizes',
    stamp_type:   'stamp_types',
    source_type:  'source_types',
};

export let AXIS_OPTIONS = {};  // axis -> [[code, display_name], ...]
export let AXIS_DISPLAY = {};  // axis -> { code: display_name }

/**
 * Loads AXIS_OPTIONS and AXIS_DISPLAY from the 7 variant lookup tables.
 * Call once per page mount, before rendering anything that uses them.
 *
 * @param {boolean} includeNoneOption - if true, prefixes each axis's
 *   AXIS_OPTIONS list with ['', '— none —'] (Staging Review's editable
 *   dropdowns want this; Catalog builds its own '-' option separately
 *   and doesn't need it baked in here).
 */
export async function loadAxisOptions(includeNoneOption = false) {
    const entries = Object.entries(AXIS_TABLES);

    const results = await Promise.all(
        entries.map(([, table]) =>
            supabase.from(table).select('code, display_name').order('sort_order').order('display_name'))
    );

    entries.forEach(([axis], i) => {
        const { data, error } = results[i];
        if (error) {
            console.error(`Failed to load ${AXIS_TABLES[axis]}:`, error);
            AXIS_OPTIONS[axis] = includeNoneOption ? [['', '— none —']] : [];
            AXIS_DISPLAY[axis] = {};
            return;
        }
        const pairs = (data || []).map(r => [r.code, r.display_name]);
        AXIS_OPTIONS[axis] = includeNoneOption ? [['', '— none —'], ...pairs] : pairs;
        AXIS_DISPLAY[axis] = Object.fromEntries(pairs);
    });
}

/**
 * Looks up the display label for a single axis code, falling back to
 * the raw code itself if it's not in AXIS_DISPLAY (e.g. loadAxisOptions
 * hasn't run yet, or the code predates being added to the lookup table).
 */
export function axisDisplay(axis, code) {
    if (!code) return undefined;
    return (AXIS_DISPLAY[axis] && AXIS_DISPLAY[axis][code]) || code;
}
