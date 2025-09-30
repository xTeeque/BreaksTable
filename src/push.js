// src/push.js
import webpush from "web-push";
import { pool } from "./db.js";

const PUB  = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;

if (!PUB || !PRIV) {
  console.warn("[PUSH] Missing VAPID keys. Set VAPID_PUBLIC_KEY & VAPID_PRIVATE_KEY");
} else {
  webpush.setVapidDetails(
    `mailto:${process.env.MAIL_FROM || "no-reply@nowhere.local"}`,
    PUB,
    PRIV
  );
}

export async function savePushSubscription(userId, { endpoint, keys, user_agent }) {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, endpoint) DO UPDATE
     SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
    [userId, endpoint, keys?.p256dh, keys?.auth, user_agent || null]
  );
}

export async function removePushSubscription(userId, endpoint) {
  await pool.query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
    [userId, endpoint]
  );
}

export async function getUserSubscriptions(userId) {
  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId]
  );
  return rows.map(r => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

export async function sendPushToUser(userId, payload) {
  const subs = await getUserSubscriptions(userId);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600 });
    } catch (e) {
      const code = e?.statusCode || e?.code;
      if (code === 404 || code === 410) {
        // subscription expired → מחיקה
        await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
      } else {
        console.warn("[PUSH] send error:", code, e?.message || e);
      }
    }
  }
}

/** למציאת רשומות due אם תרצה קרון T-3 דקות (אפשר להשאיר אם כבר יש): */
export async function findDueReminders() { return { rows: [] }; }
export async function markReminderSent() { /* no-op כאן */ }
