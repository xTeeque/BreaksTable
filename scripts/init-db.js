// scripts/init-db.js
import {
  initDb,
  insertUser,
  ensureReservationConstraints
} from "../src/db.js";

const run = async () => {
  await initDb();

  // יצירת משתמש אדמין ראשוני
  try {
    await insertUser({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      first_name: process.env.ADMIN_FIRST_NAME,
      last_name: process.env.ADMIN_LAST_NAME,
      phone: null,
      role: "admin"
    });
    console.log("Admin created:", process.env.ADMIN_EMAIL);
  } catch (e) {
    console.log("Admin already exists:", process.env.ADMIN_EMAIL);
  }

  // תיקון ואכיפת חוקים
  await ensureReservationConstraints();

  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
