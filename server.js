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
  createHour,
  renameHour,
  deleteHour,
  updateUserPhone,
} from "./src/db.js";

import {
  requireAuth,
  requireRole,
  nullableTrim,
  safeLower,
  safeString,
} from "./src/middleware/auth.js";

import { sendPasswordReset } from "./src/mailer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = httpPkg.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "*", methods: ["GET", "POST"] } });

async function broadcastSlots() {
  try { io.emit("slots:update", { at: Date.now() }); } catch (e) { console.error("broadcast error:", e); }
}

/* ---------- Normalization helpers (טלפון ישראלי -> E.164) ---------- */
function normalizeILPhone(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (s === "") return null;
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("+")) {
    if (!/^\+\d{8,15}$/.test(s)) throw new Error("מספר טלפון לא תקין");
    return s;
  }
  if (s.startsWith("972")) {
    s = "+" + s;
    if (!/^\+\d{8,15}$/.test(s)) throw new Error("מספר טלפון לא תקין");
    return s;
  }
  s = s.replace(/^0+/, "");
  s = "+972" + s;
  if (!/^\+\d{8,15}$/.test(s)) throw new Error("מספר טלפון לא תקין");
  return s;
}
function e164ToLocalIL(e164) {
  if (!e164) return "";
  let s = String(e164).replace(/[^\d]/g, "");
  if (s.startsWith("972")) s = "0" + s.slice(3);
  else if (!s.startsWith("0") && /^\d+$/.test(s)) s = "0" + s;
  return s;
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
      first_name: user.first_name, last_name: user.last_name, phone: user.phone
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
  body("phone").optional().isString(),
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

    let phone = safeString(req.body.phone);
    try {
      phone = phone ? normalizeILPhone(phone) : null;
    } catch (e) {
      return res.status(400).render("register", { csrfToken: req.csrfToken(), error: e.message || "מספר טלפון לא תקין" });
    }

    try {
      await insertUser({ email, password_hash: passHash, first_name: first, last_name: last, phone });
      res.redirect("/login");
    } catch (e) {
      console.error(e);
      res.status(400).render("register", { csrfToken: req.csrfToken(), error: "Cannot create user" });
    }
  }
);

/* ---- Profile ---- */
app.get("/profile", requireAuth, (req, res) => {
  const user = { ...req.session.user, phone_local: e164ToLocalIL(req.session.user.phone) };
  res.render("profile", { csrfToken: req.csrfToken(), user });
});
app.post("/profile",
  requireAuth,
  body("phone").optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const msg = errors.array()[0]?.msg || "Invalid payload";
      const user = { ...req.session.user, phone_local: e164ToLocalIL(req.session.user.phone) };
      return res.status(400).render("profile", { csrfToken: req.csrfToken(), user, error: msg });
    }
    const raw = safeString(req.body.phone);
    let normalized = null;
    try {
      normalized = raw ? normalizeILPhone(raw) : null;
    } catch (e) {
      const user = { ...req.session.user, phone_local: raw };
      return res.status(400).render("profile", { csrfToken: req.csrfToken(), user, error: e.message || "מספר טלפון לא תקין" });
    }
    await updateUserPhone(req.session.user.id, normalized);
    req.session.user.phone = normalized;
    const user = { ...req.session.user, phone_local: e164ToLocalIL(normalized) };
    res.render("profile", { csrfToken: req.csrfToken(), user, message: "עודכן בהצלחה" });
  }
);

/* ---- Forgot / Reset password ---- */
app.get("/forgot", (req, res) => {
  res.render("forgot", { csrfToken: req.csrfToken() });
});

app.post("/forgot", body("email").isEmail(), async (req, res) => {
  const email = safeLower(req.body.email);
  const user = await userByEmail(email);
  const token = nanoid(32);
  if (user) {
    await insertReset({ user_id: user.id, token, expires_at: dayjs().add(1, "hour").toISOString() });
    try { await sendPasswordReset(email, token); } catch (e) { console.error("sendPasswordReset failed:", e?.message || e); }
  }
  // אל תחשוף אם המשתמש קיים
  res.render("forgot", { csrfToken: req.csrfToken(), message: "אם קיים חשבון עם האימייל שהוזן — נשלחה הודעת איפוס." });
});

app.get("/reset/:token", async (req, res) => {
  const record = await resetByToken(req.params.token);
  if (!record) return res.status(400).send("Invalid or expired");
  res.render("reset", { token: req.params.token, csrfToken: req.csrfToken() });
});

app.post("/reset/:token",
  body("password").isString().isLength({ min: 6 }),
  async (req, res) => {
    const rec = await resetByToken(req.params.token);
    if (!rec) return res.status(400).send("Invalid or expired");

    const errs = validationResult(req);
    if (!errs.isEmpty()) {
      return res.status(400).render("reset", { token: req.params.token, csrfToken: req.csrfToken(), error: "סיסמה חייבת להיות באורך 6 תווים ומעלה" });
    }

    await updateUserPassword(rec.user_id, await bcrypt.hash(String(req.body.password), 10));
    await markResetUsed(req.params.token);
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

app.post("/admin/slots/:slotId/label", requireAuth, requireRole("admin"), async (req, res) => {
  const slotId = Number(req.params.slotId);
  const label = (req.body.label ?? "").toString().trim();
  await clearSlotReservation(slotId);
  await updateSlot(slotId, { label, color: label ? "#86efac" : "#e0f2fe", admin_lock: !!label });
  await broadcastSlots();
  return res.json({ ok: true });
});

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

app.post("/admin/hours/create", requireAuth, requireRole("admin"), async (req, res) => {
  const tl = (req.body.time_label ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(tl)) return res.status(400).send("HH:MM required");
  await createHour(tl);
  await broadcastSlots();
  res.json({ ok: true });
});
app.post("/admin/hours/rename", requireAuth, requireRole("admin"), async (req, res) => {
  const from = (req.body.from ?? "").toString().trim();
  const to   = (req.body.to ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(from) || !/^[0-2]\d:\d{2}$/.test(to)) return res.status(400).send("HH:MM required");
  try {
    await renameHour(from, to);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    res.status(409).send(e?.message || "Cannot rename hour");
  }
});
app.post("/admin/hours/delete", requireAuth, requireRole("admin"), async (req, res) => {
  const tl = (req.body.time_label ?? "").toString().trim();
  if (!/^[0-2]\d:\d{2}$/.test(tl)) return res.status(400).send("HH:MM required");
  await deleteHour(tl);
  await broadcastSlots();
  res.json({ ok: true });
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
