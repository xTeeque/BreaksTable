// src/db.js
import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==================== INIT DB ====================
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      phone VARCHAR(20),
      role VARCHAR(20) DEFAULT 'user'
    );

    CREATE TABLE IF NOT EXISTS slots (
      id SERIAL PRIMARY KEY,
      time_label VARCHAR(20) NOT NULL,
      position INT NOT NULL,
      label VARCHAR(255) DEFAULT '',
      color VARCHAR(20) DEFAULT '#e0f2fe',
      active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      slot_id INT REFERENCES slots(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS resets (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ==================== USERS ====================
export async function userByEmail(email) {
  const res = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  return res.rows[0];
}

export async function insertUser({ email, password, first_name, last_name, phone, role = "user" }) {
  const hash = await bcrypt.hash(password, 10);
  const res = await pool.query(
    `INSERT INTO users (email,password,first_name,last_name,phone,role)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [email, hash, first_name, last_name, phone, role]
  );
  return res.rows[0];
}

// ==================== PASSWORD RESET ====================
export async function insertReset(userId, token) {
  await pool.query(
    `INSERT INTO resets (user_id, token, used) VALUES ($1,$2,false)`,
    [userId, token]
  );
}
export async function resetByToken(token) {
  const res = await pool.query(`SELECT * FROM resets WHERE token=$1 AND used=false`, [token]);
  return res.rows[0];
}
export async function updateUserPassword(userId, password) {
  const hash = await bcrypt.hash(password, 10);
  await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hash, userId]);
}
export async function markResetUsed(token) {
  await pool.query(`UPDATE resets SET used=true WHERE token=$1`, [token]);
}

// ==================== SLOTS ====================
export async function getSlotsWithReservations() {
  const res = await pool.query(`
    SELECT s.*, r.user_id, u.first_name, u.last_name
    FROM slots s
    LEFT JOIN reservations r ON s.id=r.slot_id
    LEFT JOIN users u ON r.user_id=u.id
    ORDER BY s.time_label, s.position
  `);
  return res.rows;
}

export async function createSlot({ time_label, position, active = true }) {
  const res = await pool.query(
    `INSERT INTO slots (time_label, position, active)
     VALUES ($1,$2,$3) RETURNING *`,
    [time_label, position, active]
  );
  return res.rows[0];
}

export async function updateSlot(id, { label, color, active }) {
  await pool.query(
    `UPDATE slots SET label=$1, color=$2, active=$3 WHERE id=$4`,
    [label, color, active, id]
  );
}

export async function deleteSlot(id) {
  await pool.query(`DELETE FROM slots WHERE id=$1`, [id]);
}

// ==================== RESERVATIONS ====================
export async function reserveSlot(userId, slotId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const slotRes = await client.query(
      `SELECT id, active FROM slots WHERE id=$1 FOR UPDATE`,
      [slotId]
    );
    if (!slotRes.rowCount) throw new Error("Slot not found");
    if (!slotRes.rows[0].active) throw new Error("Slot is not active");

    const takenRes = await client.query(
      `SELECT id FROM reservations WHERE slot_id=$1 FOR UPDATE`,
      [slotId]
    );
    if (takenRes.rowCount) throw new Error("Slot already reserved");

    await client.query(`DELETE FROM reservations WHERE user_id=$1`, [userId]);

    await client.query(
      `INSERT INTO reservations (slot_id, user_id) VALUES ($1,$2)`,
      [slotId, userId]
    );

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
    if (e.code === "23505") throw new Error("Slot already reserved");
    throw e;
  } finally {
    client.release();
  }
}

export async function clearUserReservation(userId) {
  const res = await pool.query(`DELETE FROM reservations WHERE user_id=$1 RETURNING slot_id`, [userId]);
  if (res.rowCount) {
    const slotId = res.rows[0].slot_id;
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe' WHERE id=$1`, [slotId]);
  }
}

export async function clearSlotReservation(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(`UPDATE slots SET label='', color='#e0f2fe' WHERE id=$1`, [slotId]);
}

// ==================== ADMIN ====================
export async function setSlotActive(slotId, active) {
  await pool.query(`UPDATE slots SET active=$1 WHERE id=$2`, [active, slotId]);
}

export async function adminOverrideLabel(slotId, label) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
  await pool.query(
    `UPDATE slots SET label=$1, color='#f87171' WHERE id=$2`,
    [label, slotId]
  );
}

// הוספת שעה (4 משבצות)
export async function addHour(timeLabel) {
  for (let i = 1; i <= 4; i++) {
    const active = i <= 2; // 2 פתוחות, 2 סגורות כברירת מחדל
    await pool.query(
      `INSERT INTO slots (time_label, position, active) VALUES ($1,$2,$3)`,
      [timeLabel, i, active]
    );
  }
}

export async function renameHour(oldTime, newTime) {
  await pool.query(`UPDATE slots SET time_label=$1 WHERE time_label=$2`, [newTime, oldTime]);
}

export async function deleteHour(timeLabel) {
  await pool.query(`DELETE FROM slots WHERE time_label=$1`, [timeLabel]);
}

// ==================== CONSTRAINTS ====================
export async function ensureReservationConstraints() {
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
