// src/db.js
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false,
});

/* ---------------- Schema init & migrations ---------------- */

async function migrateSlotsSchema() {
  // בסיס טבלת slots
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id SERIAL PRIMARY KEY,
      label TEXT DEFAULT '',
      color TEXT DEFAULT '#e0f2fe',
      time_label TEXT,
      col_index INT,
      row_index INT,
      active BOOLEAN DEFAULT TRUE,
      admin_lock BOOLEAN DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      slot_id INT UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
      user_id INT UNIQUE REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // הוספת admin_lock אם חסר
  await pool.query(`ALTER TABLE slots ADD COLUMN IF NOT EXISTS admin_lock BOOLEAN NOT NULL DEFAULT FALSE;`);

  // אינדקסים
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_slots_time ON slots(time_label)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_slots_row_col ON slots(row_index, col_index)`);
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
      s.admin_lock   AS admin_lock,
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

export async function setSlotActive(slotId, active) {
  await pool.query(`UPDATE slots SET active=$1 WHERE id=$2`, [!!active, slotId]);
}

export async function updateSlot(slotId, { label, color, time_label, col_index, row_index, admin_lock }) {
  const fields = [];
  const values = [];
  let i = 1;

  if (label !== undefined)      { fields.push(`label=$${i++}`); values.push(label); }
  if (color !== undefined)      { fields.push(`color=$${i++}`); values.push(color); }
  if (time_label !== undefined) { fields.push(`time_label=$${i++}`); values.push(time_label); }
  if (col_index !== undefined)  { fields.push(`col_index=$${i++}`); values.push(col_index); }
  if (row_index !== undefined)  { fields.push(`row_index=$${i++}`); values.push(row_index); }
  if (admin_lock !== undefined) { fields.push(`admin_lock=$${i++}`); values.push(!!admin_lock); }

  if (!fields.length) return;

  values.push(slotId);
  await pool.query(`UPDATE slots SET ${fields.join(", ")} WHERE id=$${i}`, values);
}

export async function createSlot({ label, color, time_label, col_index, row_index, active }) {
  await pool.query(
    `INSERT INTO slots (label, color, time_label, col_index, row_index, active, admin_lock)
     VALUES ($1,$2,$3,$4,$5,$6,false)`,
    [label || "", color || "#e0f2fe", time_label, col_index, row_index, !!active]
  );
}

export async function deleteSlot(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
}

export async function clearUserReservation(userId) {
  // מחיקת הרשמה של המשתמש (אם קיימת) ואיפוס התא
  const { rows } = await pool.query(`DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`, [userId]);
  const slotId = rows[0]?.slot_id;
  if (slotId) {
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe', admin_lock=false WHERE id=$1`, [slotId]);
  }
}

export async function clearSlotReservation(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`UPDATE slots SET label='', color='#e0f2fe', admin_lock=false WHERE id=$1`, [slotId]);
}

export async function reserveSlot(userId, slotId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // נעל את המשבצת ובדוק שהיא פעילה ולא נעולה ע"י אדמין
    const { rows: srows } = await client.query(
      `SELECT id, active, admin_lock FROM slots WHERE id=$1 FOR UPDATE`,
      [slotId]
    );
    const slot = srows[0];
    if (!slot || !slot.active) {
      await client.query("ROLLBACK");
      throw new Error("Slot is not active");
    }
    if (slot.admin_lock) {
      await client.query("ROLLBACK");
      throw new Error("המשבצת תפוסה ע\"י אדמין");
    }

    // ודא משבצת אחת למשתמש: נקה הרשמה קודמת
    await client.query(`DELETE FROM reservations WHERE user_id=$1`, [userId]);

    // נסה לתפוס — אם תפוס כבר, נכשל
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

    // עדכן שם/צבע
    const { rows: urows } = await client.query(
      `SELECT first_name, last_name FROM users WHERE id=$1`,
      [userId]
    );
    const fullName = `${urows[0]?.first_name || ""} ${urows[0]?.last_name || ""}`.trim();
    await client.query(
      `UPDATE slots SET label=$1, color='#86efac', admin_lock=false WHERE id=$2`,
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
