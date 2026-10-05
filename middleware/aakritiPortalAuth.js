const jwt = require('jsonwebtoken');

function portalSecret() {
  return process.env.AAKRITI_JWT_SECRET || process.env.JWT_SECRET;
}

/**
 * Requires Authorization: Bearer <aakriti portal JWT>
 */
function aakritiPortalAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Not authorized' });
  }
  try {
    const decoded = jwt.verify(token, portalSecret());
    if (decoded.typ !== 'aakriti_portal') {
      return res.status(401).json({ status: 'error', message: 'Invalid token' });
    }
    req.aakritiPortal = {
      role: decoded.role,
      sub: decoded.sub,
      username: decoded.username || '',
      gender: decoded.gender || ''
    };
    next();
  } catch (e) {
    return res.status(401).json({ status: 'error', message: 'Not authorized' });
  }
}

function requireAakritiPortalAdmin(req, res, next) {
  const r = req.aakritiPortal;
  if (!r || r.role !== 'admin') {
    return res.status(403).json({ status: 'error', message: 'Admin access required' });
  }
  next();
}

module.exports = {
  portalSecret,
  aakritiPortalAuth,
  requireAakritiPortalAdmin
};
