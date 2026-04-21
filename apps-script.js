// ============================================================
// Poker Tracker — Google Apps Script backend (multi-device)
// ============================================================
// SETUP:
// 1. Create a new Google Sheet
// 2. Extensions → Apps Script
// 3. Delete the default code and paste THIS ENTIRE FILE
// 4. (Optional) Change SECRET below to any string
// 5. Deploy → New deployment → Web app
//    - Execute as: Me
//    - Who has access: Anyone
// 6. Copy the Web app URL, paste into the tracker's Settings
// 7. IMPORTANT: If you had an older version deployed, create a NEW
//    deployment (or update with "New version") so the new endpoints work.
// ============================================================

const SECRET = '';

const EVENTS_SHEET = 'Events';
const SESSIONS_SHEET = 'Sessions';

// ---------- Entry points ----------

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET && body.secret !== SECRET) {
      return json({ ok: false, error: 'bad secret' });
    }

    const action = body.action || 'write';

    if (action === 'ping') {
      return json({ ok: true, pong: true });
    }

    if (action === 'create_session') {
      const code = generateSessionCode();
      const name = body.name || 'Session';
      const host = body.host || '';
      writeSessionRow(code, name, host);
      return json({ ok: true, code: code });
    }

    if (action === 'join_session') {
      const code = (body.code || '').toString().trim().toUpperCase();
      const sess = findSession(code);
      if (!sess) return json({ ok: false, error: 'Session code not found' });
      if (sess.status === 'ended') return json({ ok: false, error: 'Session has ended' });
      return json({ ok: true, code: sess.code, name: sess.name, host: sess.host });
    }

    // Default: write events
    const events = body.events || [];
    if (events.length === 0) return json({ ok: true, written: 0 });

    writeEvents(events);
    updateSessions(events);

    return json({ ok: true, written: events.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action;

    if (!action) {
      return json({ ok: true, message: 'Poker tracker backend is running.' });
    }

    if (action === 'fetch') {
      const code = (params.code || '').toUpperCase();
      if (!code) return json({ ok: false, error: 'missing code' });
      const since = params.since ? parseInt(params.since) : 0;
      const events = getEventsForCode(code, since);
      const sess = findSession(code);
      return json({
        ok: true,
        code: code,
        session: sess || null,
        events: events,
        serverTime: Date.now()
      });
    }

    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ---------- Sessions ----------

function generateSessionCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!findSession(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function findSession(code) {
  if (!code) return null;
  const sheet = getOrCreateSheet(SESSIONS_SHEET, [
    'Code', 'Name', 'Host', 'Started', 'Last activity', 'Buy-ins', 'Total in', 'Unpaid', 'Cashouts', 'Status'
  ]);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toUpperCase() === String(code).toUpperCase()) {
      return {
        code: data[i][0],
        name: data[i][1],
        host: data[i][2],
        started: data[i][3],
        lastActivity: data[i][4],
        status: data[i][9] || 'active',
        rowIdx: i + 1
      };
    }
  }
  return null;
}

function writeSessionRow(code, name, host) {
  const sheet = getOrCreateSheet(SESSIONS_SHEET, [
    'Code', 'Name', 'Host', 'Started', 'Last activity', 'Buy-ins', 'Total in', 'Unpaid', 'Cashouts', 'Status'
  ]);
  const now = new Date();
  sheet.appendRow([code, name, host, now, now, 0, 0, 0, 0, 'active']);
}

// ---------- Events ----------

function writeEvents(events) {
  const sheet = getOrCreateSheet(EVENTS_SHEET, [
    'Timestamp', 'Session', 'EventId', 'Type', 'Player', 'Amount', 'Method', 'Paid', 'BuyinKey', 'Actor', 'Notes'
  ]);

  // Read existing IDs to dedupe
  const lastRow = sheet.getLastRow();
  const existingIds = {};
  if (lastRow > 1) {
    const idCol = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
    idCol.forEach(r => { if (r[0]) existingIds[r[0]] = true; });
  }

  const rows = [];
  events.forEach(ev => {
    if (ev.id && existingIds[ev.id]) return;
    const ts = ev.timestamp ? new Date(ev.timestamp) : new Date();
    let notes = '';
    if (ev.type === 'cashout') {
      notes = 'in=' + (ev.totalIn || 0) + ' unpaid=' + (ev.unpaid || 0);
    }
    rows.push([
      ts,
      (ev.sessionId || '').toUpperCase(),
      ev.id || '',
      ev.type || '',
      ev.player || '',
      ev.amount != null ? ev.amount : '',
      ev.method || '',
      ev.paid === true ? 'YES' : (ev.paid === false ? 'no' : ''),
      ev.buyinKey || '',
      ev.actor || '',
      notes
    ]);
  });

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function getEventsForCode(code, sinceMs) {
  const sheet = getOrCreateSheet(EVENTS_SHEET, [
    'Timestamp', 'Session', 'EventId', 'Type', 'Player', 'Amount', 'Method', 'Paid', 'BuyinKey', 'Actor', 'Notes'
  ]);
  const data = sheet.getDataRange().getValues();
  const out = [];
  const upperCode = String(code).toUpperCase();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).toUpperCase() !== upperCode) continue;
    const ts = data[i][0] instanceof Date ? data[i][0].getTime() : new Date(data[i][0]).getTime();
    if (sinceMs && ts <= sinceMs) continue;
    out.push({
      timestamp: ts,
      sessionId: data[i][1],
      id: data[i][2],
      type: data[i][3],
      player: data[i][4],
      amount: data[i][5],
      method: data[i][6],
      paid: data[i][7] === 'YES',
      buyinKey: data[i][8],
      actor: data[i][9],
      notes: data[i][10]
    });
  }
  return out;
}

function updateSessions(events) {
  const sheet = getOrCreateSheet(SESSIONS_SHEET, [
    'Code', 'Name', 'Host', 'Started', 'Last activity', 'Buy-ins', 'Total in', 'Unpaid', 'Cashouts', 'Status'
  ]);

  const bySession = {};
  events.forEach(ev => {
    const sid = (ev.sessionId || '').toUpperCase();
    if (!sid) return;
    if (!bySession[sid]) bySession[sid] = [];
    bySession[sid].push(ev);
  });

  Object.keys(bySession).forEach(sid => {
    const sess = findSession(sid);
    if (!sess) return;

    const allEvents = getEventsForCode(sid, 0);
    let totalIn = 0, unpaid = 0, buyins = 0, cashouts = 0;
    const paidKeys = {};
    allEvents.filter(e => e.type === 'paid').forEach(e => {
      paidKeys[e.buyinKey] = true;
    });
    allEvents.forEach(e => {
      if (e.type === 'buyin') {
        buyins++;
        totalIn += Number(e.amount) || 0;
        if (!e.paid && !paidKeys[e.buyinKey]) {
          unpaid += Number(e.amount) || 0;
        }
      } else if (e.type === 'cashout') {
        cashouts++;
      }
    });
    const hasReset = allEvents.some(e => e.type === 'reset');
    const status = hasReset ? 'ended' : 'active';

    sheet.getRange(sess.rowIdx, 5).setValue(new Date());
    sheet.getRange(sess.rowIdx, 6).setValue(buyins);
    sheet.getRange(sess.rowIdx, 7).setValue(totalIn);
    sheet.getRange(sess.rowIdx, 8).setValue(unpaid);
    sheet.getRange(sess.rowIdx, 9).setValue(cashouts);
    sheet.getRange(sess.rowIdx, 10).setValue(status);
  });
}

// ---------- Utils ----------

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3f4f6');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
