// Poker Buy-in Tracker
// Stores locally, syncs to Google Sheets when configured.

(function () {
  const STATE_KEY = 'poker-state-v3';
  const LOG_KEY = 'poker-log-v3';
  const QUEUE_KEY = 'poker-syncqueue-v3';
  const CFG_KEY = 'poker-config-v3';
  const SESSION_KEY = 'poker-session-v3';

  let state = { players: {} };
  let log = [];
  let queue = []; // pending sync events
  let cfg = { sheetsUrl: '', secret: '' };
  let sessionId = null;
  let pendingAction = null;
  let selectedMethod = 'cash';
  let syncing = false;

  // ---------- Storage ----------

  function loadAll() {
    try {
      const s = localStorage.getItem(STATE_KEY);
      if (s) state = JSON.parse(s);
    } catch (e) {}
    try {
      const l = localStorage.getItem(LOG_KEY);
      if (l) log = JSON.parse(l);
    } catch (e) {}
    try {
      const q = localStorage.getItem(QUEUE_KEY);
      if (q) queue = JSON.parse(q);
    } catch (e) {}
    try {
      const c = localStorage.getItem(CFG_KEY);
      if (c) cfg = Object.assign(cfg, JSON.parse(c));
    } catch (e) {}
    sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = newSessionId();
      localStorage.setItem(SESSION_KEY, sessionId);
    }
  }

  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch (e) {}
  }
  function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  function newSessionId() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '-' +
           pad(d.getHours()) + pad(d.getMinutes()) + '-' +
           Math.random().toString(36).slice(2, 6);
  }

  // ---------- Formatting ----------

  function fmt(n) { return '$' + Math.round(n).toLocaleString(); }
  function timestamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function isoNow() { return new Date().toISOString(); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function methodLabel(m) {
    return { cash: 'Cash', venmo: 'Venmo', zelle: 'Zelle', owed: 'Owed' }[m] || m;
  }

  // ---------- Sync ----------

  function enqueue(ev) {
    ev.id = ev.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    ev.sessionId = sessionId;
    ev.timestamp = ev.timestamp || isoNow();
    queue.push(ev);
    saveQueue();
    flushQueue();
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
      const resp = await fetch(cfg.sheetsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ secret: cfg.secret || '', events: batch })
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const result = await resp.json();
      if (!result.ok) throw new Error(result.error || 'unknown');

      // remove synced events
      queue = queue.slice(batch.length);
      saveQueue();
      updateSyncBadge(queue.length ? 'syncing' : 'synced');
      if (queue.length) setTimeout(flushQueue, 100);
    } catch (e) {
      console.warn('Sync failed:', e);
      updateSyncBadge('error');
      setTimeout(() => { syncing = false; flushQueue(); }, 10000);
      return;
    }
    syncing = false;
  }

  function updateSyncBadge(status) {
    const el = document.getElementById('sync-badge');
    el.className = 'sync-badge';
    if (!cfg.sheetsUrl) {
      el.classList.add('local'); el.textContent = 'local only'; return;
    }
    if (status === 'synced') { el.classList.add('synced'); el.textContent = '✓ synced'; }
    else if (status === 'syncing') { el.classList.add('syncing'); el.textContent = 'syncing ' + queue.length; }
    else if (status === 'offline') { el.classList.add('error'); el.textContent = 'offline ' + queue.length; }
    else if (status === 'error') { el.classList.add('error'); el.textContent = 'retry ' + queue.length; }
    else { el.classList.add('local'); el.textContent = 'local'; }
  }

  window.addEventListener('online', flushQueue);
  setInterval(() => { if (queue.length) flushQueue(); }, 15000);

  // ---------- Rendering ----------

  function render() {
    const names = Object.keys(state.players);
    const total = names.reduce((s, n) => s + state.players[n].total, 0);
    const unpaid = names.reduce((s, n) => {
      return s + state.players[n].buyins.filter(b => !b.paid).reduce((x, b) => x + b.amount, 0);
    }, 0);

    document.getElementById('stat-players').textContent = names.length;
    document.getElementById('stat-total').textContent = fmt(total);
    document.getElementById('stat-unpaid').textContent = fmt(unpaid);

    const listEl = document.getElementById('player-list');
    if (names.length === 0) {
      listEl.innerHTML = '<div class="empty">No buy-ins yet</div>';
    } else {
      const sorted = names.sort((a, b) => state.players[b].total - state.players[a].total);
      listEl.innerHTML = sorted.map(n => {
        const p = state.players[n];
        const hasUnpaid = p.buyins.some(b => !b.paid);
        const badges = p.buyins.map((b, i) => {
          const cls = b.paid ? 'paid' : (b.method === 'owed' ? 'owed' : 'pending');
          const check = b.paid ? '✓ ' : '';
          return '<span class="badge ' + cls + '" data-player="' + escapeHtml(n) + '" data-idx="' + i + '">' + check + fmt(b.amount) + ' ' + methodLabel(b.method) + '</span>';
        }).join('');
        return '<div class="player ' + (hasUnpaid ? 'has-unpaid' : '') + '">' +
          '<div class="player-row">' +
            '<div class="player-name">' + escapeHtml(n) + '</div>' +
            '<div class="player-total">' + fmt(p.total) + '</div>' +
          '</div>' +
          '<div class="badges">' + badges + '</div>' +
        '</div>';
      }).join('');

      document.querySelectorAll('.badge').forEach(badge => {
        badge.addEventListener('click', () => {
          const name = badge.dataset.player;
          const idx = parseInt(badge.dataset.idx);
          togglePaid(name, idx);
        });
      });
    }

    const logEl = document.getElementById('log');
    if (log.length === 0) {
      logEl.textContent = 'Empty';
    } else {
      logEl.innerHTML = log.slice().reverse().map(e => {
        if (e.type === 'buyin') return e.time + '  +  ' + escapeHtml(e.name) + '  ' + fmt(e.amount) + '  ' + methodLabel(e.method);
        if (e.type === 'paid') return e.time + '  ✓  ' + escapeHtml(e.name) + '  ' + fmt(e.amount) + '  paid (' + methodLabel(e.method) + ')';
        if (e.type === 'cashout') return e.time + '  −  ' + escapeHtml(e.name) + '  cashed out' + (e.finalAmount != null ? '  (' + fmt(e.finalAmount) + ')' : '');
        if (e.type === 'reset') return e.time + '  ⎯  session ended';
        return '';
      }).join('<br>');
    }

    updateSyncBadge(queue.length ? 'syncing' : 'synced');
  }

  // ---------- Actions ----------

  function showConfirm(msg, onYes) {
    pendingAction = onYes;
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-row').style.display = 'block';
  }
  function hideConfirm() {
    pendingAction = null;
    document.getElementById('confirm-row').style.display = 'none';
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

    const existing = Object.keys(state.players).find(k => k.toLowerCase() === name.toLowerCase());
    const realName = existing || name;
    if (!state.players[realName]) state.players[realName] = { total: 0, buyins: [] };

    const paid = selectedMethod === 'cash';
    state.players[realName].total += amount;
    state.players[realName].buyins.push({ amount, method: selectedMethod, paid, addedAt: isoNow() });

    const time = timestamp();
    log.push({ type: 'buyin', name: realName, amount, method: selectedMethod, time });

    enqueue({
      type: 'buyin',
      player: realName,
      amount,
      method: selectedMethod,
      paid,
      time
    });

    nameEl.value = '';
    amtEl.value = '';
    setMethod('cash');
    nameEl.focus();
    saveState();
    render();
  }

  function togglePaid(name, idx) {
    const p = state.players[name];
    if (!p || !p.buyins[idx]) return;
    const b = p.buyins[idx];
    if (b.paid) return;

    showConfirm('Mark ' + fmt(b.amount) + ' (' + methodLabel(b.method) + ') from ' + name + ' as received?', () => {
      b.paid = true;
      b.paidAt = isoNow();
      const time = timestamp();
      log.push({ type: 'paid', name, amount: b.amount, method: b.method, time });
      enqueue({ type: 'paid', player: name, amount: b.amount, method: b.method, time });
      saveState();
      render();
    });
  }

  function cashOut(name, finalAmount) {
    const p = state.players[name];
    if (!p) return;
    const unpaid = p.buyins.filter(b => !b.paid).reduce((s, b) => s + b.amount, 0);
    let msg = 'Cash out ' + name + '?\n(' + fmt(p.total) + ' in, ' + fmt(finalAmount) + ' out)';
    if (unpaid > 0) msg = 'WARNING: ' + fmt(unpaid) + ' unpaid.\n' + msg;

    showConfirm(msg, () => {
      const time = timestamp();
      log.push({ type: 'cashout', name, finalAmount, time });
      enqueue({ type: 'cashout', player: name, amount: finalAmount, totalIn: p.total, unpaid, time });
      delete state.players[name];
      saveState();
      render();
      document.getElementById('cashout-modal').classList.remove('open');
    });
  }

  function resetSession() {
    const hasData = Object.keys(state.players).length > 0 || log.length > 0;
    if (!hasData) return;
    showConfirm('End session? All data clears from this phone. (Google Sheet keeps the log.)', () => {
      const time = timestamp();
      log.push({ type: 'reset', time });
      enqueue({ type: 'reset', time });
      state = { players: {} };
      log = [];
      sessionId = newSessionId();
      localStorage.setItem(SESSION_KEY, sessionId);
      saveState();
      render();
    });
  }

  // ---------- Cashout modal ----------

  function openCashoutModal() {
    const names = Object.keys(state.players);
    if (names.length === 0) return;
    const listEl = document.getElementById('cashout-list');
    listEl.innerHTML = names.map(n => {
      const p = state.players[n];
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

  // ---------- Settings modal ----------

  function openSettings() {
    document.getElementById('sheets-url').value = cfg.sheetsUrl || '';
    document.getElementById('sheets-secret').value = cfg.secret || '';
    document.getElementById('test-result').textContent = '';
    document.getElementById('settings-modal').classList.add('open');
  }
  function closeSettings() {
    document.getElementById('settings-modal').classList.remove('open');
  }
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
        body: JSON.stringify({ secret, events: [{ type: 'ping', sessionId: 'test', timestamp: isoNow() }] })
      });
      const result = await resp.json();
      if (result.ok) { out.textContent = '✓ Connection works'; out.style.color = '#166534'; }
      else { out.textContent = '✗ ' + (result.error || 'failed'); out.style.color = '#991b1b'; }
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.style.color = '#991b1b';
    }
  }

  // ---------- Wire up ----------

  loadAll();
  setMethod('cash');
  render();
  if (cfg.sheetsUrl && queue.length) flushQueue();

  document.getElementById('add-btn').addEventListener('click', addBuyin);
  document.getElementById('amount-input').addEventListener('keydown', e => { if (e.key === 'Enter') addBuyin(); });
  document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('amount-input').focus(); });

  document.querySelectorAll('.quick').forEach(btn => {
    btn.addEventListener('click', () => { document.getElementById('amount-input').value = btn.dataset.amt; });
  });
  document.querySelectorAll('.pay-method').forEach(btn => {
    btn.addEventListener('click', () => setMethod(btn.dataset.method));
  });

  document.getElementById('confirm-yes').addEventListener('click', () => {
    if (pendingAction) pendingAction();
    hideConfirm();
  });
  document.getElementById('confirm-no').addEventListener('click', hideConfirm);

  document.getElementById('cashout-btn').addEventListener('click', openCashoutModal);
  document.getElementById('cashout-cancel').addEventListener('click', () => {
    document.getElementById('cashout-modal').classList.remove('open');
  });
  document.getElementById('reset-btn').addEventListener('click', resetSession);

  document.getElementById('settings-link').addEventListener('click', e => { e.preventDefault(); openSettings(); });
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-save').addEventListener('click', saveSettings);
  document.getElementById('test-sync').addEventListener('click', testSync);
  document.getElementById('show-setup').addEventListener('click', e => {
    e.preventDefault();
    const b = document.getElementById('setup-block');
    b.style.display = b.style.display === 'none' ? 'block' : 'none';
  });

  // PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
