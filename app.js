// Poker Buy-in Tracker - multi-device version
// Sessions are identified by a 4-digit code. All devices with the same code
// share state via the Google Sheet. Events are append-only with unique IDs,
// so reconciliation is straightforward.

(function () {
  // =====================================================================
  // CONFIGURATION — set these before deploying to GitHub Pages.
  // If DEFAULT_SHEETS_URL is set, everyone who visits the site uses it
  // automatically — they don't need to paste anything in settings.
  // =====================================================================
  const DEFAULT_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzh2CulRIUd6UpF5Xnqb6sitDEyu2CS4SAuQi-Bh_E1f3JUQvULujUO6xa7WW0QQ3f_/exec'; // <-- paste your Apps Script Web App URL here
  const DEFAULT_SECRET = '';     // <-- paste your SECRET here if you set one
  // =====================================================================

  const CFG_KEY = 'poker-config-v4';
  const SESSION_KEY = 'poker-session-v4';
  const ACTOR_KEY = 'poker-actor-v4';
  const EVENTS_KEY_PREFIX = 'poker-events-';
  const QUEUE_KEY = 'poker-queue-v4';

  const POLL_INTERVAL_MS = 5000;

  let cfg = { sheetsUrl: DEFAULT_SHEETS_URL, secret: DEFAULT_SECRET };
  let session = null; // { code, name } — null if not in a session
  let actor = '';     // display name of the current device
  let events = [];    // ordered list of all known events for the current session
  let queue = [];     // events pending upload
  let lastServerTime = 0;

  let pendingAction = null;
  let selectedMethod = 'cash';
  let syncing = false;
  let pollingTimer = null;

  // ---------- Storage ----------

  function loadCfg() {
    try {
      const c = localStorage.getItem(CFG_KEY);
      if (c) {
        const stored = JSON.parse(c);
        // Stored values override defaults, but only if they're non-empty.
        // This ensures the hardcoded DEFAULT_SHEETS_URL still works for
        // users who had previously saved empty settings.
        if (stored.sheetsUrl) cfg.sheetsUrl = stored.sheetsUrl;
        if (stored.secret) cfg.secret = stored.secret;
      }
    } catch (e) {}
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }

  function loadActor() { actor = localStorage.getItem(ACTOR_KEY) || ''; }
  function saveActor() { try { localStorage.setItem(ACTOR_KEY, actor); } catch (e) {} }

  function loadSession() {
    try { const s = localStorage.getItem(SESSION_KEY); if (s) session = JSON.parse(s); } catch (e) {}
  }
  function saveSession() {
    if (session) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {} }
    else { localStorage.removeItem(SESSION_KEY); }
  }

  function loadEvents() {
    events = [];
    if (!session) return;
    try {
      const raw = localStorage.getItem(EVENTS_KEY_PREFIX + session.code);
      if (raw) events = JSON.parse(raw);
    } catch (e) {}
  }
  function saveEvents() {
    if (!session) return;
    try { localStorage.setItem(EVENTS_KEY_PREFIX + session.code, JSON.stringify(events)); } catch (e) {}
  }

  function loadQueue() {
    try { const q = localStorage.getItem(QUEUE_KEY); if (q) queue = JSON.parse(q); } catch (e) {}
  }
  function saveQueue() { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {} }

  // ---------- Utils ----------

  function fmt(n) { return '$' + Math.round(n).toLocaleString(); }
  function timestamp() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function isoNow() { return new Date().toISOString(); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function methodLabel(m) { return { cash: 'Cash', venmo: 'Venmo', zelle: 'Zelle', owed: 'Owed' }[m] || m; }
  function newId() { return Date.now() + '-' + Math.random().toString(36).slice(2, 10); }

  // ---------- Derived state ----------
  //
  // The canonical state is the ordered list of events. We derive player totals
  // and unpaid amounts from it on every render. Events have unique IDs so
  // merging events from the server is straightforward — any event not already
  // in the list gets appended.

  function derivePlayers() {
    const players = {};
    const paidKeys = {};
    events.filter(e => e.type === 'paid').forEach(e => { paidKeys[e.buyinKey] = true; });

    const cashedOut = {};
    events.filter(e => e.type === 'cashout').forEach(e => { cashedOut[e.player] = true; });

    events.forEach(e => {
      if (e.type !== 'buyin') return;
      if (cashedOut[e.player]) return;
      if (!players[e.player]) players[e.player] = { total: 0, buyins: [] };
      const paid = e.paid === true || paidKeys[e.buyinKey] === true;
      players[e.player].total += Number(e.amount) || 0;
      players[e.player].buyins.push({
        id: e.id,
        buyinKey: e.buyinKey,
        amount: Number(e.amount) || 0,
        method: e.method,
        paid: paid
      });
    });
    return players;
  }

  function sessionEnded() {
    return events.some(e => e.type === 'reset');
  }

  // ---------- Event operations ----------
  //
  // Every mutation creates an event and pushes it through addEvent(), which:
  //   1. inserts into the local in-memory list,
  //   2. writes to localStorage,
  //   3. queues for upload,
  //   4. re-renders.

  function addEvent(ev) {
    ev.id = ev.id || newId();
    ev.sessionId = session.code;
    ev.timestamp = ev.timestamp || isoNow();
    ev.actor = ev.actor || actor;
    ev.time = ev.time || timestamp();

    // dedupe
    if (events.some(e => e.id === ev.id)) return;
    events.push(ev);
    saveEvents();

    queue.push(ev);
    saveQueue();

    render();
    flushQueue();
  }

  function mergeServerEvents(serverEvents) {
    if (!serverEvents || serverEvents.length === 0) return false;
    const existingIds = {};
    events.forEach(e => { existingIds[e.id] = true; });
    let changed = false;
    serverEvents.forEach(se => {
      if (!se.id || existingIds[se.id]) return;
      // Normalize shape
      events.push({
        id: se.id,
        sessionId: se.sessionId,
        type: se.type,
        player: se.player,
        amount: se.amount,
        method: se.method,
        paid: se.paid === true,
        buyinKey: se.buyinKey,
        actor: se.actor,
        timestamp: new Date(se.timestamp).toISOString(),
        time: new Date(se.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
      changed = true;
    });
    if (changed) {
      // Keep events sorted by timestamp for a clean log
      events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      saveEvents();
    }
    return changed;
  }

  // ---------- Network ----------

  async function api(payload) {
    if (!cfg.sheetsUrl) throw new Error('Sheets not configured');
    const resp = await fetch(cfg.sheetsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ secret: cfg.secret || '' }, payload))
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  async function apiGet(params) {
    if (!cfg.sheetsUrl) throw new Error('Sheets not configured');
    const url = cfg.sheetsUrl + '?' + Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  async function flushQueue() {
    if (syncing) return;
    if (!cfg.sheetsUrl) { updateSyncBadge('local'); return; }
    if (queue.length === 0) { updateSyncBadge('synced'); return; }
    if (!navigator.onLine) { updateSyncBadge('offline'); return; }

    syncing = true;
    updateSyncBadge('syncing');

    try {
      const batch = queue.slice(0, 25);
      const result = await api({ events: batch });
      if (!result.ok) throw new Error(result.error || 'unknown');
      queue = queue.slice(batch.length);
      saveQueue();
      updateSyncBadge(queue.length ? 'syncing' : 'synced');
      if (queue.length) setTimeout(flushQueue, 200);
    } catch (e) {
      console.warn('Sync failed:', e);
      updateSyncBadge('error');
      setTimeout(() => { syncing = false; flushQueue(); }, 10000);
      return;
    }
    syncing = false;
  }

  async function poll() {
    if (!session || !cfg.sheetsUrl) return;
    try {
      const r = await apiGet({ action: 'fetch', code: session.code, since: lastServerTime || 0 });
      if (!r.ok) return;
      if (r.events && r.events.length) {
        const changed = mergeServerEvents(r.events);
        if (changed) render();
      }
      if (r.serverTime) lastServerTime = r.serverTime;
      if (r.session && r.session.status === 'ended' && !sessionEnded()) {
        // Server says session ended; reflect it locally
        addEvent({ type: 'reset' });
      }
    } catch (e) {
      // quiet — polling retries
    }
  }

  function startPolling() {
    stopPolling();
    pollingTimer = setInterval(poll, POLL_INTERVAL_MS);
    poll();
  }
  function stopPolling() { if (pollingTimer) clearInterval(pollingTimer); pollingTimer = null; }

  window.addEventListener('online', flushQueue);
  window.addEventListener('focus', () => { if (session) { flushQueue(); poll(); } });

  // ---------- Rendering ----------

  function updateSyncBadge(status) {
    const el = document.getElementById('sync-badge');
    el.className = 'sync-badge';
    if (!cfg.sheetsUrl) { el.classList.add('local'); el.textContent = 'local only'; return; }
    if (status === 'synced') { el.classList.add('synced'); el.textContent = '✓ synced'; }
    else if (status === 'syncing') { el.classList.add('syncing'); el.textContent = 'syncing ' + queue.length; }
    else if (status === 'offline') { el.classList.add('error'); el.textContent = 'offline ' + queue.length; }
    else if (status === 'error') { el.classList.add('error'); el.textContent = 'retry ' + queue.length; }
    else { el.classList.add('local'); el.textContent = 'local'; }
  }

  function render() {
    if (!session) { showWelcome(); return; }
    showSession();

    const players = derivePlayers();
    const names = Object.keys(players);
    const total = names.reduce((s, n) => s + players[n].total, 0);
    const unpaid = names.reduce((s, n) => s + players[n].buyins.filter(b => !b.paid).reduce((x, b) => x + b.amount, 0), 0);

    document.getElementById('code-pill').textContent = session.code;
    document.getElementById('stat-players').textContent = names.length;
    document.getElementById('stat-total').textContent = fmt(total);
    document.getElementById('stat-unpaid').textContent = fmt(unpaid);

    const listEl = document.getElementById('player-list');
    if (names.length === 0) {
      listEl.innerHTML = '<div class="empty">No buy-ins yet</div>';
    } else {
      const sorted = names.sort((a, b) => players[b].total - players[a].total);
      listEl.innerHTML = sorted.map(n => {
        const p = players[n];
        const hasUnpaid = p.buyins.some(b => !b.paid);
        const badges = p.buyins.map((b) => {
          const cls = b.paid ? 'paid' : (b.method === 'owed' ? 'owed' : 'pending');
          const check = b.paid ? '✓ ' : '';
          return '<span class="badge ' + cls + '" data-key="' + escapeHtml(b.buyinKey) + '">' + check + fmt(b.amount) + ' ' + methodLabel(b.method) + '</span>';
        }).join('');
        return '<div class="player ' + (hasUnpaid ? 'has-unpaid' : '') + '">' +
          '<div class="player-row">' +
            '<div class="player-name">' + escapeHtml(n) + '</div>' +
            '<div class="player-total">' + fmt(p.total) + '</div>' +
          '</div>' +
          '<div class="badges">' + badges + '</div>' +
        '</div>';
      }).join('');

      document.querySelectorAll('.badge.pending, .badge.owed').forEach(badge => {
        badge.addEventListener('click', () => markPaidByKey(badge.dataset.key));
      });
    }

    const logEl = document.getElementById('log');
    if (events.length === 0) {
      logEl.textContent = 'Empty';
    } else {
      logEl.innerHTML = events.slice().reverse().map(e => {
        const who = e.actor ? ' [' + escapeHtml(e.actor) + ']' : '';
        if (e.type === 'buyin') return e.time + '  +  ' + escapeHtml(e.player) + '  ' + fmt(e.amount) + '  ' + methodLabel(e.method) + who;
        if (e.type === 'paid') return e.time + '  ✓  ' + escapeHtml(e.player) + '  ' + fmt(e.amount) + '  paid' + who;
        if (e.type === 'cashout') return e.time + '  −  ' + escapeHtml(e.player) + '  cashed out' + (e.amount != null ? ' (' + fmt(e.amount) + ')' : '') + who;
        if (e.type === 'reset') return e.time + '  ⎯  session ended' + who;
        return '';
      }).join('<br>');
    }

    updateSyncBadge(queue.length ? 'syncing' : 'synced');
  }

  // ---------- Screens ----------

  function showWelcome() {
    document.getElementById('screen-welcome').classList.remove('hidden');
    document.getElementById('screen-session').classList.add('hidden');
    document.getElementById('setup-warning').classList.toggle('hidden', !!cfg.sheetsUrl);
  }
  function showSession() {
    document.getElementById('screen-welcome').classList.add('hidden');
    document.getElementById('screen-session').classList.remove('hidden');
  }

  // ---------- Actions ----------

  function showConfirm(msg, onYes) {
    pendingAction = onYes;
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-row').classList.remove('hidden');
  }
  function hideConfirm() {
    pendingAction = null;
    document.getElementById('confirm-row').classList.add('hidden');
  }

  function setMethod(m) {
    selectedMethod = m;
    document.querySelectorAll('.pay-method').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.method === m);
    });
  }

  function addBuyin() {
    const nameEl = document.getElementById('name-input');
    const amtEl = document.getElementById('amount-input');
    const name = nameEl.value.trim();
    const amount = parseFloat(amtEl.value);

    if (!name) { nameEl.focus(); return; }
    if (!amount || amount <= 0) { amtEl.focus(); return; }

    // Canonicalize name: match case-insensitively against existing players
    const players = derivePlayers();
    const existing = Object.keys(players).find(k => k.toLowerCase() === name.toLowerCase());
    const realName = existing || name;

    const paid = selectedMethod === 'cash';
    const buyinKey = realName + '|' + amount + '|' + Date.now() + '|' + Math.random().toString(36).slice(2, 6);

    addEvent({
      type: 'buyin',
      player: realName,
      amount: amount,
      method: selectedMethod,
      paid: paid,
      buyinKey: buyinKey
    });

    nameEl.value = '';
    amtEl.value = '';
    setMethod('cash');
    nameEl.focus();
  }

  function markPaidByKey(buyinKey) {
    // Find the original buyin event
    const buyin = events.find(e => e.type === 'buyin' && e.buyinKey === buyinKey);
    if (!buyin) return;
    // Check not already paid
    const alreadyPaid = events.some(e => e.type === 'paid' && e.buyinKey === buyinKey);
    if (alreadyPaid || buyin.paid) return;

    showConfirm('Mark ' + fmt(buyin.amount) + ' (' + methodLabel(buyin.method) + ') from ' + buyin.player + ' as received?', () => {
      addEvent({
        type: 'paid',
        player: buyin.player,
        amount: buyin.amount,
        method: buyin.method,
        buyinKey: buyinKey
      });
    });
  }

  function openCashoutModal() {
    const players = derivePlayers();
    const names = Object.keys(players);
    if (names.length === 0) return;
    const listEl = document.getElementById('cashout-list');
    listEl.innerHTML = names.map(n => {
      const p = players[n];
      return '<div style="display: flex; gap: 6px; align-items: center;">' +
        '<div style="flex: 1; font-size: 14px;"><div style="font-weight: 500;">' + escapeHtml(n) + '</div>' +
        '<div style="font-size: 11px; color: #78716c;">In: ' + fmt(p.total) + '</div></div>' +
        '<input type="number" class="cashout-amt" data-name="' + escapeHtml(n) + '" placeholder="Out $" inputmode="numeric" style="width: 90px; height: 36px; margin: 0;" />' +
        '<button class="cashout-go primary" data-name="' + escapeHtml(n) + '" style="height: 36px; padding: 0 12px; font-size: 13px;">Go</button>' +
      '</div>';
    }).join('');
    document.querySelectorAll('.cashout-go').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        const input = document.querySelector('.cashout-amt[data-name="' + name + '"]');
        const amt = parseFloat(input.value);
        if (isNaN(amt) || amt < 0) { input.focus(); return; }
        cashOut(name, amt);
      });
    });
    document.getElementById('cashout-modal').classList.add('open');
  }

  function cashOut(name, finalAmount) {
    const players = derivePlayers();
    const p = players[name];
    if (!p) return;
    const unpaid = p.buyins.filter(b => !b.paid).reduce((s, b) => s + b.amount, 0);
    let msg = 'Cash out ' + name + '?\n(' + fmt(p.total) + ' in, ' + fmt(finalAmount) + ' out)';
    if (unpaid > 0) msg = 'WARNING: ' + fmt(unpaid) + ' unpaid.\n' + msg;
    showConfirm(msg, () => {
      addEvent({
        type: 'cashout',
        player: name,
        amount: finalAmount,
        totalIn: p.total,
        unpaid: unpaid
      });
      document.getElementById('cashout-modal').classList.remove('open');
    });
  }

  function endSession() {
    if (!session) return;
    showConfirm('End the session for everyone? This closes it on all phones. (Sheet keeps the log.)', () => {
      addEvent({ type: 'reset' });
      // Leave locally after the event uploads
      setTimeout(leaveSession, 1000);
    });
  }

  function leaveSession() {
    stopPolling();
    session = null;
    events = [];
    saveSession();
    // Don't clear queue — pending events will still flush
    render();
  }

  // ---------- Session create / join ----------

  async function createSession() {
    if (!cfg.sheetsUrl) { openSettings(); return; }
    const name = prompt('Your name (so others see who logged what):', actor || '');
    if (!name) return;
    actor = name.trim();
    saveActor();

    try {
      const r = await api({ action: 'create_session', host: actor, name: 'Session' });
      if (!r.ok) { alert('Failed to create session: ' + (r.error || 'unknown')); return; }
      session = { code: r.code };
      saveSession();
      loadEvents();
      render();
      startPolling();
      document.getElementById('created-code').textContent = r.code;
      document.getElementById('created-modal').classList.add('open');
    } catch (e) {
      alert('Network error. Check your sync settings.');
    }
  }

  async function joinSession() {
    const code = document.getElementById('join-code').value.trim();
    const name = document.getElementById('join-name').value.trim();
    const errEl = document.getElementById('join-err');
    errEl.classList.add('hidden');
    if (!code || code.length < 3) { errEl.textContent = 'Enter the session code'; errEl.classList.remove('hidden'); return; }
    if (!name) { errEl.textContent = 'Enter your name'; errEl.classList.remove('hidden'); return; }
    if (!cfg.sheetsUrl) { openSettings(); return; }

    actor = name;
    saveActor();

    try {
      const r = await api({ action: 'join_session', code: code });
      if (!r.ok) { errEl.textContent = r.error || 'Could not join'; errEl.classList.remove('hidden'); return; }
      session = { code: r.code };
      saveSession();
      loadEvents();
      render();
      startPolling();
    } catch (e) {
      errEl.textContent = 'Network error. Check your sync settings.';
      errEl.classList.remove('hidden');
    }
  }

  // ---------- Settings ----------

  function openSettings() {
    document.getElementById('sheets-url').value = cfg.sheetsUrl || '';
    document.getElementById('sheets-secret').value = cfg.secret || '';
    document.getElementById('test-result').textContent = '';
    document.getElementById('settings-modal').classList.add('open');
  }
  function closeSettings() { document.getElementById('settings-modal').classList.remove('open'); }
  function saveSettings() {
    cfg.sheetsUrl = document.getElementById('sheets-url').value.trim();
    cfg.secret = document.getElementById('sheets-secret').value.trim();
    saveCfg();
    closeSettings();
    flushQueue();
    render();
  }
  async function testSync() {
    const url = document.getElementById('sheets-url').value.trim();
    const secret = document.getElementById('sheets-secret').value.trim();
    const out = document.getElementById('test-result');
    if (!url) { out.textContent = 'Enter a URL first'; out.style.color = '#991b1b'; return; }
    out.textContent = 'Testing...'; out.style.color = '#57534e';
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ secret, action: 'ping' })
      });
      const result = await resp.json();
      if (result.ok && result.pong) { out.textContent = '✓ Connection works'; out.style.color = '#166534'; }
      else if (result.ok) { out.textContent = '✓ Connected (but old script version — redeploy with latest apps-script.js)'; out.style.color = '#92400e'; }
      else { out.textContent = '✗ ' + (result.error || 'failed'); out.style.color = '#991b1b'; }
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.style.color = '#991b1b';
    }
  }

  // ---------- Wire up ----------

  loadCfg();
  loadActor();
  loadSession();
  loadEvents();
  loadQueue();
  setMethod('cash');
  render();

  if (session) startPolling();
  if (queue.length) flushQueue();

  // Welcome screen
  document.getElementById('btn-create').addEventListener('click', createSession);
  document.getElementById('btn-join').addEventListener('click', joinSession);
  document.getElementById('welcome-settings').addEventListener('click', e => { e.preventDefault(); openSettings(); });
  document.getElementById('go-to-settings').addEventListener('click', e => { e.preventDefault(); openSettings(); });

  // Session screen
  document.getElementById('add-btn').addEventListener('click', addBuyin);
  document.getElementById('amount-input').addEventListener('keydown', e => { if (e.key === 'Enter') addBuyin(); });
  document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('amount-input').focus(); });
  document.querySelectorAll('.quick').forEach(btn => btn.addEventListener('click', () => { document.getElementById('amount-input').value = btn.dataset.amt; }));
  document.querySelectorAll('.pay-method').forEach(btn => btn.addEventListener('click', () => setMethod(btn.dataset.method)));

  document.getElementById('confirm-yes').addEventListener('click', () => { if (pendingAction) pendingAction(); hideConfirm(); });
  document.getElementById('confirm-no').addEventListener('click', hideConfirm);

  document.getElementById('cashout-btn').addEventListener('click', openCashoutModal);
  document.getElementById('cashout-cancel').addEventListener('click', () => document.getElementById('cashout-modal').classList.remove('open'));

  document.getElementById('leave-btn').addEventListener('click', () => {
    showConfirm('Leave this session? (Others can keep using it.)', leaveSession);
  });
  document.getElementById('end-btn').addEventListener('click', endSession);

  document.getElementById('settings-link').addEventListener('click', e => { e.preventDefault(); openSettings(); });
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-save').addEventListener('click', saveSettings);
  document.getElementById('test-sync').addEventListener('click', testSync);

  // Code pill tap-to-copy
  document.getElementById('code-pill').addEventListener('click', () => {
    if (!session) return;
    if (navigator.clipboard) navigator.clipboard.writeText(session.code).catch(() => {});
    const el = document.getElementById('code-pill');
    const orig = el.textContent;
    el.textContent = 'copied';
    setTimeout(() => { el.textContent = session ? session.code : orig; }, 800);
  });

  // Session created modal
  document.getElementById('created-ok').addEventListener('click', () => document.getElementById('created-modal').classList.remove('open'));
  document.getElementById('copy-code').addEventListener('click', () => {
    const code = document.getElementById('created-code').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    document.getElementById('copy-code').textContent = 'Copied';
    setTimeout(() => { document.getElementById('copy-code').textContent = 'Copy code'; }, 1000);
  });

  // Code input: strip non-digits
  document.getElementById('join-code').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
  });

  // PWA service worker
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(() => {}); }
})();
