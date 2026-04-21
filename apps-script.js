// ============================================================
// Poker Tracker — Google Apps Script backend
// ============================================================
// SETUP:
// 1. Create a new Google Sheet (name it whatever you want)
// 2. Extensions → Apps Script
// 3. Delete the default code and paste THIS ENTIRE FILE
// 4. (Optional) Change SECRET below to any string you want
// 5. Click Deploy → New deployment
//    - Type: Web app
//    - Execute as: Me
//    - Who has access: Anyone
// 6. Click Deploy, authorize when prompted
// 7. Copy the Web app URL, paste it into the tracker's Settings
// ============================================================

// Set this to any string. Must match the "Session secret" in the app's settings.
// Leave as empty string '' to skip auth (not recommended if your URL leaks).
const SECRET = '';

// Sheet tab names (auto-created)
const EVENTS_SHEET = 'Events';
const SESSIONS_SHEET = 'Sessions';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET && body.secret !== SECRET) {
      return json({ ok: false, error: 'bad secret' });
    }
    const events = body.events || [];
    if (events.length === 0) {
      return json({ ok: true, written: 0 });
    }

    // Ping-only requests (from the "Test connection" button)
    const realEvents = events.filter(ev => ev.type !== 'ping');
    if (realEvents.length === 0) {
      return json({ ok: true, written: 0, pong: true });
    }

    writeEvents(realEvents);
    updateSessions(realEvents);

    return json({ ok: true, written: realEvents.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return json({ ok: true, message: 'Poker tracker backend is running.' });
}

function writeEvents(events) {
  const sheet = getOrCreateSheet(EVENTS_SHEET, [
    'Timestamp', 'Session', 'Type', 'Player', 'Amount', 'Method', 'Paid', 'Notes'
  ]);

  const rows = events.map(ev => {
    const ts = ev.timestamp ? new Date(ev.timestamp) : new Date();
    let notes = '';
    if (ev.type === 'cashout') {
      notes = 'in=' + (ev.totalIn || 0) + ' unpaid=' + (ev.unpaid || 0);
    }
    return [
      ts,
      ev.sessionId || '',
      ev.type || '',
      ev.player || '',
      ev.amount != null ? ev.amount : '',
      ev.method || '',
      ev.paid === true ? 'YES' : (ev.paid === false ? 'no' : ''),
      notes
    ];
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function updateSessions(events) {
  const sheet = getOrCreateSheet(SESSIONS_SHEET, [
    'Session', 'Started', 'Last activity', 'Buy-ins', 'Total in', 'Unpaid', 'Cashouts', 'Status'
  ]);

  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const rows = data.slice(1);
  const sessionMap = {};
  rows.forEach((r, i) => { if (r[0]) sessionMap[r[0]] = i + 2; });

  // Group by session
  const bySession = {};
  events.forEach(ev => {
    const sid = ev.sessionId || 'unknown';
    if (!bySession[sid]) bySession[sid] = [];
    bySession[sid].push(ev);
  });

  Object.keys(bySession).forEach(sid => {
    const evs = bySession[sid];
    const now = new Date();
    let rowIdx = sessionMap[sid];

    // Recompute aggregate from sheet events
    const allEvents = getAllEventsForSession(sid);
    const buyins = allEvents.filter(e => e.type === 'buyin');
    const paidIds = {};
    allEvents.filter(e => e.type === 'paid').forEach(e => {
      const k = e.player + '|' + e.amount + '|' + e.method;
      paidIds[k] = (paidIds[k] || 0) + 1;
    });
    let totalIn = 0;
    let unpaid = 0;
    buyins.forEach(b => {
      totalIn += Number(b.amount) || 0;
      const k = b.player + '|' + b.amount + '|' + b.method;
      const wasPaidAtBuy = b.paid === 'YES';
      if (!wasPaidAtBuy) {
        if (paidIds[k] && paidIds[k] > 0) { paidIds[k]--; }
        else { unpaid += Number(b.amount) || 0; }
      }
    });
    const cashouts = allEvents.filter(e => e.type === 'cashout').length;
    const hasReset = allEvents.some(e => e.type === 'reset');
    const status = hasReset ? 'ended' : 'active';

    const firstTs = allEvents.length ? allEvents[0].timestamp : now;

    const row = [sid, firstTs, now, buyins.length, totalIn, unpaid, cashouts, status];

    if (rowIdx) {
      sheet.getRange(rowIdx, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  });
}

function getAllEventsForSession(sid) {
  const sheet = getOrCreateSheet(EVENTS_SHEET, [
    'Timestamp', 'Session', 'Type', 'Player', 'Amount', 'Method', 'Paid', 'Notes'
  ]);
  const data = sheet.getDataRange().getValues();
  return data.slice(1)
    .filter(r => r[1] === sid)
    .map(r => ({
      timestamp: r[0], sessionId: r[1], type: r[2],
      player: r[3], amount: r[4], method: r[5], paid: r[6]
    }));
}

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
