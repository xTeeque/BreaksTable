// server.js
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import morgan from "morgan";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import csrf from "csurf";
import flash from "connect-flash";
import { Server } from "socket.io";
import http from "http";

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
  addHour,
  renameHour,
  deleteHour,
  adminOverrideLabel,
  ensureReservationConstraints
} from "./src/db.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========== Middlewares ==========
app.use(helmet());
app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 }
  })
);

app.use(csrf());
app.use(flash());

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ========== Helpers ==========
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).send("Forbidden");
    }
    next();
  };
}

// Socket.IO broadcaster
async function broadcastSlots() {
  const slots = await getSlotsWithReservations();
  io.emit("slots:update", slots);
}

// ========== Routes ==========
app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) => {
  res.render("login", { csrfToken: req.csrfToken(), error: req.flash("error") });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await userByEmail(email);
  if (!user) {
    req.flash("error", "משתמש לא נמצא");
    return res.redirect("/login");
  }
  const bcrypt = await import("bcryptjs");
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    req.flash("error", "סיסמה שגויה");
    return res.redirect("/login");
  }
  req.session.user = { id: user.id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name };
  res.redirect("/dashboard");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/register", (req, res) => {
  res.render("register", { csrfToken: req.csrfToken(), error: req.flash("error") });
});

app.post("/register", async (req, res) => {
  const { email, password, first_name, last_name, phone } = req.body;
  try {
    await insertUser({ email, password, first_name, last_name, phone, role: "user" });
    res.redirect("/login");
  } catch (e) {
    req.flash("error", "שגיאה בהרשמה: " + e.message);
    res.redirect("/register");
  }
});

app.get("/dashboard", requireAuth, async (req, res) => {
  const slots = await getSlotsWithReservations();
  res.render("dashboard", {
    user: req.session.user,
    slots,
    csrfToken: req.csrfToken()
  });
});

// ========== Reservations ==========
app.post("/reserve/:id", requireAuth, async (req, res) => {
  try {
    await reserveSlot(req.session.user.id, req.params.id);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/unreserve", requireAuth, async (req, res) => {
  try {
    await clearUserReservation(req.session.user.id);
    await broadcastSlots();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ========== Admin ==========
app.post("/admin/slots/:id/clear", requireAuth, requireRole("admin"), async (req, res) => {
  await clearSlotReservation(req.params.id);
  await broadcastSlots();
  res.json({ ok: true });
});

app.post("/admin/slots/:id/active", requireAuth, requireRole("admin"), async (req, res) => {
  await setSlotActive(req.params.id, req.body.active);
  await broadcastSlots();
  res.json({ ok: true });
});

app.post("/admin/slots/:id/label", requireAuth, requireRole("admin"), async (req, res) => {
  await adminOverrideLabel(req.params.id, req.body.label);
  await broadcastSlots();
  res.json({ ok: true });
});

app.post("/admin/clear-all", requireAuth, requireRole("admin"), async (req, res) => {
  await pool.query(`DELETE FROM reservations`);
  await pool.query(`UPDATE slots SET label='', color='#e0f2fe'`);
  await broadcastSlots();
  res.json({ ok: true });
});

// שעות
app.post("/admin/hours/add", requireAuth, requireRole("admin"), async (req, res) => {
  await addHour(req.body.time_label);
  await broadcastSlots();
  res.json({ ok: true });
});
app.post("/admin/hours/rename", requireAuth, requireRole("admin"), async (req, res) => {
  await renameHour(req.body.old_time_label, req.body.new_time_label);
  await broadcastSlots();
  res.json({ ok: true });
});
app.post("/admin/hours/delete", requireAuth, requireRole("admin"), async (req, res) => {
  await deleteHour(req.body.time_label);
  await broadcastSlots();
  res.json({ ok: true });
});

// ========== Socket.IO ==========
io.on("connection", (socket) => {
  console.log("Client connected");
});

// ========== Start ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log("Server running on http://localhost:" + PORT);
  await ensureReservationConstraints();
});
