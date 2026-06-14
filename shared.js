// shared.js
// Supabase client setup + auth helpers shared across all pages.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
