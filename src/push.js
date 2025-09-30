// src/push.js
import webpush from "web-push";
import { pool } from "./db.js";

const BASE_URL = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const PUB  = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;

if (!PUB || !PRIV) {
  console.warn("[PUSH] Missing VAPID keys. Set VAPID_PUBLIC_KEY & VAPID_PRIVATE_KEY");
} else {
  webpush.setVapidDetails(`mailto:${process.env.MAIL_FROM || "no-reply@nowhere.local"}`, PUB, PRIV);
}

export async function savePushSubscription(userId, { endpoint, keys, user_agent }) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
       [userId, endpoint, keys?.p256dh, keys?.auth, user_agent || null]
    );
  } finally { client.release(); }
}

export async function removePushSubscription(userId, endpoint) {
  await pool.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
}

export async function getUserSubscriptions(userId) {
  const { rows } = await pool.query(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]);
  return rows.map(r => ({
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth }
  }));
}

/** מצא תזכורות שיש לשלוח T-3 דקות עכשיו (לפי Asia/Jerusalem) ושלא נשלחו */
export async function findDueReminders() {
  const { rows } = await pool.query(`
    WITH now_il AS (
      SELECT (now() AT TIME ZONE 'Asia/Jerusalem') AS ts
    ),
    target AS (
      SELECT to_char((SELECT ts FROM now_il) + interval '3 minute', 'HH24:MI') AS hhmm,
             date_trunc('minute', (SELECT ts FROM now_il) + interval '3 minute') AS sched_at
    ),
    due AS (
      SELECT r.user_id, s.id AS slot_id, s.time_label,
             (SELECT sched_at FROM target) AS scheduled_for
      FROM reservations r
      JOIN slots s ON s.id = r.slot_id
      WHERE s.active = TRUE
        AND s.time_label = (SELECT hhmm FROM target)
    )
    SELECT d.*
    FROM due d
    LEFT JOIN push_reminders pr
      ON pr.user_id = d.user_id
     AND pr.slot_id = d.slot_id
     AND pr.scheduled_for = d.scheduled_for
    WHERE pr.id IS NULL;
  `);
  return rows;
}

export async function markReminderSent(userId, slotId, scheduledFor) {
  await pool.query(`
    INSERT INTO push_reminders (user_id, slot_id, scheduled_for)
    VALUES ($1,$2,$3)
    ON CONFLICT (user_id, slot_id, scheduled_for) DO NOTHING
  `, [userId, slotId, scheduledFor]);
}

/** שלח נוטיפיקציות לכל המנויים של המשתמש */
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
