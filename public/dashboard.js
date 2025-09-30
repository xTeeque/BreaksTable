// public/dashboard.js
// מאזין לכל הכפתורים (יוזר ואדמין) בצורה לא פולשנית.
// כולל השגת CSRF אוטומטית כך שלא חייבים להזריק אותו ל-DOM.

(function () {
  // -------- CSRF ----------
  let __csrf = null;
  function readCsrfFromDom() {
    return (
      (window.CSRF_TOKEN) ||
      (document.querySelector('meta[name="csrf-token"]')?.content) ||
      (document.querySelector('input[name="_csrf"]')?.value) ||
      null
    );
  }
  async function fetchCsrfFromForgot() {
    try {
      const r = await fetch("/forgot", { credentials: "same-origin" });
      const html = await r.text();
      const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
      return m ? m[1] : null;
    } catch { return null; }
  }
  async function getCsrf() {
    if (__csrf) return __csrf;
    __csrf = readCsrfFromDom();
    if (!__csrf) __csrf = await fetchCsrfFromForgot();
    return __csrf || "";
  }

  // -------- Helpers ----------
  const HHMM = /^[0-2]\d:\d{2}$/;

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function getSlotId(el) {
    const c = el?.closest("[data-slot-id]");
    const id = c?.dataset?.slotId || el?.dataset?.slotId;
    return id ? Number(id) : null;
  }
  function getTimeLabel(el) {
    if (el?.dataset?.time) return el.dataset.time;
    const p = el?.closest("[data-time],[data-time-label]");
    if (p) return p.dataset.time || p.dataset.timeLabel;
    const text = (el?.closest("td,th,div")?.textContent || "").trim();
    const m = text.match(/\b([0-2]\d:\d{2})\b/);
    return m ? m[1] : null;
  }
  function promptHHMM(title, initial) {
    const v = prompt(title || "הכנס שעה בפורמט HH:MM", initial || "");
    if (v == null) return null;
    const s = String(v).trim();
    if (!HHMM.test(s)) { alert("שעה לא תקינה. פורמט חובה: HH:MM"); return null; }
    return s;
  }

  async function apiPostForm(url, data) {
    const token = await getCsrf();
    const body = new URLSearchParams();
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) body.append(k, v == null ? "" : String(v));
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-csrf-token": token },
      body
    });
    if (!res.ok) throw new Error(await res.text().catch(()=>"שגיאת שרת"));
    return res;
  }

  function reloadSoon(ms = 50) { setTimeout(() => location.reload(), ms); }

  // -------- Socket.IO (אם קיים בצד לקוח) ----------
  try {
    if (window.io && !window.__slotsIoBound) {
      const socket = io();
      socket.on("slots:update", () => reloadSoon(10));
      window.__slotsIoBound = true;
    }
  } catch {}

  // -------- Handlers: User ----------
  async function onReserve(el) {
    const slotId = getSlotId(el) ?? Number(el.getAttribute("data-id")) || Number(el.value);
    if (!slotId) return alert("לא נמצאה משבצת");
    await apiPostForm(`/reserve/${slotId}`, {});
    reloadSoon();
  }
  async function onUnreserve() {
    await apiPostForm(`/unreserve`, {});
    reloadSoon();
  }

  // -------- Handlers: Admin ----------
  async function onClearSlot(el) {
    const slotId = getSlotId(el);
    if (!slotId) return alert("לא נמצאה משבצת");
    await apiPostForm(`/admin/slots/${slotId}/clear`, {});
    reloadSoon();
  }
  async function onToggleActive(el) {
    const slotId = getSlotId(el);
    if (!slotId) return alert("לא נמצאה משבצת");
    // תומך גם ב-checkbox וגם בכפתור: אם יש property checked – נשתמש בו; אחרת נבדוק data-active
    const active = (typeof el.checked === "boolean") ? el.checked : (el.dataset.active === "true" || el.dataset.active === "1");
    await apiPostForm(`/admin/slots/${slotId}/active`, { active: active ? "1" : "" });
    reloadSoon();
  }
  async function onSetLabel(el) {
    const slotId = getSlotId(el);
    if (!slotId) return alert("לא נמצאה משבצת");
    const current = (el.closest("[data-slot]")?.dataset?.label) || "";
    const label = prompt("שם שיוצג במשבצת:", current);
    if (label === null) return;
    await apiPostForm(`/admin/slots/${slotId}/label`, { label: label.trim() });
    reloadSoon();
  }
  async function onCleanup() {
    if (!confirm("לאפס צבע/טקסט בכל המשבצות שאינן תפוסות?")) return;
    await apiPostForm(`/admin/cleanup`, {});
    reloadSoon();
  }
  async function onCreateHour() {
    const tl = promptHHMM("הוסף שעה (HH:MM):", "12:50");
    if (!tl) return;
    await apiPostForm(`/admin/hours/create`, { time_label: tl });
    reloadSoon();
  }
  async function onDeleteHour(el) {
    const tl = getTimeLabel(el) || promptHHMM("איזו שעה להסיר? (HH:MM)");
    if (!tl) return;
    if (!confirm(`להסיר את השעה ${tl}?`)) return;
    await apiPostForm(`/admin/hours/delete`, { time_label: tl });
    reloadSoon();
  }
  async function onRenameHour(el) {
    let from = getTimeLabel(el);
    if (!from) from = promptHHMM("איזו שעה לערוך? (HH:MM)");
    if (!from) return;
    const to = promptHHMM(`שעה חדשה עבור ${from} (HH:MM):`, from);
    if (!to) return;
    await apiPostForm(`/admin/hours/rename`, { from, to });
    reloadSoon();
  }

  // -------- Delegation ----------
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("button, a, input[type=checkbox], [data-slot-id]");
    if (!el) return;

    // סדר: קודם אדמין כדי לא להתנגש עם קליק בתא
    if (el.matches('[data-action="cleanup"], [data-cleanup-all], .btn-cleanup-all')) {
      ev.preventDefault(); onCleanup(); return;
    }
    if (el.matches('[data-action="create-hour"], [data-create-hour], .btn-create-hour')) {
      ev.preventDefault(); onCreateHour(); return;
    }
    if (el.matches('[data-action="delete-hour"], [data-delete-hour], .btn-delete-hour')) {
      ev.preventDefault(); onDeleteHour(el); return;
    }
    if (el.matches('[data-action="rename-hour"], [data-rename-hour], .btn-rename-hour')) {
      ev.preventDefault(); onRenameHour(el); return;
    }
    if (el.matches('[data-action="clear-slot"], [data-clear-slot], .btn-clear-slot')) {
      ev.preventDefault(); onClearSlot(el); return;
    }
    if (el.matches('[data-action="toggle-active"], [data-toggle-active], .btn-toggle-active, input[type=checkbox][data-slot-id]')) {
      // לא תמיד רוצים למנוע ברירת מחדל של checkbox, אך נעדיף כן כדי שלא יזוז פוקוס.
      ev.preventDefault(); onToggleActive(el); return;
    }
    if (el.matches('[data-action="set-label"], [data-set-label], .btn-set-label')) {
      ev.preventDefault(); onSetLabel(el); return;
    }

    // פעולות יוזר (הרשמה/ביטול)
    if (el.matches('[data-action="unreserve"], [data-unreserve], .btn-unreserve')) {
      ev.preventDefault(); onUnreserve(); return;
    }
    if (
      el.matches('[data-action="reserve"], [data-reserve], .btn-reserve') ||
      // קליק על תא משבצת (אם התא/הורה נושא data-slot-id ואין עליו data-admin)
      (el.hasAttribute('data-slot-id') && !el.closest('[data-admin], .admin-controls'))
    ) {
      ev.preventDefault(); onReserve(el); return;
    }
  });

  // גם שינוי של checkbox שלא נתפס ב-click
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.matches('input[type=checkbox][data-slot-id], [data-action="toggle-active"]')) {
      onToggleActive(el);
    }
  });

})();
