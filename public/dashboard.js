// public/dashboard.js

(function () {
  // --- עזרי CSRF ---
  function getCsrf() {
    return (
      (window.CSRF_TOKEN) ||
      (document.querySelector('meta[name="csrf-token"]')?.content) ||
      (document.querySelector('input[name="_csrf"]')?.value) ||
      ""
    );
  }
  function postForm(url, dataObj) {
    const body = new URLSearchParams();
    Object.entries(dataObj || {}).forEach(([k, v]) => body.append(k, v ?? ""));
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-csrf-token": getCsrf() },
      body
    });
  }

  // --- עזרי זמן ---
  const HHMM = /^[0-2]\d:\d{2}$/;
  function askHHMM(title, initial = "") {
    const val = prompt(title || "הכנס שעה בפורמט HH:MM", initial || "");
    if (val == null) return null;
    const s = String(val).trim();
    if (!HHMM.test(s)) { alert("שעה לא תקינה. פורמט חובה: HH:MM"); return null; }
    return s;
  }

  // --- איתור time_label מהדום ---
  function findTimeFromDom(btn) {
    // 1) data-time על הכפתור
    if (btn?.dataset?.time) return btn.dataset.time;
    // 2) אב קרוב עם data-time או data-time-label
    const parentWithData = btn?.closest("[data-time]") || btn?.closest("[data-time-label]");
    if (parentWithData) return parentWithData.dataset.time || parentWithData.dataset.timeLabel;
    // 3) טקסט בתא (ננסה לחלץ HH:MM)
    const txt = (btn?.closest("td,th,div")?.textContent || "").trim();
    const m = txt.match(/\b([0-2]\d:\d{2})\b/);
    return m ? m[1] : null;
  }

  // --- עריכת שעה ---
  async function handleRenameHour(target) {
    // ננסה לנחש את ה-from מהדום; אם לא נמצא – נשאל
    let from = findTimeFromDom(target);
    if (!from) {
      from = askHHMM("איזו שעה לערוך? (HH:MM)");
      if (!from) return;
    }
    const to = askHHMM(`שעה חדשה עבור ${from} (HH:MM):`, from);
    if (!to) return;

    try {
      const res = await postForm("/admin/hours/rename", { from, to });
      if (!res.ok) {
        const t = await res.text().catch(()=> "שגיאה");
        throw new Error(t || "שגיאה");
      }
      // רענון למסך כדי לראות עדכון
      location.reload();
    } catch (e) {
      alert("נכשל עריכת שעה: " + (e.message || e));
    }
  }

  // --- ניקוי כללי ---
  async function handleCleanup() {
    if (!confirm("האם לאפס צבע/טקסט בכל המשבצות שאינן תפוסות?")) return;
    try {
      const res = await postForm("/admin/cleanup", {});
      if (!res.ok) {
        const t = await res.text().catch(()=> "שגיאה");
        throw new Error(t || "שגיאה");
      }
      location.reload();
    } catch (e) {
      alert("נכשל ניקוי כללי: " + (e.message || e));
    }
  }

  // --- האזנה לכל מיני וריאציות של כפתורים ---
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("button, a");
    if (!el) return;

    // כפתור "ערוך שעה" – תומך בכמה סלקטורים
    if (
      el.matches('[data-action="rename-hour"]') ||
      el.matches('[data-rename-hour]') ||
      el.matches('.btn-rename-hour')
    ) {
      ev.preventDefault();
      handleRenameHour(el);
      return;
    }

    // כפתור "ניקוי כללי"
    if (
      el.matches('[data-action="cleanup"]') ||
      el.matches('[data-cleanup-all]') ||
      el.matches('.btn-cleanup-all')
    ) {
      ev.preventDefault();
      handleCleanup();
      return;
    }
  });

})();
