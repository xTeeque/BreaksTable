// src/db.js
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false,
});

// ---- Schema init ----
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // טבלת המשבצות: is_time = תא של שעת תצוגה (לא ניתן לרישום)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#e5e7eb',
      time_label TEXT NOT NULL,
      col_index INT NOT NULL,
      row_index INT NOT NULL,
      is_time BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      slot_id INTEGER NOT NULL UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
await init();

/* ================= Users & Password Reset ================= */
export async function userByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, first_name, last_name
     FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

export async function insertUser(email, password_hash, role, created_at, first_name = "", last_name = "") {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, created_at, first_name, last_name)
     VALUES (LOWER($1), $2, $3, $4, $5, $6) RETURNING id`,
    [email, password_hash, role, created_at, first_name, last_name]
  );
  return rows[0].id;
}

export async function insertReset(user_id, token, expires_at) {
  await pool.query(
    `INSERT INTO password_resets (user_id, token, expires_at, used)
     VALUES ($1, $2, $3, FALSE)`,
    [user_id, token, expires_at]
  );
}

export async function resetByToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM password_resets WHERE token=$1 LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

export async function updateUserPassword(user_id, password_hash) {
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [password_hash, user_id]);
}

export async function markResetUsed(id) {
  await pool.query(`UPDATE password_resets SET used=TRUE WHERE id=$1`, [id]);
}

/* ================= Slots & Reservations ================= */
export async function getSlotsWithReservations() {
  const { rows } = await pool.query(`
    SELECT
      s.id AS slot_id, s.label, s.color, s.time_label, s.col_index, s.row_index, s.is_time, s.active,
      r.user_id,
      u.first_name, u.last_name
    FROM slots s
    LEFT JOIN reservations r ON r.slot_id = s.id
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY s.row_index ASC, s.col_index ASC;
  `);
  return rows;
}

export async function seedSlotsIfEmpty() {
  const countRes = await pool.query(`SELECT COUNT(*)::int AS c FROM slots`);
  if (countRes.rows[0].c > 0) return;

  // שעות לדוגמה
  const hours = ["12:50", "13:25", "14:00", "14:35"];
  for (let r = 0; r < hours.length; r++) {
    const time = hours[r];

    // 4 אופציות: 1..4 (העמודה הימנית תהיה 5 = תא הזמן)
    for (let c = 1; c <= 4; c++) {
      const isActive = c <= 2; // שתי אופציות פתוחות כברירת מחדל
      await pool.query(
        `INSERT INTO slots (label, color, time_label, col_index, row_index, is_time, active)
         VALUES ('', '#e5e7eb', $1, $2, $3, FALSE, $4)`,
        [time, c, r + 1, isActive]
      );
    }
    // תא הזמן (ימין)
    await pool.query(
      `INSERT INTO slots (label, color, time_label, col_index, row_index, is_time, active)
       VALUES ($1, '#e5e7eb', $1, 5, $2, TRUE, TRUE)`,
      [time, r + 1]
    );
  }
}

export async function setSlotActive(slotId, active) {
  await pool.query(`UPDATE slots SET active=$1 WHERE id=$2 AND is_time=FALSE`, [!!active, slotId]);
}

export async function updateSlot(slotId, { label = "", color = "#e5e7eb", time_label }) {
  await pool.query(
    `UPDATE slots SET label=$1, color=$2, time_label=COALESCE($3,time_label) WHERE id=$4`,
    [label, color, time_label || null, slotId]
  );
}

export async function createSlot({ label = "", color = "#e5e7eb", time_label, col_index, row_index, is_time = false, active = true }) {
  await pool.query(
    `INSERT INTO slots (label,color,time_label,col_index,row_index,is_time,active)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [label, color, time_label, col_index, row_index, is_time, active]
  );
}

export async function deleteSlot(slotId) {
  await pool.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
}

// מסיר רישום של המשתמש (ומנקה את הלייבל בתא הישן אם היה)
export async function clearUserReservation(userId) {
  const { rows } = await pool.query(`DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`, [userId]);
  if (rows.length) {
    const prevSlotId = rows[0].slot_id;
    await pool.query(`UPDATE slots SET label='' WHERE id=$1`, [prevSlotId]);
  }
}

// מנקה משבצת ספציפית (ומנקה את הלייבל)
export async function clearSlotReservation(slotId) {
  const { rows } = await pool.query(`DELETE FROM reservations WHERE slot_id=$1 RETURNING user_id`, [slotId]);
  await pool.query(`UPDATE slots SET label='' WHERE id=$1`, [slotId]);
  return rows.length > 0;
}

// רישום למשבצת: רק אם פעילה, לא תא שעה, ונקייה
export async function reserveSlot(userId, slotId) {
  // ודא שהמשבצת פעילה ואינה תא זמן
  const { rows: srows } = await pool.query(
    `SELECT id, is_time, active FROM slots WHERE id=$1`,
    [slotId]
  );
  const slot = srows[0];
  if (!slot || slot.is_time || !slot.active) throw new Error("Slot is not active");

  // נקה רישום קודם (אם קיים)
  await clearUserReservation(userId);

  // נסה לרשום; UNIQUE ימנע תפיסה כפולה
  await pool.query(`INSERT INTO reservations (slot_id, user_id) VALUES ($1,$2)`, [slotId, userId]);

  // עדכן תצוגת התא לשם הנרשם + צבע ירוק
  const { rows: urows } = await pool.query(`SELECT first_name, last_name FROM users WHERE id=$1`, [userId]);
  const fullName = `${urows[0]?.first_name || ""} ${urows[0]?.last_name || ""}`.trim();
  await pool.query(`UPDATE slots SET label=$1, color='#86efac' WHERE id=$2`, [fullName, slotId]);
}

export default {
  userByEmail,
  insertUser,
  insertReset,
  resetByToken,
  updateUserPassword,
  markResetUsed,

  getSlotsWithReservations,
  seedSlotsIfEmpty,
  setSlotActive,
  updateSlot,
  createSlot,
  deleteSlot,
  clearUserReservation,
  clearSlotReservation,
  reserveSlot,

  pool,
};
