# Poker Buy-in Tracker (multi-device)

A mobile-friendly web app for tracking cash game buy-ins and payment confirmations. Anyone at the table can join a shared session with a 4-digit code and log buy-ins, mark payments, or cash out players. All devices stay in sync via a Google Sheet that doubles as a permanent audit log.

## How it works

**One person starts a session.** They tap "Start new session" and get a 4-digit code like `7823`.

**Everyone else joins with the code.** They go to the same URL, tap "Join session," enter the code and their name. Now they're editing the same shared session.

**Every change syncs to Google Sheets.** Each device polls every 5 seconds for changes from others. You'll see buy-ins, payment confirmations, and cashouts appear on your phone within ~5 seconds of someone else logging them.

**The sheet is the source of truth.** Every event is timestamped with who did it. If there's ever a dispute, the log tells the full story.

## Deploy to GitHub Pages

1. Create a new public GitHub repository.
2. Upload all files in this folder to the repo root.
3. Settings → Pages → Source: `main` branch, `/` (root). Save.
4. In a minute your app is live at `https://yourusername.github.io/reponame/`.
5. Open that URL on your iPhone in Safari.
6. Tap the Share button → Add to Home Screen. Share this URL with other players.

## Set up Google Sheets sync (required for multi-device)

This is required — without it, the session codes don't work because there's no shared backend.

1. Create a new Google Sheet. Any name works.
2. In the sheet: Extensions → Apps Script.
3. Delete the default code. Paste the entire contents of `apps-script.js`.
4. (Optional) Change `SECRET` at the top to any random string.
5. Click Deploy → New deployment.
   - Click the gear icon → select "Web app"
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click Deploy. Authorize when prompted.
7. Copy the Web app URL.
8. Open the app → tap "⚙ Sync settings" → paste the URL (and secret, if set) → Test connection → Save.

**Important:** all players must use the same Apps Script URL to join the same sessions. The easiest way is: you set it up, then share both the GitHub Pages URL and the Apps Script URL with your group (in a group chat, say).

### If you're updating from an older version

You need to redeploy the script for the new endpoints to work. In Apps Script: Deploy → Manage deployments → pencil/edit icon → Version: **New version** → Deploy. The URL stays the same.

## Files

- `index.html` — UI
- `app.js` — app logic, local storage, sync queue, polling
- `apps-script.js` — paste into Google Apps Script
- `manifest.json` — PWA manifest
- `sw.js` — service worker for offline support
- `icon.png` — app icon

## Reliability

The app is "offline-first + shared log."

- Every change saves to the device's local storage immediately.
- Every change is queued for upload to the sheet.
- Every 5 seconds, the app checks the sheet for events it hasn't seen yet.
- If a phone loses connectivity mid-session, it keeps working locally; queued events upload when it reconnects.
- Events have unique IDs and are append-only, so concurrent edits from multiple phones don't conflict — each phone's events simply merge in.

Sync status is always visible in the top-right:
- `✓ synced` — all caught up with the sheet
- `syncing N` — N local events still uploading
- `retry N` — upload failed, will retry
- `offline N` — no connectivity

## Enforcement rules that make it work

Software alone doesn't prevent theft. Pair it with house rules:

1. The host is the only one who touches the chip rack.
2. No chips leave the rack until a buy-in is logged *and* visible on the host's phone (it'll appear via polling within 5s).
3. For Venmo/Zelle: the recipient is the only one who taps "paid." Don't let the sender confirm their own payment.
4. "On table" total must equal cash in the box at all times.
5. Nobody cashes out until their Unpaid counter is zero.
6. End of night: sum of cashouts should equal total-in. If it doesn't balance, the Events tab has every row with who logged it.

## Limitations

- Polling delay is ~5 seconds, not instant. For a poker game this is fine.
- Google Apps Script has daily quota limits (~20k URL fetches/day, plenty for home games). Don't share the URL publicly or bots will drain it.
- Session codes are 4 digits = 9000 possibilities. Fine for dozens of concurrent sessions, but if you ever want to scale beyond that, switch to longer codes in `apps-script.js` `generateSessionCode()`.
