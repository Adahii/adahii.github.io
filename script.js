// 1) Paste your Discord webhook URL here.
// Create one in: Server Settings -> Integrations -> Webhooks
const DISCORD_WEBHOOK_URL = "PASTE_YOUR_DISCORD_WEBHOOK_URL_HERE";

// 2) Optional: edit these display fields without touching HTML.
document.getElementById("champName").textContent = "TBD (Ask host)";
document.getElementById("champCut").textContent = "30";
document.getElementById("entryFee").textContent = "X Diamonds (example)";
document.getElementById("contactDiscord").textContent = "YOUR DISCORD";
document.getElementById("contactIGN").textContent = "YOUR IGN";

const form = document.getElementById("signupForm");
const statusEl = document.getElementById("status");

function setStatus(msg) {
  statusEl.textContent = msg;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("Sending...");

  // Honeypot check (bots)
  const hp = document.getElementById("website").value.trim();
  if (hp) {
    setStatus("Blocked.");
    return;
  }

  const data = new FormData(form);
  const ign = (data.get("ign") || "").toString().trim();
  const discord = (data.get("discord") || "").toString().trim();
  const timeWindow = (data.get("timeWindow") || "").toString().trim();
  const notes = (data.get("notes") || "").toString().trim();

  if (!ign || !discord || !timeWindow) {
    setStatus("Please fill required fields.");
    return;
  }

  // Discord webhook payload docs:
  // Discord webhooks accept JSON via POST. (We’re using a simple "content" message.)
  try {
    const content =
`🔥 **NEW CHALLENGE REQUEST**
**IGN:** ${ign}
**Discord:** ${discord}
**Preferred Time (ET):** ${timeWindow}
**Notes:** ${notes || "(none)"}
— Sent from Fight Club site`;

    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    form.reset();
    setStatus("Submitted! Check Discord for next steps.");
  } catch (err) {
    console.error(err);
    setStatus("Failed to send. Try again or DM host.");
  }
});
