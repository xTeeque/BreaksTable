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
  return await res.json().catch(() => ({}));
}

function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

// --- Topbar actions ---
const btnClearAll = document.getElementById("btn-clear-all");
if (btnClearAll) {
  btnClearAll.addEventListener("click", async () => {
    if (!confirm("לנקות את כל המשבצות?")) return;
    try {
      await postJSON("/admin/clear-all", {});
      location.reload();
    } catch (err) {
      alert("נכשל ניקוי כללי: " + (err.message || err));
    }
  });
}

// --- Grid actions ---
const grid = document.getElementById("grid");
if (grid) {
  grid.addEventListener("click", async (e) => {
    const isAdmin = document.body.dataset.role === "admin";

    // משבצת רגילה
    const cell = e.target.closest("[data-slot-id]");
    if (!cell) return;

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
      try { await postJSON(`/admin/slots/${slotId}/label`, { label: String(name).trim() }); location.reload(); } catch (err) { alert(err.message); }
      return;
    }
    if (isAdmin && e.target.closest("[data-action='time']")) {
      const newTime = prompt("שעה חדשה (HH:MM):", "");
      if (newTime === null || !/^[0-2]\d:\d{2}$/.test(newTime)) return;
      try {
        await postJSON(`/admin/slots/update`, { slot_id: slotId, time_label: newTime });
        location.reload();
      } catch (err) { alert(err.message || "Failed"); }
      return;
    }

    // משתמש רגיל: הרשמה / ביטול
    try {
      if (!active) return;                 // סגור
      if (!mine && !taken)      { await postJSON(`/reserve/${slotId}`, {}); }
      else if (mine)            { await postJSON(`/unreserve`, {}); }
      else                      { return; }    // תפוס אצל אחר
      location.reload();
    } catch (err) {
      alert(err.message || "Action failed");
    }
  });

  // מחיקת משבצת (טופסי מחיקה)
  qsa('form[data-action="delete"]').forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const slotId = Number(form.querySelector('[name="slot_id"]').value);
      if (!confirm("למחוק את המשבצת?")) return;
      try {
        await postJSON(`/admin/slots/delete`, { slot_id: slotId });
        location.reload();
      } catch (err) { alert(err.message || "Delete failed"); }
    });
  });
}

// ---- Socket.IO (רענון חי) ----
(function initRealtime(){
  try {
    if (typeof io === "undefined") return;
    const socket = io({ transports: ["websocket", "polling"] });
    socket.on("slots:update", () => location.reload());
  } catch { /* no-op */ }
})();
