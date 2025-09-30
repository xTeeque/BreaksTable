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
import rateLimit from "express-rate-limit";
import httpPkg from "http";
import { Server as SocketIOServer } from "socket.io";
import crypto from "crypto";

import {
  pool,
  userByEmail,
  insertUser,
  updateUserPassword,
  getSlotsWithReservations,
  reserveSlot,
  clearUserReservation,
  clearSlotReservation,
  setSlotActive,
  updateSlot,
  createHour,
  renameHour,
  deleteHour,
} from "./src/db.js";

import {
  requireAuth,
  requireRole,
  nullableTrim,
  safeLower,
  safeString,
} from "./src/middleware/auth.js";

import {
  savePushSubscription,
  removePushSubscription,
  findDueReminders,
  markReminderSent,
  sendPushToUser,
} from "./src/push.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = httpPkg.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "*", methods: ["GET", "POST"] } });

async function broadcastSlots() {
  try { io.emit("slots:update", { at: Date.now() }); } catch (e) { console.error("broadcast error:", e); }
}

/* ---------- אבטחה/פרסרים/לוגים ---------- */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan("dev"));

/* ---------- סטטי ---------- */
app.use(express.static(path.join(__dirname, "public")));

const PgStore = pgSimpleFactory(session);
app.use(session({
  store: new PgStore({ pool, tableName: "session", createTableIfMissing: true }),
  name: "sid",
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: !!process.env.COOKIE_SECURE, maxAge: 1000*60*60*24*14 },
}));

const csrfProtection = csrf();
app.use(csrfProtection);

const limiter = rateLimit({ windowMs: 60_000, max: 300 });
app.use(limiter);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* ------------------ Pages ------------------ */

app.get("/", requireAuth, async (req, res, next) => {
  try {
    const slots = await getSlotsWithReservations();
    res.render("dashboard", { slots, user: req.session.user, csrfToken: req.csrfToken() });
  } catch (e) { next(e); }
});
app.get("/dashboard", requireAuth, (req, res) => res.redirect("/"));

app.get("/login", (req, res) => res.render("login", { csrfToken: req.csrfToken() }));

app.post("/login",
  body("email").isEmail(),
  body("password").isString().isLength({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).render("login", { csrfToken: req.csrfToken(), error: "Invalid payload" });

    const email = safeLower(req.body.email);
    const user = await userByEmail(email);
    if (!user) return res.status(401).render("login", { csrfToken: req.csrfToken(), error: "User not found" });

    const ok = await bcrypt.compare(String(req.body.password), user.password_hash);
    if (!ok) return res.status(401).render("login", { csrfToken: req.csrfToken(), error: "Wrong password" });

    req.session.user = {
      id: user.id, email: user.email, role: user.role,
      first_name: user.first_name, last_name: user.last_name
    };
    res.redirect("/");
  }
);

app.post("/logout", (req, res) => { req.session.destroy(() => res.redirect("/login")); });

app.get("/register", (req, res) => res.render("register", { csrfToken: req.csrfToken() }));

app.post("/register",
  body("email").isEmail(),
  body("password").isString().isLength({ min: 6 }),
  body("first_name").optional().isString(),
  body("last_name").optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const msg = errors.array()[0]?.msg || "Invalid payload";
      return res.status(400).render("register", { csrfToken: req.csrfToken(), error: msg });
    }

    const email = safeLower(req.body.email);
    const passHash = await bcrypt.hash(String(req.body.password), 10);
    const first = safeString(req.body.first_name);
    const last  = safeString(req.body.last_name);

    try {
      await insertUser({ email, password_hash: passHash, first_name: first, last_name: last });
      res.redirect("/login");
    } catch (e) {
      console.error(e);
      res.status(400).render("register", { csrfToken: req.csrfToken(), error: "Cannot create user" });
    }
  }
);

/* ---- Profile: ניהול התראות דפדפן ---- */
app.get("/profile", requireAuth, (req, res) => {
  const user = { ...req.session.user };
  res.render("profile", {
    csrfToken: req.csrfToken(),
    user,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || ""
  });
});

/* ------------------ Forgot / Reset ללא מייל ------------------ */
app.get("/forgot", (req, res) => {
  res.render("forgot", { csrfToken: req.csrfToken() });
});

app.post("/forgot", body("email").isEmail(), async (req, res) => {
  const email = safeLower(req.body.email);
  const user = await userByEmail(email);

  if (user) {
    req.session.resetUserId = user.id;
    req.session.resetUntil = Date.now() + (60 * 60 * 1000); // שעה
    return res.redirect("/reset");
  }

  res.render("forgot", {
    csrfToken: req.csrfToken(),
    message: "אם קיים חשבון עם האימייל שהוזן — נשלחה הודעת איפוס."
  });
});

app.get("/reset", (req, res) => {
  if (!req.session.resetUserId || !req.session.resetUntil || Date.now() > req.session.resetUntil) {
    return res.status(400).render("forgot", { csrfToken: req.csrfToken(), error: "קישור איפוס לא תקף או שפג תוקפו. נסו שוב." });
  }
  res.render("reset", { csrfToken: req.csrfToken() });
});

app.post("/reset",
  body("password").isString().isLength({ min: 6 }),
  async (req, res) => {
    if (!req.session.resetUserId || !req.session.resetUntil || Date.now() > req.session.resetUntil) {
      return res.status(400).render("forgot", { csrfToken: req.csrfToken(), error: "קישור איפוס לא תקף או שפג תוקפו. נסו שוב." });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render("reset", { csrfToken: req.csrfToken(), error: "סיסמה חייבת להיות באורך 6 תווים ומעלה" });
    }

    const userId = req.session.resetUserId;
    const passHash = await bcrypt.hash(String(req.body.password), 10);
    await updateUserPassword(userId, passHash);

    delete req.session.resetUserId;
    delete req.session.resetUntil;

    res.redirect("/login");
  }
);

/* ------------------ User actions ------------------ */

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

/* ------------------ Admin actions ------------------ */

app.post("/admin/slots/:slotId/clear", requireAuth, requireRole("admin"), async (req, res) => {
  await clearSlotReservation(Number(req.params.slotId));
  await broadcastSlots();
  res.json({ ok: true });
});

app.post("/admin/slots/:slotId/active", requireAuth, requireRole("admin"), async (req, res) => {
  const slotId = Number(req.params.slotId);
  const active = !!req.body.active;
  if (!active) { await clearSlotReservation(slotId); }
  await setSlotActive(slotId, active);
  await broadcastSlots();
  res.json({ ok: true });
});

// שינוי שם שעה: תומך בכמה פורמטים של קלט (from/to או time_label/to או slot_id/to)
app.post("/admin/hours/rename", requireAuth, requireRole("admin"), async (req, res) => {
  // קליטת ערכים
  let from = (req.body.from ?? req.body.time_label ?? "").toString().trim();
  const to  = (req.body.to ?? "").toString().trim();
  const slotId = req.body.slot_id ? Number(req.body.slot_id) : null;

  // אם חסר "from" אבל הגיע slot_id — נשלוף מה-DB
  if (!/^[0-2]\d:\d{2}$/.test(from) && slotId) {
    const { rows } = await pool.query("SELECT time_label FROM slots WHERE id = $1", [slotId]);
    if (rows.length) from = rows[0].time_label;
  }

  // ולידציה סופית
  if (!/^[0-2]\d:\d{2}$/.test(from) || !/^[0-2]\d:\d{2}$/.test(to)) {
    return res.status(400).send("HH:MM required");
  }

  try {
    await renameHour(from, to);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    res.status(409).send(e?.message || "Cannot rename hour");
  }
});

// יצירת שעה (תיקון ולידציה: HH:MM)
app.post("/admin/hours/create", requireAuth, requireRole("admin"), async (req, res) => {
  const tl = (req.body.time_label ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(tl)) return res.status(400).send("HH:MM required");
  await createHour(tl);
  await broadcastSlots();
  res.json({ ok: true });
});

app.post("/admin/hours/delete", requireAuth, requireRole("admin"), async (req, res) => {
  const tl = (req.body.time_label ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(tl)) return res.status(400).send("HH:MM required");
  await deleteHour(tl);
  await broadcastSlots();
  res.json({ ok: true });
});

// ניקוי כללי: איפוס צבע/טקסט לכל משבצת לא תפוסה (שאינה נעולה ע"י אדמין)
app.post("/admin/cleanup", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    await pool.query(`
      UPDATE slots s
      SET color = '#e5e7eb', label = ''
      WHERE NOT EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = s.id)
        AND COALESCE(admin_lock, false) = false
    `);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    console.error("cleanup failed:", e);
    res.status(500).send("Cleanup failed");
  }
});

/* ------------------ Web Push API + CRON (לא רלוונטי כאן קוצר) ------------------ */

app.post("/tasks/send-due-reminders", async (req, res) => {
  const secret = req.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(403).send("Forbidden");
  }
  const due = await findDueReminders();
  for (const row of due) {
    const hhmm = row.time_label;
    const payload = {
      title: "⏰ תזכורת: בעוד 3 דקות",
      body:  `המשבצת שלך ל־${hhmm} מתקרבת.`,
      url:   `${process.env.APP_BASE_URL || ""}/`,
      tag:   `slot-${row.slot_id}-${hhmm}`
    };
    await sendPushToUser(row.user_id, payload);
    await markReminderSent(row.user_id, row.slot_id, row.scheduled_for);
  }
  res.json({ ok: true, sent: due.length });
});

/* ------------------ Errors & 404 ------------------ */
app.use((err, req, res, next) => {
  if (err && err.code === "EBADCSRFTOKEN") {
    return res.status(403).send("Invalid CSRF token");
  }
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).send("Server error");
});

app.use((req, res) => res.status(404).send("Not Found"));

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
