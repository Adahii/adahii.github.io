# Poker Buy-in Tracker

A mobile-friendly web app for tracking cash game buy-ins and payment confirmations. Runs on GitHub Pages, works offline, syncs to a Google Sheet as a live audit log.

## What it does

- Log every buy-in as it happens (cash, Venmo, Zelle, or IOU)
- Tap unpaid buy-ins to confirm payment landed
- Shows total on table vs unpaid at a glance
- Warns you before cashing out a player who still owes money
- Syncs everything to your own Google Sheet in real time
- Survives phone restarts, dead batteries, and browser crashes (local storage + cloud backup)

## Deploy to GitHub Pages

1. Create a new GitHub repository (public).
2. Upload all files in this folder to the repo root.
3. Settings → Pages → Source: `main` branch, `/` (root). Save.
4. In a minute your app is live at `https://yourusername.github.io/reponame/`.
5. Open that URL on your iPhone in Safari.
6. Tap the Share button → Add to Home Screen. Now it launches like a native app.

## Set up Google Sheets sync (5 minutes)

1. Create a new Google Sheet. Any name works.
2. In the sheet: Extensions → Apps Script.
3. Delete the default code. Paste the entire contents of `apps-script.js`.
4. (Optional but recommended) Change the `SECRET` value at the top to any random string. You'll paste the same string into the app.
5. Click Deploy → New deployment.
   - Click the gear icon → select "Web app"
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click Deploy. Authorize when prompted (you're authorizing your own script to write to your own sheet).
7. Copy the Web app URL shown.
8. In the app, tap Settings. Paste the URL and your secret. Tap Test connection. Save.

Done. Every buy-in, payment, and cashout now appends a row to the `Events` tab of your sheet. The `Sessions` tab keeps a running summary of each session.

## Files

- `index.html` — the app UI
- `app.js` — app logic, local storage, sync queue
- `apps-script.js` — paste into Google Apps Script
- `manifest.json` — PWA manifest for "Add to Home Screen"
- `sw.js` — service worker for offline support
- `icon.png` — app icon

## How sync reliability works

The app is "offline-first." Every event saves to the phone's local storage immediately, then queues for upload to the sheet. If the phone loses signal, the queue keeps building locally. When connectivity returns, everything flushes automatically. The badge in the top-right shows sync status:

- `local only` — no sheet configured, phone is the only record
- `✓ synced` — sheet has everything
- `syncing N` — N events still uploading
- `retry N` — upload failed, will retry every 10 seconds

Even if you drop the phone in a lake mid-session, the sheet has every event you logged up to the last successful sync.

## Enforcement rules

The app doesn't magically prevent theft — it just makes it visible. Pair it with these house rules:

1. The host is the only one who touches the chip rack.
2. No chips leave the rack until the host has logged the buy-in.
3. The host speaks each entry out loud while logging: *"Dave, two hundred, Venmo — confirm?"*
4. "On table" total should equal cash in the box at all times.
5. Nobody cashes out until their Unpaid counter is zero.
6. End of night: sum of cashouts should equal the total-in minus any rake. If it doesn't balance, the Sessions tab in your sheet tells you which session it was and the Events tab shows every row.
