// public/dashboard.js

// --- Utils ---
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": window.CSRF_TOKEN || ""
    },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  try { return await res.json(); } catch { return {}; }
}

// ---- Registration / Admin per-cell actions (כבר אצלך, לא משנים) ----
document.addEventListener("click", async (e) => {
  // כפתור "ניקוי כללי" (Admin)
  const clearBtn = e.target.closest("#btn-clear-all");
  if (clearBtn) {
    e.preventDefault();
    if (!confirm("לבצע ניקוי כללי של כל המשבצות?")) return;
    try {
      await postJSON("/admin/clear-all", {});
      // השרת גם משדר sockets:update; נרענן מיד ליתר בטחון
      location.reload();
    } catch (err) {
      alert("נכשל ניקוי כללי: " + (err.message || err));
    }
    return;
  }

  // משבצת רגילה
  const cell = e.target.closest("[data-slot-id]");
  if (!cell) return;

  const isAdmin = document.body.dataset.role === "admin";
  const slotId = Number(cell.dataset.slotId);
  const mine = cell.dataset.mine === "1";
  const taken = cell.dataset.taken === "1";
  const active = cell.dataset.active === "1";

  // פעולות אדמין בתוך תא
  if (isAdmin && e.target.closest("[data-action='clear']")) {
    try { await postJSON(`/admin/slots/${slotId}/clear`, {}); location.reload(); } catch (err) { alert(err.message); }
    return;
  }
  if (isAdmin && e.target.closest("[data-action='open']")) {
    try { await postJSON(`/admin/slots/${slotId}/active`, { active: true }); location.reload(); } catch (err) { alert(err.message); }
    return;
  }
  if (isAdmin && e.target.closest("[data-action='close']")) {
    try { await postJSON(`/admin/slots/${slotId}/active`, { active: false }); location.reload(); } catch (err) { alert(err.message); }
    return;
  }
  if (isAdmin && e.target.closest("[data-action='label']")) {
    const name = prompt("שם שיוצג במשבצת (אפשר להשאיר ריק כדי לנקות):", "");
    if (name === null) return;
    try { await postJSON(`/admin/slots/${slotId}/label`, { label: name.trim() }); location.reload(); } catch (err) { alert(err.message); }
    return;
  }

  // משתמש רגיל: הרשמה / ביטול
  try {
    if (!active) return;                 // סגור
    if (!mine && !taken)      await postJSON(`/reserve/${slotId}`, {});
    else if (mine)            await postJSON(`/unreserve`, {});
    else                      return;    // תפוס אצל אחר
    location.reload();
  } catch (err) {
    alert(err.message || "Action failed");
  }
});

// ---- Socket.IO (לא חובה; מוגן אם הספרייה לא נטענה) ----
(function initRealtime(){
  try {
    if (typeof io === "undefined") return; // אם הלקוח לא טעון, דלג
    const socket = io({ transports: ["websocket", "polling"] });
    socket.on("slots:update", () => location.reload());
  } catch { /* no-op */ }
})();
