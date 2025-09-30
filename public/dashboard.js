// public/dashboard.js
(() => {
  const ROLE = (document.body.getAttribute('data-role') || 'user').toLowerCase();
  const CSRF = (typeof window !== 'undefined' && window.CSRF_TOKEN) ? window.CSRF_TOKEN : '';

  const log = (...a) => console.log('[dashboard]', ...a);
  const err = (...a) => console.error('[dashboard]', ...a);

  async function api(path, { method = 'POST', json, headers = {} } = {}) {
    const opts = {
      method,
      headers: { 'x-csrf-token': CSRF, ...headers },
      credentials: 'same-origin'
    };
    if (json !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(json);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.error || data?.message || text || 'Request failed');
    return data ?? text;
  }

  const isHHMM = s => typeof s === 'string' && /^[0-2]\d:\d{2}$/.test(s.trim());
  const refresh = () => window.location.reload();

  // Socket לרענון
  try {
    if (window.io) {
      const socket = io();
      socket.on('connect', () => log('socket connected'));
      socket.on('slots:update', () => { log('slots:update'); refresh(); });
    }
  } catch (e) { err('socket init failed', e); }

  // ❗ אם אדמין — להסיר class שחוסם קליקים (ייתכן ש-CSS שם pointer-events:none)
  function unblockAdminClicks() {
    if (ROLE === 'admin') {
      document.querySelectorAll('.cell.disabled').forEach(el => el.classList.remove('disabled'));
    }
  }

  // פעולות משתמש (קליק על תא)
  async function onUserCellClick(cell, ev) {
    // אם לוחצים על כפתורי אדמין/כותרת שעה — להתעלם
    if (ev.target.closest('.admin-actions') || ev.target.closest('.time-actions')) return;

    const taken  = cell.getAttribute('data-taken') === '1';
    const mine   = cell.getAttribute('data-mine') === '1';
    const active = cell.getAttribute('data-active') === '1';
    const slotId = Number(cell.getAttribute('data-slot-id') || -1);
    if (slotId <= 0) return;

    try {
      if (mine) {
        await api('/unreserve', { method: 'POST' });
      } else {
        if (!active) throw new Error('המשבצת סגורה');
        if (taken)  throw new Error('המשבצת תפוסה');
        await api(`/reserve/${slotId}`, { method: 'POST' });
      }
      refresh();
    } catch (e) {
      alert(e.message || 'שגיאה בביצוע הפעולה');
      err(e);
    }
  }

  // פעולות אדמין על תא (נקה/סגור/פתח/ערוך שם)
  async function onAdminActionClick(btn) {
    const action = btn.getAttribute('data-action');
    const cell = btn.closest('.cell');
    if (!cell) return;
    const slotId = Number(cell.getAttribute('data-slot-id') || -1);
    if (slotId <= 0 && !['rename-hour','delete-hour'].includes(action)) return;

    try {
      if (action === 'clear') {
        await api(`/admin/slots/${slotId}/clear`, { method: 'POST' });
      } else if (action === 'close') {
        await api(`/admin/slots/${slotId}/active`, { method: 'POST', json: { active: false } });
      } else if (action === 'open') {
        await api(`/admin/slots/${slotId}/active`, { method: 'POST', json: { active: true } });
      } else if (action === 'label') {
        const current = (cell.querySelector('.slot-text')?.textContent || '').trim();
        const label = prompt('שם שיוצג למשבצת (ריק כדי להסיר):', current);
        if (label === null) return;
        await api(`/admin/slots/${slotId}/label`, { method: 'POST', json: { label: String(label).trim() } });
      } else {
        log('unknown admin slot action', action);
        return;
      }
      refresh();
    } catch (e) {
      alert(e.message || 'שגיאה בביצוע הפעולה');
      err(e);
    }
  }

  // פעולות על שעות (עריכת שעה/הסרה מכותרת השעה)
  async function onHourAction(btn) {
    const action = btn.getAttribute('data-action'); // rename-hour / delete-hour
    const time = (btn.getAttribute('data-time') || '').trim();
    if (!isHHMM(time)) { alert('שעת מקור לא חוקית'); return; }
    try {
      if (action === 'rename-hour') {
        const to = prompt('שעה חדשה (HH:MM):', time);
        if (to === null) return;
        if (!isHHMM(to)) throw new Error('HH:MM required');
        await api('/admin/hours/rename', { method: 'POST', json: { from: time, to } });
      } else if (action === 'delete-hour') {
        if (!confirm(`למחוק את השעה ${time}?`)) return;
        await api('/admin/hours/delete', { method: 'POST', json: { time_label: time } });
      }
      refresh();
    } catch (e) {
      alert(e.message || 'שגיאה בביצוע הפעולה');
      err(e);
    }
  }

  // כפתורי טופ-בר (הוספת שעה / ניקוי כללי)
  function wireTopbarAdmin() {
    if (ROLE !== 'admin') return;

    const btnAdd = document.getElementById('btn-add-hour');
    if (btnAdd) {
      btnAdd.addEventListener('click', async () => {
        const def = new Date(Date.now() + 3 * 60000).toLocaleTimeString('he-IL', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const hhmm = prompt('הכנס שעה בפורמט HH:MM', def);
        if (hhmm === null) return;
        if (!isHHMM(hhmm)) { alert('HH:MM required'); return; }
        try {
          await api('/admin/hours/create', { method: 'POST', json: { time_label: hhmm } });
          refresh();
        } catch (e) { alert(e.message || 'שגיאה ביצירת שעה'); err(e); }
      });
    }

    const btnClean = document.getElementById('btn-clear-all');
    if (btnClean) {
      btnClean.addEventListener('click', async () => {
        if (!confirm('לנקות את כל המשבצות הפנויות?')) return;
        try {
          await api('/admin/cleanup', { method: 'POST' });
          refresh();
        } catch (e) {
          alert(`נכשל ניקוי כללי: ${e.message || e}`);
          err(e);
        }
      });
    }
  }

  // האזנה לכל הגריד
  function wireGrid() {
    const grid = document.getElementById('grid');
    if (!grid) return;

    grid.addEventListener('click', (ev) => {
      const target = ev.target;

      // כפתורי שעה (header)
      const hourBtn = target.closest('.time-actions button');
      if (hourBtn && ROLE === 'admin') {
        ev.preventDefault();
        onHourAction(hourBtn);
        return;
      }

      // כפתורי אדמין בתוך תא
      const adminBtn = target.closest('.admin-actions button');
      if (adminBtn && ROLE === 'admin') {
        ev.preventDefault();
        onAdminActionClick(adminBtn);
        return;
      }

      // ❗ קליק על תא: לא רק למשתמש — גם לאדמין מותר לתפוס/לשחרר
      const cell = target.closest('.cell');
      if (cell) {
        ev.preventDefault();
        onUserCellClick(cell, ev);
        return;
      }
    });
  }

  function init() {
    unblockAdminClicks();
    wireTopbarAdmin();
    wireGrid();
    log('ready; role=', ROLE);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
