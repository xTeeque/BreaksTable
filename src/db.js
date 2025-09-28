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
