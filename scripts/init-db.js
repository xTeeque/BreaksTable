// scripts/init-db.js
import bcrypt from "bcryptjs";
import {
  pool,
  userByEmail,
  insertUser,
  seedSlotsIfEmpty,
  normalizeSlotsToFour,
} from "../src/db.js";

async function ensureAdmin() {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
  const ADMIN_PASS  = process.env.ADMIN_PASSWORD || "admin1234";
  const exists = await userByEmail(ADMIN_EMAIL);
  if (exists) {
    console.log("Admin already exists:", ADMIN_EMAIL);
    return;
  }
  const passHash = await bcrypt.hash(ADMIN_PASS, 10);
  await insertUser({
    email: ADMIN_EMAIL,
    password_hash: passHash,
    first_name: "Admin",
    last_name: "",
    role: "admin",
  });
  console.log("Admin created:", ADMIN_EMAIL);
}

async function cleanupNullTimeLabels() {
  // מחיקה בטוחה של כל שורות slots עם time_label NULL/ריק כדי לעמוד ב-DB עם NOT NULL
  await pool.query(`DELETE FROM slots WHERE time_label IS NULL OR TRIM(time_label) = ''`);
}

async function main() {
  try {
    await ensureAdmin();

    // ודא שאין רשומות פגומות לפני יצירה/נרמול
    await cleanupNullTimeLabels();

    // צור משבצות אם אין בכלל
    await seedSlotsIfEmpty();

    // נרמל את 4 השעות שלנו (התאם אם תרצה)
    const HOURS = ["12:50","13:25","14:00","14:35"];
    for (const t of HOURS) {
      await normalizeSlotsToFour(t);
    }

    console.log("DB init finished successfully");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
