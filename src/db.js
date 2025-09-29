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
      row_index INT,
      active BOOLEAN DEFAULT TRUE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      slot_id INT UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
      user_id INT UNIQUE REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // אינדקסים
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_slots_time ON slots(time_label)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_slots_row_col ON slots(row_index, col_index)`);

  // עמודות ותיקוני ברירת מחדל
  await pool.query(`ALTER TABLE slots ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE slots ALTER COLUMN label SET DEFAULT '';`);
  await pool.query(`ALTER TABLE slots ALTER COLUMN color SET DEFAULT '#e0f2fe';`);
  await pool.query(`UPDATE slots SET label = COALESCE(label,'');`);
  await pool.query(`UPDATE slots SET color = COALESCE(color,'#e0f2fe');`);
  await pool.query(`UPDATE slots SET active = COALESCE(active, TRUE);`);
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      role TEXT DEFAULT 'user'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT FALSE
    );
  `);

  await migrateSlotsSchema();
}
init();

/* ---------------- Users & Reset ---------------- */

export async function userByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  return rows[0] || null;
}

export async function insertUser(user) {
  await pool.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES ($1,$2,$3,$4,$5)`,
    [user.email, user.password_hash, user.first_name || "", user.last_name || "", user.role || "user"]
  );
}

export async function insertReset({ user_id, token, expires_at }) {
  await pool.query(
    `INSERT INTO reset_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)`,
    [user_id, token, expires_at]
  );
}

export async function resetByToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM reset_tokens WHERE token=$1 AND used=FALSE AND expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

export async function updateUserPassword(user_id, password_hash) {
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [password_hash, user_id]);
}

export async function markResetUsed(token) {
  await pool.query(`UPDATE reset_tokens SET used=TRUE WHERE token=$1`, [token]);
}

/* ---------------- Slots & Reservations ---------------- */

export async function getSlotsWithReservations() {
  const { rows } = await pool.query(`
    SELECT
      s.id           AS slot_id,
      s.label        AS label,
      s.color        AS color,
      s.time_label   AS time_label,
      s.col_index    AS col_index,
      s.row_index    AS row_index,
      s.active       AS active,
      r.user_id      AS user_id
    FROM slots s
    LEFT JOIN reservations r ON r.slot_id = s.id
    ORDER BY
      time_label ASC,
      row_index ASC,
      col_index ASC
  `);
  return rows;
}

export async function seedSlotsIfEmpty() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM slots`);
  if (rows[0].c > 0) return;

  const hours = ["12:50","13:25","14:00","14:35"];
  let rowIndex = 0;
  for (const t of hours) {
    for (let col = 1; col <= 4; col++) {
      await pool.query(
        `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
         VALUES ('', '#e0f2fe', $1, $2, $3, $4)`,
        [t, col, rowIndex, col <= 2] // שתי עמודות ראשונות פתוחות כברירת מחדל
      );
    }
    rowIndex++;
  }
}

export async function normalizeSlotsToFour(timeLabel) {
  // שמירה על 4 משבצות לשעה (אם מוסיפים/מוחקים ידנית)
  const { rows } = await pool.query(
    `SELECT id FROM slots WHERE time_label=$1 ORDER BY col_index ASC`,
    [timeLabel]
  );
  // ניתן להשלים/לעדכן לפי צורך; להשאיר פשוט כאן
  return rows.map(r => r.id);
}

export async function setSlotActive(slotId, active) {
  await pool.query(`UPDATE slots SET active=$1 WHERE id=$2`, [!!active, slotId]);
}

export async function updateSlot(slotId, { label, color, time_label, col_index, row_index }) {
  const fields = [];
  const values = [];
  let i = 1;

  if (label !== undefined)     { fields.push(`label=$${i++}`); values.push(label); }
  if (color !== undefined)     { fields.push(`color=$${i++}`); values.push(color); }
  if (time_label !== undefined){ fields.push(`time_label=$${i++}`); values.push(time_label); }
  if (col_index !== undefined) { fields.push(`col_index=$${i++}`); values.push(col_index); }
  if (row_index !== undefined) { fields.push(`row_index=$${i++}`); values.push(row_index); }

  if (!fields.length) return;

  values.push(slotId);
  await pool.query(`UPDATE slots SET ${fields.join(", ")} WHERE id=$${i}`, values);
}

export async function createSlot({ label, color, time_label, col_index, row_index, active }) {
  await pool.query(
    `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [label || "", color || "#e0f2fe", time_label, col_index, row_index, !!active]
  );
}

export async function deleteSlot(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
}

export async function clearUserReservation(userId) {
  // ניקוי המשבצת שאוחז בה המשתמש (אם קיימת) והחזרת התא לברירת מחדל
  const { rows } = await pool.query(`DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`, [userId]);
  const slotId = rows[0]?.slot_id;
  if (slotId) {
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe' WHERE id=$1`, [slotId]);
  }
}

export async function clearSlotReservation(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`UPDATE slots SET label='', color='#e0f2fe' WHERE id=$1`, [slotId]);
}

export async function reserveSlot(userId, slotId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the slot row to avoid race conditions
    const { rows: srows } = await client.query(
      `SELECT id, active FROM slots WHERE id=$1 FOR UPDATE`,
      [slotId]
    );
    const slot = srows[0];
    if (!slot || !slot.active) {
      await client.query("ROLLBACK");
      throw new Error("Slot is not active");
    }

    // Ensure one slot per user: clear previous reservation
    await client.query(`DELETE FROM reservations WHERE user_id=$1`, [userId]);

    // Try to reserve this slot; if already taken, do nothing
    const ins = await client.query(
      `INSERT INTO reservations (slot_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (slot_id) DO NOTHING`,
      [slotId, userId]
    );
    if (ins.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error('המשבצת כבר נתפסה על ידי משתמש אחר');
    }

    // Update slot label/color with user's full name
    const { rows: urows } = await client.query(
      `SELECT first_name, last_name FROM users WHERE id=$1`,
      [userId]
    );
    const fullName = `${urows[0]?.first_name || ""} ${urows[0]?.last_name || ""}`.trim();
    await client.query(
      `UPDATE slots SET label=$1, color='#86efac' WHERE id=$2`,
      [fullName, slotId]
    );

    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
