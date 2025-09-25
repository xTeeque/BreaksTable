// scripts/init-db.js
import db from "../src/db.js";
import bcrypt from "bcryptjs";

const email = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
const password = process.env.ADMIN_PASSWORD || "admin123";
const firstName = process.env.ADMIN_FIRST_NAME || "Admin";
const lastName  = process.env.ADMIN_LAST_NAME || "User";

async function ensureAdmin() {
  const existing = await db.userByEmail(email);
  if (!existing) {
    const hash = await bcrypt.hash(password, 12);
    const id = await db.insertUser(email, hash, "admin", new Date().toISOString(), firstName, lastName);
    console.log("Created admin user:", email, "id:", id);
    return;
  }

  // קיים? ודא שהתפקיד הוא admin
  if (existing.role !== "admin") {
    await db.pool.query(`UPDATE users SET role='admin' WHERE id=$1`, [existing.id]);
    console.log("Upgraded existing user to admin:", email);
  } else {
    console.log("Admin already exists:", email);
  }
}

await ensureAdmin();

// שמירת/מיגרציית טבלאות + סידינג משבצות (אם ריק) — נשאר כמו אצלך
await db.seedSlotsIfEmpty();
console.log("Slots seeded (if empty).");

process.exit(0);
