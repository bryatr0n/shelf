'use strict';
/*
 * Cross-device sync via Supabase (Auth + REST), no client library needed.
 *
 * Local-first: the app always reads/writes localStorage. Changed book ids are queued as
 * "dirty" (and deletions as tombstones), pushed when online, then changes from other
 * devices are pulled using a server-side `modified_at` cursor. Newest `updatedAt` wins.
 */
(() => {
  const CFG = window.SHELF_CONFIG || {};
  const BASE = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
  const KEY = String(CFG.supabaseKey || '');
  const configured = Boolean(BASE && KEY);

  const K = {
    session: 'shelf.session',
    dirty: 'shelf.sync.dirty',
    deleted: 'shelf.sync.deleted',
    since: 'shelf.sync.since',
    last: 'shelf.sync.last',
  };
  const getJSON = (k, d) => { try { return JSON.parse(safeStorage.get(k)) ?? d; } catch { return d; } };
  const setJSON = (k, v) => safeStorage.set(k, JSON.stringify(v));

  let session = getJSON(K.session, null);
  let status = { state: 'idle', message: '' };

  /* ---------- Auth ---------- */
  class HttpError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

  async function authFetch(path, body, bearer) {
    const headers = { apikey: KEY, 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(`${BASE}/auth/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(data.error_description || data.msg || data.message || `Error ${res.status}`, res.status);
    return data;
  }

  function saveSession(d) {
    session = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
      user: { id: d.user.id, email: d.user.email },
    };
    setJSON(K.session, session);
  }

  function dropSession() {
    session = null;
    safeStorage.set(K.session, '');
    safeStorage.set(K.since, '');
  }

  async function accessToken() {
    if (!session) throw new HttpError('Signed out', 401);
    if (session.expires_at * 1000 - 60_000 < Date.now()) {
      try {
        saveSession(await authFetch('token?grant_type=refresh_token', { refresh_token: session.refresh_token }));
      } catch (err) {
        if (err.status) { dropSession(); setStatus('error', 'Signed out — please sign in again'); }
        throw err;
      }
    }
    return session.access_token;
  }

  async function signIn(email, password) {
    saveSession(await authFetch('token?grant_type=password', { email, password }));
    afterSignIn();
  }

  async function signUp(email, password) {
    const d = await authFetch('signup', { email, password });
    if (d.access_token) { saveSession(d); afterSignIn(); return true; }
    return false; // email confirmation required
  }

  function afterSignIn() {
    // Upload everything already on this device, and download everything from the server.
    setJSON(K.dirty, books.map((b) => b.id));
    safeStorage.set(K.since, '');
    syncNow();
  }

  async function signOut() {
    const token = session && session.access_token;
    dropSession();
    setStatus('idle');
    if (token) authFetch('logout', {}, token).catch(() => {});
  }

  /* ---------- REST ---------- */
  async function rest(method, path, body, prefer) {
    const headers = { apikey: KEY, Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${BASE}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new HttpError(data.message || `Sync error ${res.status}`, res.status);
    }
    return method === 'GET' ? res.json() : null;
  }

  /* ---------- Change tracking (called by app.js) ---------- */
  function changed(...ids) {
    const dirty = new Set(getJSON(K.dirty, []));
    ids.forEach((id) => dirty.add(id));
    setJSON(K.dirty, [...dirty]);
    schedule();
  }

  function removed(id) {
    const dels = getJSON(K.deleted, []).filter((d) => d.id !== id);
    dels.push({ id, at: new Date().toISOString() });
    setJSON(K.deleted, dels);
    setJSON(K.dirty, getJSON(K.dirty, []).filter((x) => x !== id));
    schedule();
  }

  let timer;
  function schedule(ms = 1500) {
    if (!configured || !getJSON(K.session, null)) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, ms);
  }

  /* ---------- Sync ---------- */
  function mergeRow(r) {
    const idx = books.findIndex((b) => b.id === r.id);
    const local = idx >= 0 ? books[idx] : null;
    const remoteT = Date.parse(r.updated_at) || 0;
    const localT = local ? Date.parse(local.updatedAt) || 0 : 0;

    const pendingDel = getJSON(K.deleted, []).find((d) => d.id === r.id);
    if (pendingDel && Date.parse(pendingDel.at) >= remoteT) return false;
    if (local && localT >= remoteT) return false; // ours is the same or newer

    if (r.deleted) {
      if (!local) return false;
      books.splice(idx, 1);
      return true;
    }
    const book = { ...r.data, id: r.id };
    if (local) books[idx] = book; else books.push(book);
    return true;
  }

  let running = false;
  let again = false;

  async function syncNow() {
    session = getJSON(K.session, null); // another tab may have signed in or out
    if (!configured || !session) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (running) { again = true; return; }
    running = true;
    setStatus('syncing');
    try {
      const userId = session.user.id;

      // 1. Push local changes.
      const dirtyIds = getJSON(K.dirty, []);
      const sent = new Map();
      const rows = [];
      for (const id of dirtyIds) {
        const b = books.find((x) => x.id === id);
        if (!b) continue;
        rows.push({ user_id: userId, id, data: b, deleted: false, updated_at: b.updatedAt || new Date().toISOString() });
        sent.set(id, b.updatedAt);
      }
      const dels = getJSON(K.deleted, []);
      for (const d of dels) rows.push({ user_id: userId, id: d.id, data: {}, deleted: true, updated_at: d.at });
      for (let i = 0; i < rows.length; i += 200) {
        await rest('POST', 'books?on_conflict=user_id,id', rows.slice(i, i + 200), 'resolution=merge-duplicates,return=minimal');
      }
      // Clear what was pushed, unless it was edited again while we were pushing.
      setJSON(K.dirty, getJSON(K.dirty, []).filter((id) => {
        const b = books.find((x) => x.id === id);
        return b && sent.has(id) ? b.updatedAt !== sent.get(id) : Boolean(b) && !sent.has(id);
      }));
      const pushed = new Set(dels.map((d) => d.id + d.at));
      setJSON(K.deleted, getJSON(K.deleted, []).filter((d) => !pushed.has(d.id + d.at)));

      // 2. Pull changes from other devices.
      let since = safeStorage.get(K.since) || '1970-01-01T00:00:00Z';
      let first = true;
      let changedAny = false;
      for (;;) {
        // Small overlap on the first page guards against clock/commit-order edge cases.
        const from = first ? new Date(Date.parse(since) - 5000).toISOString() : since;
        first = false;
        const page = await rest('GET',
          `books?select=id,data,deleted,updated_at,modified_at&modified_at=gt.${encodeURIComponent(from)}&order=modified_at.asc&limit=1000`);
        for (const r of page) changedAny = mergeRow(r) || changedAny;
        if (page.length) since = page[page.length - 1].modified_at;
        if (page.length < 1000) break;
      }
      safeStorage.set(K.since, since);
      safeStorage.set(K.last, new Date().toISOString());

      if (changedAny) { persist(); render(); }
      setStatus('ok');
    } catch (err) {
      console.warn('Sync failed', err);
      setStatus(navigator.onLine ? 'error' : 'offline', err.message);
    } finally {
      running = false;
      if (again) { again = false; syncNow(); }
    }
  }

  /* ---------- UI (inside the ⋯ menu) ---------- */
  function setStatus(state, message = '') {
    status = { state, message };
    $('#menuBtn').classList.toggle('alert', state === 'error');
    if ($('#menuDialog').open) renderBox();
  }

  function ago(iso) {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  function renderBox() {
    session = getJSON(K.session, null);
    const box = $('#syncBox');
    if (!configured) {
      box.innerHTML = '<p class="hint left">Sync isn’t set up yet.</p>';
      return;
    }
    if (!session) {
      box.innerHTML = `
        <form id="authForm" class="auth">
          <label>Email<input name="email" type="email" autocomplete="username" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
          <div class="row">
            <button class="menu-btn center strong" type="submit" data-mode="in">Sign in</button>
            <button class="menu-btn center" type="submit" data-mode="up">Create account</button>
          </div>
          <p id="authMsg" class="hint left">Sign in to sync your library between devices.</p>
        </form>`;
      return;
    }
    const pending = getJSON(K.dirty, []).length + getJSON(K.deleted, []).length;
    const line = {
      syncing: 'Syncing…',
      offline: 'Offline — changes will sync when you reconnect.',
      error: `Sync problem: ${esc(status.message)}`,
    }[status.state] || `Last synced ${ago(safeStorage.get(K.last))}${pending ? ` · ${pending} change${pending === 1 ? '' : 's'} waiting` : ''}.`;
    box.innerHTML = `
      <p class="stats">Signed in as <strong>${esc(session.user.email)}</strong><br><span class="${status.state === 'error' ? 'err' : ''}">${line}</span></p>
      <div class="row">
        <button class="menu-btn center" id="syncNowBtn">Sync now</button>
        <button class="menu-btn center" id="signOutBtn">Sign out</button>
      </div>`;
  }

  if (configured) {
    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'authForm') return;
      e.preventDefault();
      const f = e.target;
      const mode = e.submitter && e.submitter.dataset.mode;
      const msg = $('#authMsg');
      const email = f.email.value.trim();
      const password = f.password.value;
      [...f.querySelectorAll('button')].forEach((b) => { b.disabled = true; });
      msg.classList.remove('err');
      msg.textContent = mode === 'up' ? 'Creating account…' : 'Signing in…';
      try {
        if (mode === 'up') {
          const signedIn = await signUp(email, password);
          if (!signedIn) {
            msg.textContent = 'Check your email to confirm your account, then come back and sign in.';
            [...f.querySelectorAll('button')].forEach((b) => { b.disabled = false; });
            return;
          }
        } else {
          await signIn(email, password);
        }
        renderBox();
        toast('Signed in — syncing');
      } catch (err) {
        msg.classList.add('err');
        msg.textContent = err.status ? err.message : 'Could not reach the server. Check your connection.';
        [...f.querySelectorAll('button')].forEach((b) => { b.disabled = false; });
      }
    });

    document.addEventListener('click', (e) => {
      if (e.target.id === 'syncNowBtn') syncNow();
      if (e.target.id === 'signOutBtn' && confirm('Sign out? Your books stay on this device but stop syncing.')) { signOut(); renderBox(); }
    });

    // Sync when the app opens, comes back to the foreground, or reconnects.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
    window.addEventListener('online', () => syncNow());
    setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 5 * 60_000);
    syncNow();
  }

  window.Sync = { changed, removed, schedule, syncNow, renderBox };
})();
