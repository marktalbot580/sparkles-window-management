/* Sparkles Window Management – sign-in and cloud sync (Supabase, plain fetch calls, no library).
   When config.js has no Supabase details the app runs in local-only mode: everything stays on this phone. */
'use strict';
const CLOUD = (() => {
  const cfg = window.SWM_CONFIG || {};
  const on = !!(cfg.url && cfg.key);
  const KS = 'swm_session', KM = 'swm_synced', KP = 'swm_pull', KT = 'swm_tombs', KID = 'swm_uid';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  let session = ls.get(KS, null), hooks = null, timer = 0;
  const st = { busy: false, state: '', msg: '' };
  const synced = ls.get(KM, {}), tombs = ls.get(KT, []);
  const saveMeta = () => { ls.set(KM, synced); ls.set(KT, tombs); };
  const key = (k, id) => k + ':' + id;

  /* ---------- low level ---------- */
  function setSession(j) {
    session = {
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      user: j.user ? { id: j.user.id, email: j.user.email } : (session && session.user) || null
    };
    ls.set(KS, session);
  }
  async function refresh() {
    if (!session || !session.refresh_token) throw new Error('Please log in again');
    const r = await fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) { session = null; ls.del(KS); showGate(); throw new Error('Please log in again'); }
    setSession(j);
  }
  async function fresh() {
    if (!session) throw new Error('Not signed in');
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    return session;
  }
  async function req(path, o = {}) {
    const headers = Object.assign({ apikey: cfg.key, 'Content-Type': 'application/json' }, o.headers || {});
    if (o.auth !== false) { const s = await fresh(); headers.Authorization = 'Bearer ' + s.access_token; }
    const res = await fetch(cfg.url + path, { method: o.method || 'GET', headers, body: o.body === undefined ? undefined : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) });
    const text = await res.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { j = { message: text }; }
    if (!res.ok) throw new Error((j && (j.msg || j.error_description || j.message || j.error)) || ('Error ' + res.status));
    return j;
  }
  /* call one of your own server functions (for example send-invoice) */
  async function call(name, body) {
    if (!on || !session) throw new Error('Not signed in');
    return req('/functions/v1/' + name, { method: 'POST', body });
  }

  /* ---------- sign in / out ---------- */
  async function signIn(email, password) {
    const j = await req('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
    setSession(j); return userChanged();
  }
  async function signUp(email, password) {
    const j = await req('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password } });
    if (j && j.access_token) { setSession(j); return 'in'; }
    return 'confirm';
  }
  const recover = email => req('/auth/v1/recover', { method: 'POST', auth: false, body: { email, redirect_to: location.origin + location.pathname } });
  async function signOut() { try { await req('/auth/v1/logout', { method: 'POST' }); } catch (e) { } session = null; ls.del(KS); showGate(); }
  /* a different person logging in on a phone that still holds someone else's data: clear it first, so it never mixes */
  function userChanged() {
    const id = session && session.user && session.user.id; if (!id) return false;
    const last = ls.get(KID, null);
    if (last && last !== id) {
      try { Object.keys(localStorage).filter(k => /^swm_/.test(k) && k !== KS && k !== KID).forEach(k => localStorage.removeItem(k)); } catch (e) { }
      ls.set(KID, id); setTimeout(() => location.reload(), 300); return true;
    }
    ls.set(KID, id); return false;
  }
  /* sign-in links from emails land here with the session in the URL hash */
  function takeHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!h.get('access_token')) return;
    session = { access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_at: +h.get('expires_at') || Math.floor(Date.now() / 1000) + (+h.get('expires_in') || 3600), user: null };
    history.replaceState(null, '', location.pathname + location.search);
    req('/auth/v1/user').then(u => { session.user = { id: u.id, email: u.email }; ls.set(KS, session); userChanged(); hideGate(); sync(true); }).catch(() => { session = null; ls.del(KS); });
  }

  /* ---------- sync ---------- */
  function del(kind, id) { if (!on || !session) return; tombs.push({ kind, id, updated: Date.now() }); saveMeta(); changed(); }
  async function pull() {
    let since = ls.get(KP, ''), n = 0;
    for (;;) {
      const q = '/rest/v1/docs?select=kind,id,data,updated,deleted,server_at&order=server_at.asc&limit=500' + (since ? '&server_at=gt.' + encodeURIComponent(since) : '');
      const rows = await req(q); if (!rows || !rows.length) break;
      rows.forEach(d => { hooks.apply(d, synced[key(d.kind, d.id)]); synced[key(d.kind, d.id)] = d.updated || 0; });
      n += rows.length; since = rows[rows.length - 1].server_at; ls.set(KP, since);
      if (rows.length < 500) break;
    }
    saveMeta(); return n;
  }
  async function push() {
    const uid = session.user.id, rows = [];
    hooks.local().forEach(d => { if (synced[key(d.kind, d.id)] !== d.updated) rows.push({ user_id: uid, kind: d.kind, id: d.id, data: d.data, updated: d.updated, deleted: false }); });
    tombs.forEach(t => rows.push({ user_id: uid, kind: t.kind, id: t.id, data: {}, updated: t.updated, deleted: true }));
    for (let i = 0; i < rows.length; i += 100) {
      await req('/rest/v1/docs?on_conflict=user_id,kind,id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: rows.slice(i, i + 100) });
    }
    rows.forEach(r => { if (r.deleted) delete synced[key(r.kind, r.id)]; else synced[key(r.kind, r.id)] = r.updated; });
    tombs.length = 0; saveMeta();
    return rows.length;
  }
  async function sync(manual) {
    if (!on || !session || st.busy || !hooks) return;
    st.busy = true; st.state = 'busy'; paint();
    try {
      const pulled = await pull(), pushed = await push();
      st.state = 'ok'; st.msg = 'Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (pulled) hooks.done();
      if (manual) hooks.toast(pushed || pulled ? 'Synced' : 'Everything is up to date');
    } catch (e) {
      console.warn(e); st.state = 'error';
      st.msg = navigator.onLine === false ? 'Offline – will sync when you are back online' : 'Sync failed: ' + e.message;
    }
    st.busy = false; paint();
  }
  /* call after any local change: syncs a couple of seconds later */
  function changed() { if (!on || !session) return; clearTimeout(timer); timer = setTimeout(() => sync(), 2500); }
  function paint() {
    const d = document.querySelector('#syncDot'); if (d) d.className = 'dot ' + (!on || !session ? '' : st.state === 'busy' ? 'busy' : st.state === 'error' ? 'err' : 'ok');
    const m = document.querySelector('#syncMsg'); if (m) m.textContent = !on ? 'Local only – not connected to a database yet' : (st.msg || '');
  }

  /* ---------- the sign-in screen ---------- */
  let mode = 'in', err = '', note = '', working = false;
  const E = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function gateEl() {
    let g = document.getElementById('gate');
    if (!g) { g = document.createElement('div'); g.id = 'gate'; document.body.appendChild(g); g.addEventListener('click', onClick); g.addEventListener('submit', onSubmit); }
    return g;
  }
  function hideGate() { const g = document.getElementById('gate'); if (g) g.remove(); }
  function showGate() {
    if (!on) return;
    const up = mode === 'up', fg = mode === 'forgot';
    gateEl().innerHTML = `<form class="gate-card" autocomplete="on">
      <img src="logo.svg" alt="">
      <h1>${fg ? 'Reset password' : up ? 'Create your account' : 'Welcome back'}</h1>
      <p>Sparkles Window Management</p>
      ${note ? `<div class="notice">${E(note)}</div>` : ''}${err ? `<p class="err">${E(err)}</p>` : ''}
      <label class="f"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="email" required></label>
      ${fg ? '' : `<label class="f"><span>Password</span><input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="8" required></label>`}
      <button class="btn blue block" type="submit" ${working ? 'disabled' : ''}>${working ? 'Please wait…' : fg ? 'Email me a reset link' : up ? 'Create account' : 'Log in'}</button>
      ${fg ? '<button type="button" class="link" data-m="in">Back to log in</button>' : up ? '<button type="button" class="link" data-m="in">I already have an account</button>' : '<button type="button" class="link" data-m="forgot">Forgot your password?</button><button type="button" class="link" data-m="up">First time? Create your account</button>'}
    </form>`;
  }
  function onClick(e) { const b = e.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; err = ''; note = ''; showGate(); }
  async function onSubmit(e) {
    e.preventDefault(); if (working) return;
    const f = e.target, email = f.email.value.trim(), password = f.password ? f.password.value : '';
    working = true; err = ''; note = ''; showGate();
    try {
      if (mode === 'forgot') { await recover(email); note = 'If that email has an account, a reset link is on its way.'; mode = 'in'; }
      else if (mode === 'up') { const r = await signUp(email, password); if (r === 'in') { hideGate(); working = false; userChanged(); sync(true); return; } note = 'Check your email to confirm your account, then log in here.'; mode = 'in'; }
      else { const reload = await signIn(email, password); if (!reload) { hideGate(); working = false; sync(true); return; } }
    } catch (ex) { err = /invalid login/i.test(ex.message) ? 'That email or password is not right.' : ex.message; }
    working = false; showGate();
  }

  /* app.js hands over how to read and apply its data, then everything starts */
  function bind(h) {
    hooks = h; if (!on) { paint(); return; }
    takeHash();
    if (!session) { showGate(); return; }
    userChanged(); sync();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
    window.addEventListener('online', () => sync());
    setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 90000);
  }
  return { on, bind, sync: () => sync(true), changed, del, call, signOut, paint, email: () => (session && session.user && session.user.email) || '', signedIn: () => !!session, st };
})();
