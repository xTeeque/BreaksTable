// scripts/init-db.js
import {
  pool,
  userByEmail,
  insertUser,
  seedSlotsIfEmpty,
  normalizeSlotsToFour, // חשוב: אם הוספנו פונקציה זו ב-db.js
} from "../src/db.js";
import bcrypt from "bcryptjs";

const email = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
const password = process.env.ADMIN_PASSWORD || "admin123";
const firstName = process.env.ADMIN_FIRST_NAME || "Admin";
const lastName  = process.env.ADMIN_LAST_NAME || "User";

async function ensureAdmin() {
  const existing = await userByEmail(email);
  if (!existing) {
    const hash = await bcrypt.hash(password, 12);
    const id = await insertUser(email, hash, "admin", new Date().toISOString(), firstName, lastName);
    console.log("Created admin user:", email, "id:", id);
    return;
  }
  if (existing.role !== "admin") {
    await pool.query(`UPDATE users SET role='admin' WHERE id=$1`, [existing.id]);
    console.log("Upgraded existing user to admin:", email);
  } else {
    console.log("Admin already exists:", email);
  }
}

await ensureAdmin();

// זרע ברירות מחדל אם הטבלה ריקה
await seedSlotsIfEmpty();

// יישור נתונים: ודא שתמיד יש 4 משבצות לכל שעה (2 פתוחות, 2 סגורות)
if (typeof normalizeSlotsToFour === "function") {
  await normalizeSlotsToFour();
}

console.log("Init DB done.");
process.exit(0);
