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
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
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
      s.id AS slot_id,
      s.label,
      s.color,
      s.time_label,
      s.col_index,
      s.row_index,
      s.active,
      r.user_id,
      u.first_name,
      u.last_name
    FROM slots s
    LEFT JOIN reservations r ON r.slot_id = s.id
    LEFT JOIN users u ON u.id = r.user_id
    WHERE s.time_label IS NOT NULL AND TRIM(s.time_label) <> ''
    ORDER BY
      (split_part(s.time_label, ':', 1)::int * 60 + split_part(s.time_label, ':', 2)::int) ASC,
      s.row_index ASC,
      s.col_index ASC
  `);
  return rows;
}

/** זורע דיפולט: 4 שעות * 4 משבצות (2 פתוחות, 2 סגורות), רקע תכלת */
export async function seedSlotsIfEmpty() {
  const countRes = await pool.query(`SELECT COUNT(*)::int AS c FROM slots`);
  if (countRes.rows[0].c > 0) return;

  const HOURS = ["12:50", "13:25", "14:00", "14:35"];
  for (let r = 0; r < HOURS.length; r++) {
    const time = HOURS[r];
    for (let c = 1; c <= 4; c++) {
      const isActive = c <= 2;
      await pool.query(
        `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
         VALUES ('', '#e0f2fe', $1, $2, $3, $4)`,
        [time, c, r + 1, isActive]
      );
    }
  }

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_slots_time_col'
      ) THEN
        CREATE UNIQUE INDEX uniq_slots_time_col ON slots (time_label, col_index);
      END IF;
    END$$;
  `);
}

/** ניקוי רישום למשתמש: צובע תכלת */
export async function clearUserReservation(userId) {
  const { rows } = await pool.query(
    `DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`,
    [userId]
  );
  if (rows.length) {
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe' WHERE id=$1`, [rows[0].slot_id]);
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

    // נעל את המשבצת לעדכון
    const slotRes = await client.query(
      `SELECT id, active FROM slots WHERE id=$1 FOR UPDATE`,
      [slotId]
    );
    if (!slotRes.rowCount) throw new Error("Slot not found");
    if (!slotRes.rows[0].active) throw new Error("Slot is not active");

    // אם כבר תפוס — עצור
    const takenRes = await client.query(
      `SELECT id FROM reservations WHERE slot_id=$1 FOR UPDATE`,
      [slotId]
    );
    if (takenRes.rowCount) throw new Error("Slot already reserved");

    // מחק הרשמה קודמת של המשתמש (משבצת אחת למשתמש)
    await client.query(`DELETE FROM reservations WHERE user_id=$1`, [userId]);

    // צור הרשמה חדשה
    await client.query(
      `INSERT INTO reservations (slot_id, user_id) VALUES ($1, $2)`,
      [slotId, userId]
    );

    // עדכן LABEL + צבע
    const u = await client.query(
      `SELECT first_name, last_name FROM users WHERE id=$1`,
      [userId]
    );
    const fullName = `${u.rows[0]?.first_name || ""} ${u.rows[0]?.last_name || ""}`.trim();
    await client.query(
      `UPDATE slots SET label=$1, color='#86efac' WHERE id=$2`,
      [fullName, slotId]
    );

    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    // אם נפל על ייחודיות (23505) נחזיר הודעה ברורה
    if (e && e.code === "23505") {
      throw new Error("Slot already reserved");
    }
    throw e;
  } finally {
    client.release();
  }
}


export async function setSlotActive(slotId, active) {
  await pool.query(`UPDATE slots SET active=$1 WHERE id=$2`, [!!active, slotId]);
}

export async function updateSlot(slotId, { label = "", color = "#e0f2fe", time_label }) {
  await pool.query(
    `UPDATE slots SET label=$1, color=$2, time_label=COALESCE($3, time_label) WHERE id=$4`,
    [label, color, time_label || null, slotId]
  );
}

export async function createSlot({ label = "", color = "#e0f2fe", time_label, col_index, row_index, active = true }) {
  await pool.query(
    `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [label, color, time_label, col_index, row_index, active]
  );
}

export async function deleteSlot(slotId) {
  await pool.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
}

// ---- Admin hour management ----
export async function addHour(time_label) {
  const maxRowRes = await pool.query(`SELECT COALESCE(MAX(row_index),0)::int AS max_row FROM slots`);
  const rowIndex = maxRowRes.rows[0].max_row + 1;

  const exists = await pool.query(`SELECT 1 FROM slots WHERE time_label=$1 LIMIT 1`, [time_label]);
  if (exists.rowCount) throw new Error("Hour already exists");

  for (let c = 1; c <= 4; c++) {
    const isActive = c <= 2;
    await pool.query(
      `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
       VALUES ('', '#e0f2fe', $1, $2, $3, $4)`,
      [time_label, c, rowIndex, isActive]
    );
  }

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_slots_time_col'
      ) THEN
        CREATE UNIQUE INDEX uniq_slots_time_col ON slots (time_label, col_index);
      END IF;
    END$$;
  `);
}

export async function renameHour(old_time_label, new_time_label) {
  const clash = await pool.query(`SELECT 1 FROM slots WHERE time_label=$1 LIMIT 1`, [new_time_label]);
  if (clash.rowCount) throw new Error("Target hour already exists");
  await pool.query(`UPDATE slots SET time_label=$1 WHERE time_label=$2`, [new_time_label, old_time_label]);
}

export async function deleteHour(time_label) {
  await pool.query(`DELETE FROM reservations WHERE slot_id IN (SELECT id FROM slots WHERE time_label=$1)`, [time_label]);
  await pool.query(`DELETE FROM slots WHERE time_label=$1`, [time_label]);
}

// src/db.js — הוסף איפשהו בקובץ
export async function ensureReservationConstraints() {
  // מחיקת כפילויות לפי משתמש: השאר את ההרשמה החדשה ביותר
  await pool.query(`
    WITH ranked AS (
      SELECT id, user_id,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
      FROM reservations
    )
    DELETE FROM reservations r
    USING ranked x
    WHERE r.id = x.id AND x.rn > 1;
  `);

  // מחיקת כפילויות לפי משבצת: השאר את ההרשמה החדשה ביותר
  await pool.query(`
    WITH ranked AS (
      SELECT id, slot_id,
             ROW_NUMBER() OVER (PARTITION BY slot_id ORDER BY created_at DESC) AS rn
      FROM reservations
    )
    DELETE FROM reservations r
    USING ranked x
    WHERE r.id = x.id AND x.rn > 1;
  `);

  // אינדקסים ייחודיים שימנעו כפילויות להבא (נוצרים רק אם לא קיימים)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_reservations_user'
      ) THEN
        CREATE UNIQUE INDEX uniq_reservations_user ON reservations(user_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_reservations_slot'
      ) THEN
        CREATE UNIQUE INDEX uniq_reservations_slot ON reservations(slot_id);
      END IF;
    END$$;
  `);
}


// --- Admin override label: clears reservation; sets label; optional lock ---
export async function adminOverrideLabel(slotId, label, lock = true) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  if (lock) {
    await pool.query(
      `UPDATE slots SET label=$1, color='#86efac', active=FALSE WHERE id=$2`,
      [label, slotId]
    );
  } else {
    await pool.query(
      `UPDATE slots SET label=$1, color='#86efac' WHERE id=$2`,
      [label, slotId]
    );
  }
}
