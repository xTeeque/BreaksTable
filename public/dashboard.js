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

// --- Global buttons (admin) ---
document.addEventListener("click", async (e) => {
  const t = e.target;

  // Clear-all
  if (t.closest("#btn-clear-all")) {
    e.preventDefault();
    if (!confirm("לבצע ניקוי כללי של כל המשבצות?")) return;
    try { await postJSON("/admin/clear-all", {}); location.reload(); }
    catch (err) { alert("נכשל ניקוי כללי: " + (err.message || err)); }
    return;
  }

  // Add hour
  if (t.closest("#btn-hour-add")) {
    const time = prompt("הזן שעה בפורמט HH:mm (למשל 15:30):", "");
    if (!time) return;
    try { await postJSON("/admin/hours/add", { time_label: time.trim() }); location.reload(); }
    catch (err) { alert("נכשל הוספת שעה: " + (err.message || err)); }
    return;
  }

  // Rename hour
  const renameBtn = t.closest("[data-action='hour-rename']");
  if (renameBtn) {
    const oldTime = renameBtn.dataset.time;
    const newTime = prompt(`שנה שעה ${oldTime} ל- (HH:mm):`, oldTime);
    if (!newTime || newTime === oldTime) return;
    try { await postJSON("/admin/hours/rename", { old_time_label: oldTime, new_time_label: newTime.trim() }); location.reload(); }
    catch (err) { alert("נכשל שינוי שעה: " + (err.message || err)); }
    return;
  }

  // Delete hour
  const delBtn = t.closest("[data-action='hour-delete']");
  if (delBtn) {
    const time = delBtn.dataset.time;
    if (!confirm(`למחוק את השעה ${time} (ימחק גם את המשבצות שלה)?`)) return;
    try { await postJSON("/admin/hours/delete", { time_label: time }); location.reload(); }
    catch (err) { alert("נכשל מחיקת שעה: " + (err.message || err)); }
    return;
  }
});

// --- Per-cell actions ---
document.addEventListener("click", async (e) => {
  const cell = e.target.closest("[data-slot-id]");
  if (!cell) return;

  const isAdmin = document.body.dataset.role === "admin";
  const slotId = Number(cell.dataset.slotId);
  const mine = cell.dataset.mine === "1";
  const taken = cell.dataset.taken === "1";
  const active = cell.dataset.active === "1";

  // Admin actions on cell
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
    const name = prompt("שם שיוצג למשבצת: (ננקה רישום קיים וננעל את המשבצת)", "");
    if (name === null) return;
    try { await postJSON(`/admin/slots/${slotId}/label`, { label: name.trim(), lock: true }); location.reload(); }
    catch (err) { alert(err.message); }
    return;
  }

  // User actions
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

// --- Socket.IO live updates (safe if not loaded) ---
(function initRealtime(){
  try {
    if (typeof io === "undefined") return;
    const socket = io({ transports: ["websocket", "polling"] });
    socket.on("slots:update", () => location.reload());
  } catch { /* no-op */ }
})();
