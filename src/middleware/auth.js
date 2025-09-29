// src/middleware/auth.js

/** דורש התחברות — אחרת מפנה לעמוד התחברות */
export function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect("/login");
  next();
}

/** דורש תפקיד מסוים (למשל "admin") — אחרת 403 */
export function requireRole(role) {
  return (req, res, next) => {
    if (req.session?.user?.role !== role) return res.status(403).send("Forbidden");
    next();
  };
}

/** מחזיר מחרוזת מנוקָה ורבועה; אם null/undefined — מחזיר undefined (כדי לא לגעת בשדה) */
export function nullableTrim(v) {
  if (v === undefined || v === null) return undefined;
  return String(v).trim();
}

/** מנמיך אותיות ומסיר רווחים; אם null/undefined — מחזיר מחרוזת ריקה */
export function safeLower(v) {
  return String(v ?? "").toLowerCase().trim();
}

/** ממיר למחרוזת ומסיר רווחים; אם null/undefined — מחזיר מחרוזת ריקה */
export function safeString(v) {
  return String(v ?? "").trim();
}
