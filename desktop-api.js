// desktop-api.js
// Calls the small program that runs on the always-on desktop (Card-Board-MasterMind picking_api.py,
// task CBMPickingAPI). Same address and token the Picking and Staging Review pages use; a web page
// cannot touch the desktop's files (Dropbox), so the desktop does that part when a button here asks.

export const PICKING_API_URL = 'https://desktop-tu1m2fc.tail2c58d7.ts.net:8765';
export const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';

// POST to the desktop and return its JSON. Throws an Error with a plain-language message.
export async function callDesktop(path, timeoutMs = 420000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(`${PICKING_API_URL}${path}`, {
            method: 'POST',
            headers: { 'x-picking-token': PICKING_API_TOKEN },
            signal: ctl.signal,
        });
    } catch (e) {
        throw new Error(ctl.signal.aborted
            ? 'The desktop took too long to answer.'
            : 'Could not reach your desktop program. Is the PC on and Tailscale connected?');
    } finally {
        clearTimeout(timer);
    }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
        if (res.status === 409) throw new Error('Another sync is already running. Try again in a minute.');
        if (res.status === 404) throw new Error('The desktop program has not been updated yet (it needs a restart).');
        throw new Error(body?.detail || `The desktop answered with an error (${res.status}).`);
    }
    return body;
}
