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
const isAdmin = (document.body.dataset.role === "admin");

// --- Topbar actions ---
const btnClearAll = document.getElementById("btn-clear-all");
if (btnClearAll) {
  btnClearAll.addEventListener("click", async () => {
    if (!confirm("לנקות את כל המשבצות?")) return;
    try { await postJSON("/admin/clear-all", {}); location.reload(); }
    catch (err) { alert("נכשל ניקוי כללי: " + (err.message || err)); }
  });
}

const btnAddHour = document.getElementById("btn-add-hour");
if (btnAddHour) {
  btnAddHour.addEventListener("click", async () => {
    const tl = prompt("שעה חדשה (HH:MM):", "");
    if (tl === null) return;
    if (!/^[0-2]\d:\d{2}$/.test(tl)) { alert("פורמט שעה לא תקין (HH:MM)"); return; }
    try {
      await postJSON("/admin/hours/create", { time_label: tl });
      location.reload();
    } catch (err) { alert(err.message || "Create hour failed"); }
  });
}

// --- Grid actions ---
const grid = document.getElementById("grid");
if (grid) {
  grid.addEventListener("click", async (e) => {
    // מחיקת שעה שלמה
    const delHourBtn = e.target.closest("[data-action='delete-hour']");
    if (isAdmin && delHourBtn) {
      const time = delHourBtn.getAttribute("data-time") || delHourBtn.closest(".cell.time")?.getAttribute("data-time");
      if (!time) return;
      if (!confirm(`להסיר את כל המשבצות של השעה ${time}?`)) return;
      try {
        await postJSON("/admin/hours/delete", { time_label: time });
        location.reload();
      } catch (err) { alert(err.message || "Delete hour failed"); }
      return;
    }

    // עריכת שעה — כפתור ייעודי
    const renameHourBtn = e.target.closest("[data-action='rename-hour']");
    if (isAdmin && renameHourBtn) {
      const from = renameHourBtn.getAttribute("data-time") || renameHourBtn.closest(".cell.time")?.getAttribute("data-time");
      const to = prompt(`ערוך שעה (HH:MM)\nנוכחי: ${from}`, from);
      if (to === null || to === from) return;
      if (!/^[0-2]\d:\d{2}$/.test(to)) { alert("פורמט שעה לא תקין (HH:MM)"); return; }
      try {
        await postJSON("/admin/hours/rename", { from, to });
        location.reload();
      } catch (err) { alert(err.message || "Rename hour failed"); }
      return;
    }

    // עריכת שעה — עדיין אפשר גם בלחיצה על תא השעה (נשמרת תאימות)
    const timeCell = e.target.closest(".cell.time");
    if (isAdmin && timeCell) {
      const from = timeCell.getAttribute("data-time") || timeCell.textContent.trim();
      const to = prompt(`ערוך שעה (HH:MM)\nנוכחי: ${from}`, from);
      if (to === null || to === from) return;
      if (!/^[0-2]\d:\d{2}$/.test(to)) { alert("פורמט שעה לא תקין (HH:MM)"); return; }
      try {
        await postJSON("/admin/hours/rename", { from, to });
        location.reload();
      } catch (err) { alert(err.message || "Rename hour failed"); }
      return;
    }

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
      // השרת מנקה משתמש אם קיים ואז סוגר
      try { await postJSON(`/admin/slots/${slotId}/active`, { active: false }); location.reload(); } catch (err) { alert(err.message); }
      return;
    }
    if (isAdmin && e.target.closest("[data-action='label']")) {
      const name = prompt("שם שיוצג במשבצת (אפשר להשאיר ריק כדי לנקות):", "");
      if (name === null) return;
      try { await postJSON(`/admin/slots/${slotId}/label`, { label: String(name).trim() }); location.reload(); } catch (err) { alert(err.message); }
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
}

// ---- Socket.IO (רענון חי) ----
(function initRealtime(){
  try {
    if (typeof io === "undefined") return;
    const socket = io({ transports: ["websocket", "polling"] });
    socket.on("slots:update", () => location.reload());
  } catch { /* no-op */ }
})();
