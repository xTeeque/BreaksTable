// src/db.js
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false,
});

/* ---------------- Schema init & migrations ---------------- */

async function migrateSlotsSchema() {
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

  await pool.query(`ALTER TABLE slots ADD COLUMN IF NOT EXISTS admin_lock BOOLEAN NOT NULL DEFAULT FALSE;`);
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
      role TEXT DEFAULT 'user',
      phone TEXT
    );
  `);

  /* מיגרציות "אם לא קיים" — מאפשר להריץ שוב ושוב בבטחה */
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);

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
    `INSERT INTO users (email, password_hash, first_name, last_name, role, phone)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [user.email, user.password_hash, user.first_name || "", user.last_name || "", user.role || "user", user.phone || null]
  );
}

export async function updateUserPhone(user_id, phone) {
  await pool.query(`UPDATE users SET phone=$1 WHERE id=$2`, [phone || null, user_id]);
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

/* ---------------- Slots & Reservations (ללא שינויי SMS) ---------------- */

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

export async function seedSlotsIfEmpty() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM slots`);
  if (rows[0].c > 0) return;

  const hours = ["12:50","13:25","14:00","14:35"];
  let rowIndex = 1;
  for (const t of hours) {
    for (let col = 1; col <= 4; col++) {
      await pool.query(
        `INSERT INTO slots (label, color, time_label, col_index, row_index, active, admin_lock)
         VALUES ('', '#e0f2fe', $1, $2, $3, $4, false)`,
        [t, col, rowIndex, col <= 2]
      );
    }
    rowIndex++;
  }
}

export async function normalizeSlotsToFour(timeLabel) {
  const tl = (timeLabel ?? "").toString().trim();
  if (!tl) throw new Error("normalizeSlotsToFour: timeLabel is required (non-empty)");

  await pool.query(`
    WITH keep AS (
      SELECT MIN(id) AS keep_id, time_label, col_index
      FROM slots
      WHERE time_label = $1
      GROUP BY time_label, col_index
    )
    DELETE FROM slots s
    USING keep k
    WHERE s.time_label = k.time_label
      AND s.col_index  = k.col_index
      AND s.id <> k.keep_id
  `, [tl]);

  const { rows: rIdx } = await pool.query(
    `SELECT COALESCE(MIN(row_index), 1)::int AS row_index FROM slots WHERE time_label=$1`,
    [tl]
  );
  const rowIndex = rIdx[0]?.row_index ?? 1;

  for (let col = 1; col <= 4; col++) {
    const { rows: exists } = await pool.query(
      `SELECT id FROM slots WHERE time_label=$1 AND col_index=$2 LIMIT 1`,
      [tl, col]
    );
    if (!exists.length) {
      await pool.query(
        `INSERT INTO slots (label, color, time_label, col_index, row_index, active, admin_lock)
         VALUES ('', '#e0f2fe', $1, $2, $3, $4, false)`,
        [tl, col, rowIndex, col <= 2]
      );
    }
  }

  await pool.query(
    `DELETE FROM slots WHERE time_label=$1 AND (col_index < 1 OR col_index > 4)`,
    [tl]
  );

  await pool.query(`UPDATE slots SET row_index=$2 WHERE time_label=$1`, [tl, rowIndex]);

  await pool.query(
    `UPDATE slots SET active = CASE WHEN col_index IN (1,2) THEN TRUE ELSE FALSE END WHERE time_label=$1`,
    [tl]
  );

  await pool.query(`
    UPDATE slots s
    SET color = '#e0f2fe',
        label = '',
        admin_lock = false
    WHERE s.time_label = $1
      AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = s.id)
  `, [tl]);
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
  const tl = (time_label ?? "").toString().trim();
  if (!tl) throw new Error("createSlot: time_label is required");

  await pool.query(
    `INSERT INTO slots (label, color, time_label, col_index, row_index, active, admin_lock)
     VALUES ($1,$2,$3,$4,$5,$6,false)`,
    [label || "", color || "#e0f2fe", tl, col_index, row_index, !!active]
  );
}

export async function deleteSlot(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
}

export async function clearUserReservation(userId) {
  const { rows } = await pool.query(`DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`, [userId]);
  const prevSlot = rows[0]?.slot_id;
  if (prevSlot) {
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe', admin_lock=false WHERE id=$1`, [prevSlot]);
  }
}

export async function clearSlotReservation(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`UPDATE slots SET label='', color='#e0f2fe', admin_lock=false WHERE id=$1`, [slotId]);
}

export async function createHour(time_label) {
  const tl = (time_label ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(tl)) throw new Error("createHour: time_label format HH:MM required");

  const { rows: exists } = await pool.query(`SELECT 1 FROM slots WHERE time_label=$1 LIMIT 1`, [tl]);
  if (exists.length) throw new Error("שעה זו כבר קיימת");

  const { rows: r } = await pool.query(`SELECT COALESCE(MAX(row_index),0)::int + 1 AS next_row FROM slots`);
  const rowIndex = r[0]?.next_row ?? 1;

  for (let col = 1; col <= 4; col++) {
    await pool.query(
      `INSERT INTO slots (label, color, time_label, col_index, row_index, active, admin_lock)
       VALUES ('', '#e0f2fe', $1, $2, $3, $4, false)`,
      [tl, col, rowIndex, col <= 2]
    );
  }
}

export async function renameHour(from, to) {
  const src = (from ?? "").toString().trim();
  const dst = (to ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(src) || !/^[0-2]\d:\d{2}$/.test(dst)) {
    throw new Error("renameHour: HH:MM required");
  }
  const { rows: exists } = await pool.query(`SELECT 1 FROM slots WHERE time_label=$1 LIMIT 1`, [dst]);
  if (exists.length) throw new Error("כבר קיימת שעה עם הערך החדש");
  await pool.query(`UPDATE slots SET time_label=$2 WHERE time_label=$1`, [src, dst]);
}

export async function deleteHour(time_label) {
  const tl = (time_label ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(tl)) throw new Error("deleteHour: HH:MM required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM reservations WHERE slot_id IN (SELECT id FROM slots WHERE time_label=$1)`,
      [tl]
    );
    await client.query(`DELETE FROM slots WHERE time_label=$1`, [tl]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function reserveSlot(userId, slotId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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

    const { rows: prev } = await client.query(
      `DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`,
      [userId]
    );
    const prevSlotId = prev[0]?.slot_id;
    if (prevSlotId) {
      await client.query(
        `UPDATE slots SET label='', color='#e0f2fe', admin_lock=false WHERE id=$1`,
        [prevSlotId]
      );
    }

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
