/* public/push.js */
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
    const rawData = atob(base64); const out = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i); return out;
  }

  async function subscribe() {
    try {
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
        keys: sub.toJSON().keys,
        user_agent: navigator.userAgent
      };

      const res = await fetch('/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': CSRF || '' },
        body: JSON.stringify(payload),
        credentials: 'same-origin'
      });

      if (!res.ok) {
        const text = await res.text().catch(()=> '');
        console.error('[push] subscribe failed', res.status, text);
        if (res.status === 401 || res.status === 302) {
          setStatus('דרושה התחברות מחדש');
        } else if (res.status === 403) {
          setStatus('CSRF לא תקין — טען את העמוד מחדש');
        } else if (res.status === 404) {
          setStatus('שרת ללא מסלול /push/subscribe — העלה את server.js המעודכן');
        } else {
          setStatus('שגיאת שרת (' + res.status + ')');
        }
        return;
      }

      setStatus('התראות הופעלו בהצלחה ✔️');
    } catch (e) {
      console.error('[push] subscribe error', e);
      setStatus(e.message || 'שגיאה בהפעלת התראות');
    }
  }

  async function unsubscribe() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': CSRF || '' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
          credentials: 'same-origin'
        }).catch(()=>{});
        await sub.unsubscribe().catch(()=>{});
      }
      setStatus('התראות בוטלו');
    } catch (e) {
      console.error('[push] unsubscribe error', e);
      setStatus('שגיאה בביטול התראות');
    }
  }

  $enable  && $enable.addEventListener('click', subscribe);
  $disable && $disable.addEventListener('click', unsubscribe);

  // סטטוס התחלתי
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) setStatus('דפדפן לא תומך בהתראות');
    else if (!vapidPublicKey) setStatus('חסר VAPID_PUBLIC_KEY בצד שרת');
    else {
      const reg = await navigator.serviceWorker.getRegistration();
      const s   = reg ? await reg.pushManager.getSubscription() : null;
      setStatus(s ? 'התראות פעילות' : 'התראות כבויות');
    }
  } catch {}
})();
