// src/db.js
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false,
});

/* ---------------- Schema init & migrations ---------------- */

async function migrateSlotsSchema() {
  // בסיס טבלת slots אם מגיעים ממבנה ישן
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id SERIAL PRIMARY KEY,
      label TEXT,
      color TEXT,
      time_label TEXT,
      col_index INT,
      row_index INT
    );
  `);

  // עמודות ותיקוני ברירת מחדל
  await pool.query(`ALTER TABLE slots ADD COLUMN IF NOT EXISTS active  BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE slots ALTER COLUMN label SET DEFAULT '';`);
  await pool.query(`ALTER TABLE slots ALTER COLUMN color SET DEFAULT '#e5e7eb';`);
  await pool.query(`UPDATE slots SET label = COALESCE(label,'');`);
  await pool.query(`UPDATE slots SET color = COALESCE(color,'#e5e7eb');`);
  await pool.query(`UPDATE slots SET active = COALESCE(active, TRUE);`);
}

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

  await migrateSlotsSchema();

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

/* ---------------- Users & Password Reset ---------------- */

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

/* ---------------- Slots & Reservations ---------------- */

export async function getSlotsWithReservations() {
  const { rows } = await pool.query(`
    SELECT
      s.id AS slot_id, s.label, s.color, s.time_label, s.col_index, s.row_index, s.active,
      r.user_id,
      u.first_name, u.last_name
    FROM slots s
    LEFT JOIN reservations r ON r.slot_id = s.id
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY s.time_label ASC, s.row_index ASC, s.col_index ASC;
  ``);
  return rows;
}

/** זורע נתוני דיפולט אם הטבלה ריקה: 4 שעות * 4 משבצות (2 פתוחות, 2 סגורות) */
export async function seedSlotsIfEmpty() {
  const countRes = await pool.query(`SELECT COUNT(*)::int AS c FROM slots`);
  if (countRes.rows[0].c > 0) return;

  const hours = ["12:50", "13:25", "14:00", "14:35"];
  for (let r = 0; r < hours.length; r++) {
    const time = hours[r];
    for (let c = 1; c <= 4; c++) {
      const isActive = c <= 2; // שתי משבצות פתוחות כברירת מחדל
      await pool.query(
        `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
         VALUES ('', '#e5e7eb', $1, $2, $3, $4)`,
        [time, c, r + 1, isActive]
      );
    }
  }
}

/** נרמול: מבטיח שבכל שעה יש בדיוק col_index 1..4 (2 פתוחות, 2 סגורות) */
export async function normalizeSlotsToFour() {
  const timesRes = await pool.query(`SELECT DISTINCT time_label FROM slots ORDER BY time_label ASC`);
  const times = timesRes.rows.map(r => r.time_label);

  if (times.length === 0) {
    await seedSlotsIfEmpty();
    return;
  }

  const maxRowRes = await pool.query(`SELECT COALESCE(MAX(row_index),0)::int AS max_row FROM slots`);
  let nextRow = maxRowRes.rows[0].max_row + 1;

  for (const time of times) {
    const rowRes = await pool.query(
      `SELECT row_index FROM slots WHERE time_label=$1 ORDER BY row_index ASC LIMIT 1`,
      [time]
    );
    const rowIndex = rowRes.rows[0]?.row_index ?? nextRow++;

    // צור חסרות
    for (let ci = 1; ci <= 4; ci++) {
      const { rows } = await pool.query(
        `SELECT id FROM slots WHERE time_label=$1 AND col_index=$2 LIMIT 1`,
        [time, ci]
      );
      if (rows.length === 0) {
        const isActive = ci <= 2;
        await pool.query(
          `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
           VALUES ('', '#e5e7eb', $1, $2, $3, $4)`,
          [time, ci, rowIndex, isActive]
        );
      }
    }

    // מחק עודפים
    await pool.query(
      `DELETE FROM slots WHERE time_label=$1 AND (col_index < 1 OR col_index > 4)`,
      [time]
    );
  }
}

export async function setSlotActive(slotId, active) {
  await pool.query(`UPDATE slots SET active=$1 WHERE id=$2`, [!!active, slotId]);
}

export async function updateSlot(slotId, { label = "", color = "#e5e7eb", time_label }) {
  await pool.query(
    `UPDATE slots SET label=$1, color=$2, time_label=COALESCE($3, time_label) WHERE id=$4`,
    [label, color, time_label || null, slotId]
  );
}

export async function createSlot({ label = "", color = "#e5e7eb", time_label, col_index, row_index, active = true }) {
  await pool.query(
    `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [label, color, time_label, col_index, row_index, active]
  );
}

export async function deleteSlot(slotId) {
  await pool.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
}

export async function clearUserReservation(userId) {
  const { rows } = await pool.query(
    `DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`,
    [userId]
  );
  if (rows.length) {
    await pool.query(`UPDATE slots SET label='' WHERE id=$1`, [rows[0].slot_id]);
  }
}

export async function clearSlotReservation(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`UPDATE slots SET label='' WHERE id=$1`, [slotId]);
}

export async function reserveSlot(userId, slotId) {
  // מנקה רישום קודם (משבצת אחת למשתמש)
  await clearUserReservation(userId);

  // מוודא שהמשבצת קיימת ופעילה
  const { rows: srows } = await pool.query(
    `SELECT id, active FROM slots WHERE id=$1`,
    [slotId]
  );
  const slot = srows[0];
  if (!slot || !slot.active) throw new Error("Slot is not active");

  // רושם
  await pool.query(`INSERT INTO reservations (slot_id, user_id) VALUES ($1, $2)`, [slotId, userId]);

  // מעדכן label לצורך תצוגה + צובע ירוק
  const { rows: urows } = await pool.query(
    `SELECT first_name, last_name FROM users WHERE id=$1`,
    [userId]
  );
  const fullName = `${urows[0]?.first_name || ""} ${urows[0]?.last_name || ""}`.trim();
  await pool.query(`UPDATE slots SET label=$1, color='#86efac' WHERE id=$2`, [fullName, slotId]);
}
