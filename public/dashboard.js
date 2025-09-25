// public/dashboard.js
/* global io */
function safeIO() {
  try { return typeof io !== "undefined" ? io : null; } catch { return null; }
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": window.CSRF_TOKEN },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json().catch(() => ({}));
}

document.addEventListener("click", async (e) => {
  const cell = e.target.closest("[data-slot-id]");
  if (!cell) return;

  const isAdmin = document.body.dataset.role === "admin";
  const slotId = Number(cell.dataset.slotId);
  const mine = cell.dataset.mine === "1";
  const taken = cell.dataset.taken === "1";
  const active = cell.dataset.active === "1";

  // פעולות אדמין
  if (isAdmin && e.target.closest("[data-action='clear']")) {
    try { await postJSON(`/admin/slots/${slotId}/clear`, {}); } catch (err) { alert(err.message); }
    return;
  }
  if (isAdmin && e.target.closest("[data-action='open']")) {
    try { await postJSON(`/admin/slots/${slotId}/active`, { active: true }); } catch (err) { alert(err.message); }
    return;
  }
  if (isAdmin && e.target.closest("[data-action='close']")) {
    try { await postJSON(`/admin/slots/${slotId}/active`, { active: false }); } catch (err) { alert(err.message); }
    return;
  }
  if (isAdmin && e.target.closest("[data-action='label']")) {
    const name = prompt("שם שיוצג במשבצת (אפשר להשאיר ריק כדי לנקות):", "");
    if (name === null) return;
    try { await postJSON(`/admin/slots/${slotId}/label`, { label: name.trim() }); } catch (err) { alert(err.message); }
    return;
  }

  // כפתור ניקוי כללי לאדמין
document.addEventListener("click", async (e) => {
  const clearBtn = e.target.closest("#btn-clear-all");
  if (!clearBtn) return;

  e.preventDefault();

  if (!confirm("לבצע ניקוי כללי של כל המשבצות?")) return;

  try {
    const res = await fetch("/admin/clear-all", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": window.CSRF_TOKEN
      },
      body: "{}"
    });

    if (!res.ok) {
      const t = await res.text().catch(()=>"");
      throw new Error(t || ("HTTP " + res.status));
    }

    // השרת גם משדר Socket.IO, אבל נרענן מיד ליתר ביטחון
    location.reload();
  } catch (err) {
    alert("נכשל ניקוי כללי: " + (err.message || err));
  }
});


  
  // משתמש רגיל
  try {
    if (!active) return;             // סגור
    if (!mine && !taken)      await postJSON(`/reserve/${slotId}`, {});
    else if (mine)            await postJSON(`/unreserve`, {});
    else                      return; // תפוס אצל אחר
  } catch (err) { alert(err.message || "Action failed"); }
});

// ---- Socket.IO: האזנה לעדכונים ושידרוג UI מיידי ----
(function initRealtime(){
  const IO = safeIO();
  if (!IO) return; // אם לא נטען הלקוח, דלג בשקט
  const socket = IO({ transports: ["websocket", "polling"] });
  socket.on("slots:update", () => { location.reload(); });
})();

