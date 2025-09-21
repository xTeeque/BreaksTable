// public/dashboard.js
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
  if (!cell || cell.classList.contains("time")) return;

  const isAdmin = document.body.dataset.role === "admin";
  const slotId = Number(cell.dataset.slotId);
  const reservedByMe = cell.dataset.reservedByMe === "1";
  const reservedByOther = cell.dataset.reservedByOther === "1";

  try {
    if (isAdmin && e.target.closest("[data-action='clear']")) {
      await postJSON(`/admin/slots/${slotId}/clear`, {});
    } else if (!reservedByMe && !reservedByOther) {
      await postJSON(`/reserve/${slotId}`, {});
    } else if (reservedByMe) {
      await postJSON(`/unreserve`, {});
    } else {
      // שמור/אל תעשה כלום – התא תפוס ע"י אחר
      return;
    }
    location.reload();
  } catch (err) {
    alert(err.message || "Action failed");
  }
});
