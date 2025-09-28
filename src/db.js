// src/db.js
import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// אתחול בסיס הנתונים
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
  `);
}

// יצירת משתמש
export async function insertUser({ email, password, first_name, last_name, phone, role = "user" }) {
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO users (email, password, first_name, last_name, phone, role)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [email, hash, first_name, last_name, phone, role]
  );
  return result.rows[0];
}

// פונקציה שמנקה כפילויות ומוסיפה אינדקסים ייחודיים
export async function ensureReservationConstraints() {
  // מחיקת כפילויות לפי משתמש
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

  // מחיקת כפילויות לפי משבצת
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

  // הוספת שעה חדשה
export async function addHour(timeLabel) {
  // מוצאים את המיקום הבא לשעה החדשה
  const res = await pool.query(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM slots`);
  const nextPos = res.rows[0].pos;

  // יוצרים 4 משבצות לשעה הזו
  for (let i = 1; i <= 4; i++) {
    const active = i <= 2; // 2 פתוחות, 2 סגורות
    await pool.query(
      `INSERT INTO slots (time_label, position, active) VALUES ($1,$2,$3)`,
      [timeLabel, i, active]
    );
  }
}

// שינוי שעה
export async function renameHour(oldTime, newTime) {
  await pool.query(`UPDATE slots SET time_label=$1 WHERE time_label=$2`, [newTime, oldTime]);
}

// מחיקת שעה
export async function deleteHour(timeLabel) {
  await pool.query(`DELETE FROM slots WHERE time_label=$1`, [timeLabel]);
}


  // יצירת אינדקסים ייחודיים אם לא קיימים
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

export default pool;
