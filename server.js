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

import db, {
  userByEmail,
  insertUser,
  insertReset,
  resetByToken,
  updateUserPassword,
  markResetUsed,

  // grid / slots
  getSlotsWithReservations,
  reserveSlot,
  clearUserReservation,
  clearSlotReservation,
  setSlotActive,
  updateSlot,
  createSlot,
  deleteSlot,
} from "./src/db.js";

import { requireAuth, requireRole } from "./src/middleware/auth.js";
import { sendPasswordReset, sendWelcome } from "./src/mailer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";

// ---------- Views / static ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Security / parsing / logs ----------
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(morgan("combined"));

// ---------- Sessions stored in Postgres ----------
const PgSession = pgSimpleFactory(session);
app.use(
  session({
    store: new PgSession({
      pool: db.pool,
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
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// ---------- CSRF ----------
const csrfProtection = csrf();
app.use(csrfProtection);

// ---------- Locals ----------
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.user = req.session.user || null;
  next();
});

// ---------- Rate limit למסלולי auth ----------
const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use(["/login", "/register", "/forgot", "/reset"], authLimiter);

// ================== ROUTES ==================

// Root
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  return res.redirect("/login");
});

// -------- Login --------
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login", { error: null });
});

app.post(
  "/login",
  body("email").isEmail().withMessage("Email is invalid"),
  body("password").isLength({ min: 6 }).withMessage("Password is required"),
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
      if (err) {
        console.error("Session regenerate error:", err);
        return res.status(500).render("login", { error: "Server error (session)" });
      }
      req.session.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name || "",
        last_name: user.last_name || "",
      };
      req.session.save((err2) => {
        if (err2) {
          console.error("Session save error:", err2);
          return res.status(500).render("login", { error: "Server error (session save)" });
        }
        return res.redirect("/dashboard");
      });
    });
  }
);

// -------- Register --------
app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("register", { error: null });
});

app.post(
  "/register",
  body("first_name").trim().notEmpty().withMessage("First name is required"),
  body("last_name").trim().notEmpty().withMessage("Last name is required"),
  body("email").isEmail().withMessage("Email is invalid"),
  body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 chars"),
  body("confirm").custom((val, { req }) => val === req.body.password).withMessage("Passwords do not match"),
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
      if (err) {
        console.error("Session regenerate error:", err);
        return res.status(500).render("register", { error: "Server error (session)" });
      }
      req.session.user = {
        id,
        email: email.toLowerCase(),
        role,
        first_name: first_name.trim(),
        last_name: last_name.trim(),
      };
      req.session.save(async (err2) => {
        if (err2) {
          console.error("Session save error:", err2);
          return res.status(500).render("register", { error: "Server error (session save)" });
        }
        try {
          await sendWelcome(email.toLowerCase(), first_name.trim(), last_name.trim());
        } catch (e) {
          console.error("[MAIL][welcome] error:", e?.message || e);
        }
        return res.redirect("/dashboard");
      });
    });
  }
);

// -------- Forgot / Reset --------
app.get("/forgot", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("forgot", { info: null, error: null });
});

app.post(
  "/forgot",
  body("email").isEmail().withMessage("Email is invalid"),
  async (req, res) => {
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
      try {
        await sendPasswordReset(user.email, token);
      } catch (e) {
        console.error("[MAIL][reset] error:", e?.message || e);
      }
    }
    return res.render("forgot", { info: "If the email exists, a reset link has been sent.", error: null });
  }
);

app.get("/reset/:token", async (req, res) => {
  const { token } = req.params;
  const row = await resetByToken(token);
  if (!row || dayjs().isAfter(dayjs(row.expires_at)) || row.used) {
    return res.status(400).send("Invalid or expired reset link.");
  }
  res.render("reset", { token, error: null });
});

app.post(
  "/reset/:token",
  body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 chars"),
  body("confirm").custom((val, { req }) => val === req.body.password).withMessage("Passwords do not match"),
  async (req, res) => {
    const errors = validationResult(req);
    const { token } = req.params;

    if (!errors.isEmpty()) {
      return res.status(400).render("reset", { token, error: errors.array()[0].msg });
    }
    const row = await resetByToken(token);
    if (!row || dayjs().isAfter(dayjs(row.expires_at)) || row.used) {
      return res.status(400).send("Invalid or expired reset link.");
    }
    const hash = await bcrypt.hash(req.body.password, 12);
    await updateUserPassword(row.user_id, hash);
    await markResetUsed(row.id);
    return res.redirect("/login");
  }
);

// -------- Dashboard + Grid --------
// הצגה: עמודת שעה מימין + 4 משבצות משמאל (הקיבוץ לפי time_label נעשה ב-EJS)
app.get("/dashboard", requireAuth, async (req, res) => {
  const slots = await getSlotsWithReservations();
  res.render("dashboard", { slots });
});

// משתמש: הרשמה/ביטול (משבצת אחת למשתמש)
app.post("/reserve/:slotId", requireAuth, async (req, res) => {
  try {
    await reserveSlot(req.session.user.id, Number(req.params.slotId));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).send(e?.message || "המשבצת תפוסה או לא פעילה.");
  }
});

app.post("/unreserve", requireAuth, async (req, res) => {
  await clearUserReservation(req.session.user.id);
  return res.json({ ok: true });
});

// אדמין: ניקוי, פתיחה/סגירה, כתיבת שם ידני
app.post("/admin/slots/:slotId/clear", requireAuth, requireRole("admin"), async (req, res) => {
  await clearSlotReservation(Number(req.params.slotId));
  return res.json({ ok: true });
});

app.post("/admin/slots/:slotId/active", requireAuth, requireRole("admin"), async (req, res) => {
  const active = !!req.body.active;
  await setSlotActive(Number(req.params.slotId), active);
  return res.json({ ok: true });
});

// כתיבת label ידנית (אם ריק – מחזיר לצבע ניטרלי)
app.post("/admin/slots/:slotId/label", requireAuth, requireRole("admin"), async (req, res) => {
  const slotId = Number(req.params.slotId);
  const label = (req.body.label ?? "").toString().trim();
  await updateSlot(slotId, { label, color: label ? "#86efac" : "#e5e7eb" });
  return res.json({ ok: true });
});

// (אופציונלי) אדמין: עדכון/יצירה/מחיקה גנריים
app.post("/admin/slots/update", requireAuth, requireRole("admin"), async (req, res) => {
  const { slot_id, label, color, time_label } = req.body;
  await updateSlot(Number(slot_id), { label, color, time_label });
  return res.redirect("/dashboard");
});

app.post("/admin/slots/create", requireAuth, requireRole("admin"), async (req, res) => {
  const { label, color, time_label, col_index, row_index, active } = req.body;
  await createSlot({
    label: label ?? "",
    color: color ?? "#e5e7eb",
    time_label,
    col_index: Number(col_index),   // 1..4 בלבד (אין תאי שעה ב־DB)
    row_index: Number(row_index),   // שורת השעה
    is_time: false,
    active: active !== "false",
  });
  return res.redirect("/dashboard");
});

app.post("/admin/slots/delete", requireAuth, requireRole("admin"), async (req, res) => {
  const { slot_id } = req.body;
  await deleteSlot(Number(slot_id));
  return res.redirect("/dashboard");
});

// -------- Logout --------
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

// 404
app.use((req, res) => res.status(404).send("Not Found"));

// Start
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
