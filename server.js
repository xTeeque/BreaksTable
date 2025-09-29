// server.js
import express from "express";
import session from "express-session";
import pgSimpleFactory from "connect-pg-simple";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import csrf from "csurf";
import { body, validationResult } from "express-validator";
import bcrypt from "bcryptjs";
import dayjs from "dayjs";
import { nanoid } from "nanoid";
import rateLimit from "express-rate-limit";
import httpPkg from "http";
import { Server as SocketIOServer } from "socket.io";
import crypto from "crypto";
import "dayjs/locale/he.js";
import cron from "node-cron";

import {
  pool,
  userByEmail,
  insertUser,
  insertReset,
  resetByToken,
  updateUserPassword,
  markResetUsed,
  getSlotsWithReservations,
  reserveSlot,
  clearUserReservation,
  clearSlotReservation,
  setSlotActive,
  updateSlot,
  createSlot,
  deleteSlot,
} from "./src/db.js";

import {
  requireAuth,
  requireRole,
  csrfErrorHandler,
  nullableTrim,
  safeLower,
  safeString,
} from "./src/middleware/auth.js";

import { sendResetMail } from "./src/mailer.js";

dayjs.locale("he");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = httpPkg.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// לצורך הפעלת Socket.IO כאשר יש שינוי ב־slots
async function broadcastSlots() {
  try {
    io.emit("slots:update", { at: Date.now() });
  } catch (e) {
    console.error("broadcast error:", e);
  }
}

// בסיס מדיניות אבטחה
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

const PgStore = pgSimpleFactory(session);
app.use(session({
  store: new PgStore({
    pool,
    tableName: "session",
    createTableIfMissing: true,
  }),
  name: "sid",
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: !!process.env.COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14 יום
  },
}));
const csrfProtection = csrf();

// שיעורי בקשה
const limiter = rateLimit({
  windowMs: 60_000,
  max: 300,
});
app.use(limiter);

// תצוגות
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* ------------------ עמודים ------------------ */

app.get("/", requireAuth, async (req, res) => {
  const slots = await getSlotsWithReservations();
  res.render("dashboard", {
    slots,
    user: req.session.user,
    csrfToken: req.csrfToken(),
  });
});

app.get("/login", (req, res) => {
  res.render("login", { csrfToken: req.csrfToken() });
});

app.post("/login",
  body("email").isEmail().withMessage("Email not valid"),
  body("password").isString().isLength({ min: 1 }),
  csrfProtection,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).send("Invalid payload");

    const email = safeLower(req.body.email);
    const user = await userByEmail(email);
    if (!user) return res.status(401).send("User not found");

    const ok = await bcrypt.compare(String(req.body.password), user.password_hash);
    if (!ok) return res.status(401).send("Wrong password");

    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
    };
    res.redirect("/");
  }
);

app.post("/logout", csrfProtection, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/register", (req, res) => {
  res.render("register", { csrfToken: req.csrfToken() });
});

app.post("/register",
  csrfProtection,
  body("email").isEmail(),
  body("password").isString().isLength({ min: 6 }),
  body("first_name").optional().isString(),
  body("last_name").optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).send("Invalid payload");

    const email = safeLower(req.body.email);
    const passHash = await bcrypt.hash(String(req.body.password), 10);
    const first = safeString(req.body.first_name);
    const last = safeString(req.body.last_name);

    try {
      await insertUser({ email, password_hash: passHash, first_name: first, last_name: last });
      res.redirect("/login");
    } catch (e) {
      console.error(e);
      res.status(400).send("Cannot create user");
    }
  }
);

/* ------------------ Reset password ------------------ */
app.get("/forgot", (req, res) => {
  res.render("forgot", { csrfToken: req.csrfToken() });
});

app.post("/forgot",
  csrfProtection,
  body("email").isEmail(),
  async (req, res) => {
    const email = safeLower(req.body.email);
    const user = await userByEmail(email);
    if (!user) return res.status(200).send("If user exists, email sent");

    const token = nanoid(32);
    await insertReset({ user_id: user.id, token, expires_at: dayjs().add(1, "hour").toISOString() });
    await sendResetMail(email, token);
    res.send("If user exists, email sent");
  }
);

app.get("/reset/:token", async (req, res) => {
  const record = await resetByToken(req.params.token);
  if (!record) return res.status(400).send("Invalid or expired");
  res.render("reset", { token: req.params.token, csrfToken: req.csrfToken() });
});

app.post("/reset/:token",
  csrfProtection,
  body("password").isString().isLength({ min: 6 }),
  async (req, res) => {
    const rec = await resetByToken(req.params.token);
    if (!rec) return res.status(400).send("Invalid or expired");
    await updateUserPassword(rec.user_id, await bcrypt.hash(String(req.body.password), 10));
    await markResetUsed(req.params.token);
    res.redirect("/login");
  }
);

/* ------------------ פעולות משתמש ------------------ */

app.post("/reserve/:slotId", requireAuth, async (req, res) => {
  try {
    await reserveSlot(req.session.user.id, Number(req.params.slotId));
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    const msg = e?.message || "Reservation failed";
    res.status(409).send(msg);
  }
});

app.post("/unreserve", requireAuth, async (req, res) => {
  await clearUserReservation(req.session.user.id);
  await broadcastSlots();
  res.json({ ok: true });
});

/* ------------------ פעולות אדמין ------------------ */
app.post("/admin/slots/:slotId/clear", requireAuth, requireRole("admin"), async (req, res) => {
  await clearSlotReservation(Number(req.params.slotId));
  await broadcastSlots();
  res.json({ ok: true });
});

app.post("/admin/slots/:slotId/active", requireAuth, requireRole("admin"), async (req, res) => {
  const slotId = Number(req.params.slotId);
  const active = !!req.body.active;
  await setSlotActive(slotId, active);
  await broadcastSlots();
  res.json({ ok: true });
});

// *** עודכן: כשאדמין משנה שם – קודם מנקים רשומה קיימת ואז קובעים label ***
app.post("/admin/slots/:slotId/label", requireAuth, requireRole("admin"), async (req, res) => {
  const slotId = Number(req.params.slotId);
  const label = (req.body.label ?? "").toString().trim();

  // Clear any existing reservation on this slot, then set label/color
  await clearSlotReservation(slotId);
  await updateSlot(slotId, { label, color: label ? "#86efac" : "#e5e7eb" });

  await broadcastSlots();
  return res.json({ ok: true });
});

// שינוי מאפייני משבצת (כולל time_label)
app.post("/admin/slots/update", requireAuth, requireRole("admin"), async (req, res) => {
  const payload = {
    slot_id: Number(req.body.slot_id),
    label: nullableTrim(req.body.label),
    color: nullableTrim(req.body.color),
    time_label: nullableTrim(req.body.time_label),
    col_index: req.body.col_index != null ? Number(req.body.col_index) : undefined,
    row_index: req.body.row_index != null ? Number(req.body.row_index) : undefined,
  };
  await updateSlot(payload.slot_id, payload);
  await broadcastSlots();
  res.json({ ok: true });
});

// יצירה/מחיקה של משבצת
app.post("/admin/slots/create", requireAuth, requireRole("admin"), async (req, res) => {
  const payload = {
    label: nullableTrim(req.body.label) || "",
    color: nullableTrim(req.body.color) || "#e5e7eb",
    time_label: String(req.body.time_label),
    col_index: Number(req.body.col_index),
    row_index: Number(req.body.row_index),
    active: req.body.active !== "false",
  };
  await createSlot(payload);
  await broadcastSlots();
  res.redirect("/");
});

app.post("/admin/slots/delete", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.body.slot_id);
  await deleteSlot(id);
  await broadcastSlots();
  res.json({ ok: true });
});

// ניקוי כללי ע"י אדמין
app.post("/admin/clear-all", requireAuth, requireRole("admin"), async (req, res) => {
  // ניקוי כל הרשמות + איפוס תאים לצבע/טקסט ברירת מחדל
  await pool.query(`DELETE FROM reservations;`);
  await pool.query(`UPDATE slots SET label='', color='#e0f2fe';`);
  await broadcastSlots();
  res.json({ ok: true });
});

/* ------------------ תזמון יומי (אופציונלי) ------------------ */
// דוגמה: ניקוי כללי כל יום בשעה 15:00 לפי Asia/Jerusalem
cron.schedule("0 15 * * *", async () => {
  try {
    await pool.query(`DELETE FROM reservations;`);
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe';`);
    await broadcastSlots();
    console.log("Daily clear-all executed (15:00 Asia/Jerusalem)");
  } catch (e) {
    console.error("Daily clear-all failed:", e);
  }
}, { timezone: "Asia/Jerusalem" });


// 404
app.use((req, res) => res.status(404).send("Not Found"));

// Start
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
