// public/dashboard.js

// ================= Utils =================
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

// מניעת דאבל-קליק / ספאם פעולות
let actionBusy = false;
function lockActions() { actionBusy = true; document.body.style.pointerEvents = "none"; }
function unlockActions() { actionBusy = false; document.body.style.pointerEvents = ""; }

// ================= Global admin buttons =================
document.addEventListener("click", async (e) => {
  const t = e.target;

  // ניקוי כללי
  const clearAllBtn = t.closest("#btn-clear-all");
  if (clearAllBtn) {
    e.preventDefault();
    if (!confirm("לבצע ניקוי כללי של כל המשבצות?")) return;
    try {
      lockActions();
      await postJSON("/admin/clear-all", {});
      location.reload(); // Socket.IO גם ישדר; זה גיבוי מיידי
    } catch (err) {
      alert("נכשל ניקוי כללי: " + (err.message || err));
    } finally {
      unlockActions();
    }
    return;
  }

  // הוספת שעה
  const addHourBtn = t.closest("#btn-hour-add");
  if (addHourBtn) {
    const time = prompt("הזן שעה בפורמט HH:mm (למשל 15:30):", "");
    if (!time) return;
    try {
      lockActions();
      await postJSON("/admin/hours/add", { time_label: time.trim() });
      location.reload();
    } catch (err) {
      alert("נכשל הוספת שעה: " + (err.message || err));
    } finally {
      unlockActions();
    }
    return;
  }

  // שינוי שעה
  const renameBtn = t.closest("[data-action='hour-rename']");
  if (renameBtn) {
    const oldTime = renameBtn.dataset.time;
    const newTime = prompt(`שנה שעה ${oldTime} ל- (HH:mm):`, oldTime);
    if (!newTime || newTime === oldTime) return;
    try {
      lockActions();
      await postJSON("/admin/hours/rename", { old_time_label: oldTime, new_time_label: newTime.trim() });
      location.reload();
    } catch (err) {
      alert("נכשל שינוי שעה: " + (err.message || err));
    } finally {
      unlockActions();
    }
    return;
  }

  // מחיקת שעה
  const delBtn = t.closest("[data-action='hour-delete']");
  if (delBtn) {
    const time = delBtn.dataset.time;
    if (!confirm(`למחוק את השעה ${time} (ימחק גם את המשבצות שלה)?`)) return;
    try {
      lockActions();
      await postJSON("/admin/hours/delete", { time_label: time });
      location.reload();
    } catch (err) {
      alert("נכשל מחיקת שעה: " + (err.message || err));
    } finally {
      unlockActions();
    }
    return;
  }
});

// ================= Per-slot actions (admin + user) =================
document.addEventListener("click", async (e) => {
  const cell = e.target.closest("[data-slot-id]");
  if (!cell) return;

  const isAdmin = document.body.dataset.role === "admin";
  const slotId = Number(cell.dataset.slotId);
  const mine = cell.dataset.mine === "1";
  const taken = cell.dataset.taken === "1";
  const active = cell.dataset.active === "1";

  // ---- Admin actions on a single cell ----
  if (isAdmin && e.target.closest("[data-action='clear']")) {
    try {
      lockActions();
      await postJSON(`/admin/slots/${slotId}/clear`, {});
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      unlockActions();
    }
    return;
  }

  if (isAdmin && e.target.closest("[data-action='open']")) {
    try {
      lockActions();
      await postJSON(`/admin/slots/${slotId}/active`, { active: true });
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      unlockActions();
    }
    return;
  }

  if (isAdmin && e.target.closest("[data-action='close']")) {
    try {
      lockActions();
      await postJSON(`/admin/slots/${slotId}/active`, { active: false });
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      unlockActions();
    }
    return;
  }

  if (isAdmin && e.target.closest("[data-action='label']")) {
    const name = prompt("שם שיוצג למשבצת: (ננקה רישום קיים וננעל את המשבצת)", "");
    if (name === null) return;
    try {
      lockActions();
      await postJSON(`/admin/slots/${slotId}/label`, { label: name.trim(), lock: true });
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      unlockActions();
    }
    return;
  }

  // ---- User actions (reserve / unreserve) ----
  try {
    if (actionBusy) return;  // מניעת דאבל-קליק
    if (!active) return;     // תא סגור

    lockActions();

    if (!mine && !taken) {
      // ניסיון תפיסה
      await postJSON(`/reserve/${slotId}`, {});
    } else if (mine) {
      // ביטול
      await postJSON(`/unreserve`, {});
    } else {
      // תפוס אצל אחר
      return;
    }

    // השרת משדר slots:update ב-Socket.IO, אבל נרענן גם מיד כדי לצמצם דיליי
    location.reload();
  } catch (err) {
    const msg = (err.message || "").toLowerCase();
    if (msg.includes("already reserved")) {
      alert("מישהו אחר תפס את המשבצת רגע לפניך. נסה לבחור משבצת אחרת 🙏");
    } else if (msg.includes("not active")) {
      alert("המשבצת סגורה כרגע.");
    } else {
      alert(err.message || "Action failed");
    }
  } finally {
    unlockActions();
  }
});

// ================= Socket.IO live updates (failsafe) =================
(function initRealtime(){
  try {
    if (typeof io === "undefined") return;
    const socket = io({ transports: ["websocket", "polling"] });
    socket.on("slots:update", () => location.reload());
  } catch { /* no-op */ }
})();
