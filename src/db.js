// src/db.js
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false,
});

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

  -- Slots grid
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,        -- טקסט שמופיע בתא (למשל שם)
      color TEXT NOT NULL,        -- צבע הרקע (css)
      time_label TEXT NOT NULL,   -- לדוג' "12:50", "13:25" וכו'
      col_index INT NOT NULL,     -- עמודה (ליישור כמו בתמונה)
      row_index INT NOT NULL      -- שורה
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
  await pool.query(
    `UPDATE users SET password_hash=$1 WHERE id=$2`,
    [password_hash, user_id]
  );
}

export async function markResetUsed(id) {
  await pool.query(`UPDATE password_resets SET used=TRUE WHERE id=$1`, [id]);
}

/* ================= Slots & Reservations ================= */
export async function getSlotsWithReservations() {
  const { rows } = await pool.query(`
    SELECT
      s.id AS slot_id, s.label, s.color, s.time_label, s.col_index, s.row_index,
      r.user_id,
      u.first_name, u.last_name, u.email
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

  // גריד בסיסי בסגנון התמונה: 3 עמודות (שמאל = שעה), 2 עמודות צבע, מס' שורות
  const slots = [
    // row, col, label, color, time
    { r: 1, c: 1, label: "",     color: "#ef4444", time: "12:50" }, // אדום
    { r: 1, c: 2, label: "ייטב", color: "#f59e0b", time: "12:50" }, // כתום
    { r: 1, c: 3, label: "12:50",color: "#fbbf24", time: "12:50" }, // תא שעה

    { r: 2, c: 1, label: "",     color: "#ef4444", time: "13:25" },
    { r: 2, c: 2, label: "עידן", color: "#f59e0b", time: "13:25" },
    { r: 2, c: 3, label: "13:25",color: "#fb923c", time: "13:25" },

    { r: 3, c: 1, label: "",     color: "#ef4444", time: "14:00" },
    { r: 3, c: 2, label: "מעיין",color: "#f59e0b", time: "14:00" },
    { r: 3, c: 3, label: "14:00",color: "#86efac", time: "14:00" },

    { r: 4, c: 1, label: "שוום", color: "#22c55e", time: "14:35" },
    { r: 4, c: 2, label: "נועה", color: "#84cc16", time: "14:35" },
    { r: 4, c: 3, label: "14:35",color: "#60a5fa", time: "14:35" },

    { r: 5, c: 1, label: "אביב", color: "#22c55e", time: "14:35" },
    { r: 5, c: 2, label: "שון",  color: "#ef4444", time: "14:35" },
    { r: 5, c: 3, label: "14:35",color: "#60a5fa", time: "14:35" },

    { r: 6, c: 1, label: "",     color: "#ef4444", time: "14:35" },
    { r: 6, c: 2, label: "אסף",  color: "#ef4444", time: "14:35" },
    { r: 6, c: 3, label: "14:35",color: "#60a5fa", time: "14:35" },
  ];

  for (const s of slots) {
    await pool.query(
      `INSERT INTO slots (label, color, time_label, col_index, row_index)
       VALUES ($1,$2,$3,$4,$5)`,
      [s.label, s.color, s.time, s.c, s.r]
    );
  }
}

export async function clearUserReservation(userId) {
  await pool.query(`DELETE FROM reservations WHERE user_id=$1`, [userId]);
}

export async function clearSlotReservation(slotId) {
  await pool.query(`DELETE FROM reservations WHERE slot_id=$1`, [slotId]);
}

export async function reserveSlot(userId, slotId) {
  // משתמש יכול להחזיק רק משבצת אחת
  await clearUserReservation(userId);
  // ונרשמים למשבצת אם פנויה (UNIQUE על slot_id ימנע כפילות)
  await pool.query(
    `INSERT INTO reservations (slot_id, user_id) VALUES ($1,$2)`,
    [slotId, userId]
  );
}

export async function updateSlot(slotId, { label, color, time_label }) {
  await pool.query(
    `UPDATE slots SET label=$1, color=$2, time_label=$3 WHERE id=$4`,
    [label, color, time_label, slotId]
  );
}

export async function createSlot({ label, color, time_label, col_index, row_index }) {
  await pool.query(
    `INSERT INTO slots (label,color,time_label,col_index,row_index) VALUES ($1,$2,$3,$4,$5)`,
    [label, color, time_label, col_index, row_index]
  );
}

export async function deleteSlot(slotId) {
  await pool.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
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
  clearUserReservation,
  clearSlotReservation,
  reserveSlot,
  updateSlot,
  createSlot,
  deleteSlot,

  pool,
};
