
import db from "../src/db.js";
import bcrypt from "bcryptjs";

const email = process.env.ADMIN_EMAIL || "admin@example.com";
const password = process.env.ADMIN_PASSWORD || "admin123";
const firstName = process.env.ADMIN_FIRST_NAME || "Admin";
const lastName = process.env.ADMIN_LAST_NAME || "User";

const existing = db.userByEmail(email.toLowerCase());
if (existing) {
  console.log("Admin already exists:", email);
  process.exit(0);
}

const hash = await bcrypt.hash(password, 12);
const id = db.insertUser(email.toLowerCase(), hash, "admin", new Date().toISOString(), firstName, lastName);
console.log("Created admin user:", email, "id:", id);
process.exit(0);
