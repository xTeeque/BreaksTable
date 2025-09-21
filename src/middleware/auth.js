
export function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.session.user?.role !== role) return res.status(403).send("Forbidden");
    next();
  };
}
