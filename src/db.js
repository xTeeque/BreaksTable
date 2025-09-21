
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "app.sqlite");

let SQL = null;
let db = null;

function save() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function tableColumns(name) {
  const res = db.exec(`PRAGMA table_info(${name});`);
  if (!res || !res[0]) return [];
  const rows = res[0].values;
  return rows.map((r) => r[1]);
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  const cols = tableColumns("users");
  if (!cols.includes("first_name")) db.exec(`ALTER TABLE users ADD COLUMN first_name TEXT;`);
  if (!cols.includes("last_name")) db.exec(`ALTER TABLE users ADD COLUMN last_name TEXT;`);

  save();
}

async function init() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  if (fs.existsSync(dbPath)) {
    const filebuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(filebuffer);
    ensureSchema();
  } else {
    db = new SQL.Database();
    ensureSchema();
  }
}

await init();

function userByEmail(email) {
  const stmt = db.prepare("SELECT id, email, password_hash, role, first_name, last_name FROM users WHERE email = ?");
  stmt.bind([email]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function insertUser(email, password_hash, role, created_at, first_name = "", last_name = "") {
  const stmt = db.prepare("INSERT INTO users (email, password_hash, role, created_at, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)");
  stmt.run([email, password_hash, role, created_at, first_name, last_name]);
  stmt.free();
  const id = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0];
  save();
  return id;
}

function insertReset(user_id, token, expires_at) {
  const stmt = db.prepare("INSERT INTO password_resets (user_id, token, expires_at, used) VALUES (?, ?, ?, 0)");
  stmt.run([user_id, token, expires_at]);
  stmt.free();
  save();
}

function resetByToken(token) {
  const stmt = db.prepare("SELECT * FROM password_resets WHERE token = ?");
  stmt.bind([token]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function updateUserPassword(user_id, password_hash) {
  const stmt = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
  stmt.run([password_hash, user_id]);
  stmt.free();
  save();
}

function markResetUsed(id) {
  const stmt = db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?");
  stmt.run([id]);
  stmt.free();
  save();
}

export default {
  userByEmail,
  insertUser,
  insertReset,
  resetByToken,
  updateUserPassword,
  markResetUsed,
};
