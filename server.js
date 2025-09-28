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
  // NEW for admin features:
  addHour,
  renameHour,
  deleteHour,
  adminOverrideLabel,
} from "./src/db.js";

import { requireAuth, requireRole } from "./src/middleware/auth.js";
import { sendPasswordReset, sendWelcome } from "./src/mailer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = httpPkg.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";

// Views / static
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Security / parsing / logs
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(morgan("combined"));

// Sessions in Postgres
const PgSession = pgSimpleFactory(session);
const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "session",
    createTableIfMissing: true,
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});
app.use(sessionMiddleware);
io.engine.use((req, res, next) => sessionMiddleware(req, res, next));

// CSRF
const csrfProtection = csrf();
app.use(csrfProtection);

// Locals
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.user = req.session.user || null;
  next();
});

// Rate limit for auth endpoints
const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use(["/login", "/register", "/forgot", "/reset"], authLimiter);

// Broadcast helper
async function broadcastSlots() {
  const slots = await getSlotsWithReservations();
  io.emit("slots:update", { slots });
}

// ================== ROUTES ==================
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  return res.redirect("/login");
});

// Login
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login", { error: null });
});
app.post(
  "/login",
  body("email").isEmail(),
  body("password").isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render("login", { error: errors.array()[0].msg });
    }
    const { email, password } = req.body;
    const user = await userByEmail(email);
    if (!user) return res.status(401).render("login", { error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).render("login", { error: "Invalid credentials" });

    req.session.regenerate((err) => {
      if (err) return res.status(500).render("login", { error: "Server error (session)" });
      req.session.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name || "",
        last_name: user.last_name || "",
      };
      req.session.save(() => res.redirect("/dashboard"));
    });
  }
);

// Register
app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("register", { error: null });
});
app.post(
  "/register",
  body("first_name").trim().notEmpty(),
  body("last_name").trim().notEmpty(),
  body("email").isEmail(),
  body("password").isLength({ min: 6 }),
  body("confirm").custom((val, { req }) => val === req.body.password),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render("register", { error: errors.array()[0].msg });
    }
    const { first_name, last_name, email, password } = req.body;
    const exists = await userByEmail(email);
    if (exists) return res.status(400).render("register", { error: "Email already in use" });

    const hash = await bcrypt.hash(password, 12);
    const role = "user";
    const id = await insertUser(
      email,
      hash,
      role,
      dayjs().toISOString(),
      first_name.trim(),
      last_name.trim()
    );

    req.session.regenerate((err) => {
      if (err) return res.status(500).render("register", { error: "Server error (session)" });
      req.session.user = {
        id,
        email: email.toLowerCase(),
        role,
        first_name: first_name.trim(),
        last_name: last_name.trim(),
      };
      req.session.save(async () => {
        try { await sendWelcome(email.toLowerCase(), first_name.trim(), last_name.trim()); } catch {}
        return res.redirect("/dashboard");
      });
    });
  }
);

// Forgot / Reset
app.get("/forgot", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("forgot", { info: null, error: null });
});
app.post("/forgot", body("email").isEmail(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).render("forgot", { info: null, error: errors.array()[0].msg });
  }
  const { email } = req.body;
  const user = await userByEmail(email);
  if (user) {
    const token = nanoid(48);
    const expires_at = dayjs().add(1, "hour").toISOString();
    await insertReset(user.id, token, expires_at);
    try { await sendPasswordReset(user.email, token); } catch {}
  }
  return res.render("forgot", { info: "If the email exists, a reset link has been sent.", error: null });
});
app.get("/reset/:token", async (req, res) => {
  const row = await resetByToken(req.params.token);
  if (!row || dayjs().isAfter(dayjs(row.expires_at)) || row.used) {
    return res.status(400).send("Invalid or expired reset link.");
  }
  res.render("reset", { token: req.params.token, error: null });
});
app.post(
  "/reset/:token",
  body("password").isLength({ min: 6 }),
  body("confirm").custom((v, { req }) => v === req.body.password),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render("reset", { token: req.params.token, error: errors.array()[0].msg });
    }
    const row = await resetByToken(req.params.token);
    if (!row || dayjs().isAfter(dayjs(row.expires_at)) || row.used) {
      return res.status(400).send("Invalid or expired reset link.");
    }
    const hash = await bcrypt.hash(req.body.password, 12);
    await updateUserPassword(row.user_id, hash);
    await markResetUsed(row.id);
    return res.redirect("/login");
  }
);

// Dashboard + Admin (אותה תצוגה; אדמין רואה פעולות נוספות)
app.get("/dashboard", requireAuth, async (req, res) => {
  const slots = await getSlotsWithReservations();
  res.render("dashboard", { slots });
});
app.get("/admin", requireAuth, requireRole("admin"), async (req, res) => {
  const slots = await getSlotsWithReservations();
  res.render("dashboard", { slots });
});

// User actions
app.post("/reserve/:slotId", requireAuth, async (req, res) => {
  try {
    await reserveSlot(req.session.user.id, Number(req.params.slotId));
    await broadcastSlots();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).send(e?.message || "המשבצת תפוסה או לא פעילה.");
  }
});
app.post("/unreserve", requireAuth, async (req, res) => {
  await clearUserReservation(req.session.user.id);
  await broadcastSlots();
  return res.json({ ok: true });
});

// Admin per-slot actions
app.post("/admin/slots/:slotId/clear", requireAuth, requireRole("admin"), async (req, res) => {
  await clearSlotReservation(Number(req.params.slotId));
  await broadcastSlots();
  return res.json({ ok: true });
});
app.post("/admin/slots/:slotId/active", requireAuth, requireRole("admin"), async (req, res) => {
  await setSlotActive(Number(req.params.slotId), !!req.body.active);
  await broadcastSlots();
  return res.json({ ok: true });
});
app.post("/admin/slots/:slotId/label", requireAuth, requireRole("admin"), async (req, res) => {
  const slotId = Number(req.params.slotId);
  const label = (req.body.label ?? "").toString().trim();
  const lock = req.body.lock !== false; // default true: lock slot
  try {
    await adminOverrideLabel(slotId, label, lock);
    await broadcastSlots();
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ ok: false, error: e.message || "failed" });
  }
});

// Admin hour management
app.post("/admin/hours/add", requireAuth, requireRole("admin"), async (req, res) => {
  const time = (req.body.time_label || "").toString().trim();
  if (!/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ ok:false, error:"Invalid time format" });
  try {
    await addHour(time);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "failed" });
  }
});
app.post("/admin/hours/rename", requireAuth, requireRole("admin"), async (req, res) => {
  const oldTime = (req.body.old_time_label || "").toString().trim();
  const newTime = (req.body.new_time_label || "").toString().trim();
  if (!/^\d{1,2}:\d{2}$/.test(newTime)) return res.status(400).json({ ok:false, error:"Invalid time format" });
  try {
    await renameHour(oldTime, newTime);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "failed" });
  }
});
app.post("/admin/hours/delete", requireAuth, requireRole("admin"), async (req, res) => {
  const time = (req.body.time_label || "").toString().trim();
  try {
    await deleteHour(time);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "failed" });
  }
});

// Admin: clear-all
app.post("/admin/clear-all", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    await pool.query(`DELETE FROM reservations`);
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe'`);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to clear all" });
  }
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

// 404
app.use((req, res) => res.status(404).send("Not Found"));

// Daily auto-clear 15:00 Asia/Jerusalem
cron.schedule("0 15 * * *", async () => {
  try {
    await pool.query(`DELETE FROM reservations`);
    await pool.query(`UPDATE slots SET label='', color='#e0f2fe'`);
    await broadcastSlots();
    console.log("Daily clear-all executed (15:00 Asia/Jerusalem)");
  } catch (e) {
    console.error("Daily clear-all failed:", e);
  }
}, { timezone: "Asia/Jerusalem" });

// Start
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
