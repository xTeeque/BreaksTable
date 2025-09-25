// public/dashboard.js
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": window.CSRF_TOKEN
    },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json().catch(() => ({}));
}

document.addEventListener("click", async (e) => {
  const cell = e.target.closest("[data-slot-id]");
  if (!cell) return;

  const isTime = cell.dataset.isTime === "1";
  if (isTime) return;

  const isAdmin = document.body.dataset.role === "admin";
  const slotId = Number(cell.dataset.slotId);
  const mine = cell.dataset.mine === "1";
  const taken = cell.dataset.taken === "1";
  const active = cell.dataset.active === "1";

  // פעולות אדמין
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
    try {
      await postJSON(`/admin/slots/${slotId}/label`, { label: name.trim() });
      location.reload();
    } catch (err) { alert(err.message); }
    return;
  }

  // משתמש רגיל
  try {
    if (!active) return;             // סגור
    if (!mine && !taken) {
      await postJSON(`/reserve/${slotId}`, {});
    } else if (mine) {
      await postJSON(`/unreserve`, {});
    } else {
      return;                        // תפוס אצל אחר
    }
    location.reload();
  } catch (err) {
    alert(err.message || "Action failed");
  }
});
