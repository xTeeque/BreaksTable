<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>דשבורד</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body data-role="<%= (typeof user !== 'undefined' && user && user.role) ? user.role : 'user' %>">
  <%
    // בטיחות נגד undefined
    const U = (typeof user !== 'undefined' && user) ? user : {};
    const SLOTS = Array.isArray(slots) ? slots : [];
    const CSRF = (typeof csrfToken !== 'undefined' && csrfToken) ? csrfToken : '';

    // מפיקים רשימת שעות דינמית מהנתונים (מסודרת "HH:MM")
    const HOURS = [...new Set(SLOTS.map(s => s.time_label))].sort((a,b) => String(a).localeCompare(String(b)));

    // קיבוץ לפי שעה
    const byHour = {};
    SLOTS.forEach(s => {
      if (!byHour[s.time_label]) byHour[s.time_label] = [];
      byHour[s.time_label].push(s);
    });

    function fourFor(t) {
      const arr = (byHour[t] || []).slice().sort((a,b) => {
        if ((a.row_index ?? 0) !== (b.row_index ?? 0)) return (a.row_index ?? 0) - (b.row_index ?? 0);
        return (a.col_index ?? 0) - (b.col_index ?? 0);
      });
      // אם פחות מ-4, משלימים ויזואלית (לא נוגעים בבסיס הנתונים כאן)
      while (arr.length < 4) arr.push({
        slot_id: -1,
        label: '',
        color: '#e0f2fe',
        time_label: t,
        col_index: arr.length+1,
        row_index: 0,
        active: false,
        user_id: null,
        admin_lock: false,
      });
      return arr.slice(0,4);
    }
  %>

  <div class="page">
    <div class="card topbar">
      <div class="left">
        <% if (U.role === 'admin') { %>
          <button id="btn-add-hour" class="badge">הוסף שעה</button>
          <button id="btn-clear-all" class="badge danger">ניקוי כללי</button>
        <% } %>
      </div>

      <div class="right">
        <span>שלום <strong><%= [U.first_name || "", U.last_name || ""].join(" ").trim() %></strong></span>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="_csrf" value="<%= CSRF %>">
          <button type="submit" class="badge">התנתקות</button>
        </form>
      </div>
    </div>

    <div class="card">
      <p class="muted">
        משבצת נחשבת <strong>“תפוס”</strong> אם יש הרשמה או אם אדמין נעל אותה עם שם מותאם.
      </p>

      <div id="grid" class="grid">
        <% HOURS.forEach(time => { const cells = fourFor(time); %>
          <!-- תא שעה (לחיץ לאדמין לעריכת השעה) -->
          <div class="cell time" data-time="<%= time %>">
            <span class="time-text"><%= time %></span>
            <% if (U.role === 'admin') { %>
              <span class="edit-hint">ערוך</span>
            <% } %>
          </div>

          <!-- ארבע משבצות -->
          <% cells.forEach(s => {
               const sid = Number(s.slot_id || -1);
               const hasUser = !!s.user_id;
               const adminLocked = !!s.admin_lock;
               const taken = hasUser || adminLocked;
               const mine  = hasUser && U.id && (s.user_id === U.id);
               const active = !!s.active;
               const showName = taken ? (s.label || '') : '';
               const bg = taken ? '#86efac' : (s.color || '#e0f2fe'); // צבע מגיע מהשרת/DB
               const disabledForUser = (!active || (taken && !mine));
          %>
            <div class="cell <%= mine ? 'mine' : '' %> <%= disabledForUser ? 'disabled' : '' %>"
                 style="background:<%= bg %>"
                 data-slot-id="<%= sid %>"
                 data-taken="<%= taken ? '1' : '0' %>"
                 data-mine="<%= mine ? '1' : '0' %>"
                 data-active="<%= active ? '1' : '0' %>">

              <div class="slot-text"><%= showName %></div>
              <div class="badge state">
                <% if (mine) { %>שלך (הסר)
                <% } else if (!active) { %>סגור
                <% } else if (taken) { %>תפוס
                <% } else { %>פנוי<% } %>
              </div>

              <% if (U.role === 'admin' && sid > 0) { %>
                <div class="admin-actions">
                  <button class="badge" type="button" data-action="clear">נקה</button>
                  <% if (active) { %>
                    <button class="badge danger" type="button" data-action="close">סגור</button>
                  <% } else { %>
                    <button class="badge success" type="button" data-action="open">פתח</button>
                  <% } %>
                  <button class="badge info" type="button" data-action="label">ערוך שם</button>
                  <form class="inline" data-action="delete">
                    <input type="hidden" name="slot_id" value="<%= sid %>">
                    <button class="badge danger" type="submit">מחק</button>
                  </form>
                </div>
              <% } %>
            </div>
          <% }) %>
        <% }) %>
      </div>
    </div>
  </div>

  <script>window.CSRF_TOKEN = "<%= CSRF %>"</script>
  <script src="/socket.io/socket.io.js"></script>
  <script src="/dashboard.js" defer></script>
</body>
</html>
