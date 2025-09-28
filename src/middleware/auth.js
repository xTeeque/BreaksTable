// src/middleware/auth.js
export function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect("/login");
  next();
}

export function requireRole(role) {
  return function (req, res, next) {
    if (!req.session || !req.session.user) return res.redirect("/login");
    if (req.session.user.role !== role) return res.status(403).send("Forbidden");
    next();
  };
}
