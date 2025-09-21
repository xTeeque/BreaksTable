
import express from "express";
import session from "express-session";
import FileStoreFactory from "session-file-store";
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
import db from "./src/db.js";
import { requireAuth, requireRole } from "./src/middleware/auth.js";
import { sendPasswordReset, sendWelcome } from "./src/mailer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FileStore = FileStoreFactory(session);

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";
const NODE_ENV = process.env.NODE_ENV || "development";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(morgan("combined"));
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
  store: new FileStore({ path: path.join(__dirname, "data", "sessions") }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const csrfProtection = csrf();
app.use(csrfProtection);

const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use(["/login", "/register", "/forgot", "/reset"], authLimiter);

app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.user = req.session.user || null;
  next();
});

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login", { error: null });
});

app.post("/login",
  body("email").isEmail().withMessage("Email is invalid"),
  body("password").isLength({ min: 6 }).withMessage("Password is required"),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render("login", { error: errors.array()[0].msg });
    }
    const { email, password } = req.body;
    const user = db.userByEmail(email.toLowerCase());
    if (!user) return res.status(401).render("login", { error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).render("login", { error: "Invalid credentials" });

    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate error:", err);
        return res.status(500).render("login", { error: "Server error (session)" });
      }
      req.session.user = {
        id: user.id, email: user.email, role: user.role,
        first_name: user.first_name || "", last_name: user.last_name || ""
      };
      req.session.save((err2) => {
        if (err2) {
          console.error("Session save error:", err2);
          return res.status(500).render("login", { error: "Server error (session save)" });
        }
        res.redirect("/dashboard");
      });
    });
  }
);

app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("register", { error: null });
});

app.post("/register",
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
    const exists = db.userByEmail(email.toLowerCase());
    if (exists) return res.status(400).render("register", { error: "Email already in use" });

    const hash = await bcrypt.hash(password, 12);
    const role = "user";
    const id = db.insertUser(email.toLowerCase(), hash, role, dayjs().toISOString(), first_name.trim(), last_name.trim());

    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate error:", err);
        return res.status(500).render("register", { error: "Server error (session)" });
      }
      req.session.user = {
        id, email: email.toLowerCase(), role,
        first_name: first_name.trim(), last_name: last_name.trim()
      };
      req.session.save(async (err2) => {
        if (err2) {
          console.error("Session save error:", err2);
          return res.status(500).render("register", { error: "Server error (session save)" });
        }
        try { await sendWelcome(email.toLowerCase(), first_name.trim(), last_name.trim()); } catch {}
        res.redirect("/dashboard");
      });
    });
  }
);

app.get("/forgot", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("forgot", { info: null, error: null });
});

app.post("/forgot",
  body("email").isEmail().withMessage("Email is invalid"),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render("forgot", { info: null, error: errors.array()[0].msg });
    }
    const { email } = req.body;
    const user = db.userByEmail(email.toLowerCase());
    if (user) {
      const token = nanoid(48);
      const expires_at = dayjs().add(1, "hour").toISOString();
      db.insertReset(user.id, token, expires_at);
      try { await sendPasswordReset(user.email, token); } catch {}
    }
    return res.render("forgot", { info: "If the email exists, a reset link has been sent.", error: null });
  }
);

app.get("/reset/:token", (req, res) => {
  const { token } = req.params;
  const row = db.resetByToken(token);
  if (!row || dayjs().isAfter(dayjs(row.expires_at)) || row.used) {
    return res.status(400).send("Invalid or expired reset link.");
  }
  res.render("reset", { token, error: null });
});

app.post("/reset/:token",
  body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 chars"),
  body("confirm").custom((val, { req }) => val === req.body.password).withMessage("Passwords do not match"),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render("reset", { token: req.params.token, error: errors.array()[0].msg });
    }
    const { token } = req.params;
    const row = db.resetByToken(token);
    if (!row || dayjs().isAfter(dayjs(row.expires_at)) || row.used) {
      return res.status(400).send("Invalid or expired reset link.");
    }
    const hash = await bcrypt.hash(req.body.password, 12);
    db.updateUserPassword(row.user_id, hash);
    db.markResetUsed(row.id);
    res.redirect("/login");
  }
);

app.get("/dashboard", requireAuth, (req, res) => {
  res.render("dashboard");
});

app.get("/admin", requireAuth, requireRole("admin"), (req, res) => {
  res.send("<h1>Admin area</h1><p>Only admins can see this.</p>");
});

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

app.use((req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
