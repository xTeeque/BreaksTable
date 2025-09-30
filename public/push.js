/* public/push.js */
/* עוזר בצד לקוח לרישום/ביטול מנוי Push בדפדפן */

(async function () {
  const $enable  = document.querySelector('[data-push-enable]');
  const $disable = document.querySelector('[data-push-disable]');
  const $status  = document.querySelector('[data-push-status]');
  const CSRF     = window.CSRF_TOKEN || window.csrfToken || null;

  const vapidPublicKey = document.querySelector('meta[name="vapid-public-key"]')?.content || null;

  function setStatus(msg) { if ($status) $status.textContent = msg; }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) throw new Error('דפדפן לא תומך Service Worker');
    const reg = await navigator.serviceWorker.register('/sw.js');
    return reg;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const output  = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
    return output;
  }

  async function subscribe() {
    if (!vapidPublicKey) throw new Error('חסר VAPID_PUBLIC_KEY בצד שרת');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('ההרשאות נחסמו');

    const reg = await registerSW();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
    });

    const payload = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.toJSON().keys.p256dh,
        auth: sub.toJSON().keys.auth
      },
      user_agent: navigator.userAgent
    };

    const res = await fetch('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': CSRF || '' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await res.text().catch(()=>'Subscribe failed'));
    setStatus('התראות הופעלו בהצלחה ✔️');
  }

  async function unsubscribe() {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;

    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': CSRF || '' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(()=>{});
      await sub.unsubscribe().catch(()=>{});
    }
    setStatus('התראות בוטלו');
  }

  $enable  && $enable.addEventListener('click', async () => { try { await subscribe(); } catch(e){ setStatus(e.message); } });
  $disable && $disable.addEventListener('click', async () => { try { await unsubscribe(); } catch(e){ setStatus(e.message); } });

  // סטטוס התחלתי
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) setStatus('דפדפן לא תומך בהתראות');
    else {
      const reg = await navigator.serviceWorker.getRegistration();
      const s   = reg ? await reg.pushManager.getSubscription() : null;
      setStatus(s ? 'התראות פעילות' : 'התראות כבויות');
    }
  } catch { /* no-op */ }
})();
