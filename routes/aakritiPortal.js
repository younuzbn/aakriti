const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const AakritiPortalUser = require('../models/AakritiPortalUser');
const AakritiAppointment = require('../models/AakritiAppointment');
const AakritiSettings = require('../models/AakritiSettings');
const AakritiStylist = require('../models/AakritiStylist');
const aakritiAppointmentHandlers = require('./aakritiAppointmentHandlers');
const {
  aakritiPortalAuth,
  requireAakritiPortalAdmin,
  portalSecret
} = require('../middleware/aakritiPortalAuth');

const router = express.Router();
const portalApi = express.Router();
const STYLIST_UPLOAD_DIR = path.join(__dirname, '../public/uploads/aakriti-stylists');

function ensureStylistUploadDir() {
  if (!fs.existsSync(STYLIST_UPLOAD_DIR)) {
    fs.mkdirSync(STYLIST_UPLOAD_DIR, { recursive: true });
  }
}

function safeFileExt(mimeType, originalName) {
  const byMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/webm': '.webm',
    'video/mp4': '.mp4'
  };
  if (byMime[mimeType]) return byMime[mimeType];
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.webm', '.mp4'].includes(ext)) return ext;
  return '';
}

const stylistUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        ensureStylistUploadDir();
        cb(null, STYLIST_UPLOAD_DIR);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const ext = safeFileExt(file.mimetype, file.originalname);
      cb(null, `stylist_${Date.now()}_${Math.random().toString(36).slice(2, 9)}${ext || ''}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const allowed = new Set([
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/gif',
      'video/webm',
      'video/mp4'
    ]);
    if (!allowed.has(mime)) {
      const err = new Error('Only png, jpg, jpeg, webp, gif, webm, mp4 files are allowed');
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createPortalUserInDb(body) {
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const role = String(body?.role || 'staff').trim().toLowerCase();
  const gender = ['male', 'female'].includes(String(body?.gender || '').trim().toLowerCase())
    ? String(body.gender).trim().toLowerCase()
    : '';

  if (!username || !password) {
    const err = new Error('Username and password are required');
    err.statusCode = 400;
    throw err;
  }
  if (password.length < 6) {
    const err = new Error('Password must be at least 6 characters');
    err.statusCode = 400;
    throw err;
  }
  if (!['admin', 'staff'].includes(role)) {
    const err = new Error('Invalid role');
    err.statusCode = 400;
    throw err;
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);
  return AakritiPortalUser.create({
    username,
    passwordHash,
    role,
    gender,
    isActive: true
  });
}

function signPortalToken(payload) {
  return jwt.sign(
    {
      typ: 'aakriti_portal',
      role: payload.role,
      sub: payload.sub,
      username: payload.username || '',
      gender: payload.gender || ''
    },
    portalSecret(),
    { expiresIn: '7d' }
  );
}

portalApi.post('/login', async (req, res) => {
  try {
    const usernameRaw = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const envPwd = process.env.AAKRITI_ADMIN_PASSWORD;
    const envUser = (process.env.AAKRITI_ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const u = usernameRaw.toLowerCase();

    if (!password) {
      return res.status(400).json({ status: 'error', message: 'Password is required' });
    }

    if (envPwd && u === envUser && password === envPwd) {
      const token = signPortalToken({ role: 'admin', sub: 'env-admin', username: envUser });
      return res.json({
        status: 'success',
        data: { token, role: 'admin', username: envUser }
      });
    }

    const user = await AakritiPortalUser.findOne({ username: u, isActive: true });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    }

    const token = signPortalToken({
      role: user.role,
      sub: String(user._id),
      username: user.username,
      gender: user.gender || ''
    });
    return res.json({
      status: 'success',
      data: { token, role: user.role, username: user.username, gender: user.gender || '' }
    });
  } catch (error) {
    console.error('Aakriti portal login error:', error);
    res.status(500).json({ status: 'error', message: 'Login failed' });
  }
});

/**
 * Create admin/staff from the login page (no JWT). Requires the same master password as AAKRITI_ADMIN_PASSWORD.
 */
portalApi.post('/register', async (req, res) => {
  try {
    const envMaster = process.env.AAKRITI_ADMIN_PASSWORD;
    if (!envMaster) {
      return res.status(503).json({
        status: 'error',
        message:
          'Creating accounts from this page is disabled. Set AAKRITI_ADMIN_PASSWORD in the server environment, or ask an admin to add you from the dashboard.'
      });
    }
    const masterPassword = String(req.body?.masterPassword || '');
    if (masterPassword !== envMaster) {
      return res.status(403).json({ status: 'error', message: 'Invalid master password' });
    }

    const doc = await createPortalUserInDb(req.body);
    res.status(201).json({
      status: 'success',
      data: {
        user: {
          id: String(doc._id),
          username: doc.username,
          role: doc.role
        }
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ status: 'error', message: 'Username already exists' });
    }
    const code = error.statusCode || 500;
    if (code === 400) {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    console.error('Aakriti portal register error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create account' });
  }
});

portalApi.use(aakritiPortalAuth);

portalApi.get('/me', (req, res) => {
  res.json({
    status: 'success',
    data: {
      role: req.aakritiPortal.role,
      username: req.aakritiPortal.username || '',
      gender: req.aakritiPortal.gender || ''
    }
  });
});

portalApi.get('/users', requireAakritiPortalAdmin, async (req, res) => {
  try {
    const users = await AakritiPortalUser.find({ isActive: true })
      .select('username role gender createdAt')
      .sort({ username: 1 })
      .lean();
    res.json({
      status: 'success',
      data: {
        users: users.map((x) => ({
          id: String(x._id),
          username: x.username,
          role: x.role,
          gender: x.gender || '',
          createdAt: x.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('Aakriti portal list users error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to list users' });
  }
});

portalApi.post('/users', requireAakritiPortalAdmin, async (req, res) => {
  try {
    const role = String(req.body?.role || 'staff').trim().toLowerCase();
    if (role !== 'staff') {
      return res.status(403).json({
        status: 'error',
        message: 'Only staff accounts can be created from the portal'
      });
    }
    const doc = await createPortalUserInDb({ ...req.body, role: 'staff' });
    res.status(201).json({
      status: 'success',
      data: {
        user: {
          id: String(doc._id),
          username: doc.username,
          role: doc.role
        }
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ status: 'error', message: 'Username already exists' });
    }
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    console.error('Aakriti portal create user error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create user' });
  }
});

portalApi.delete('/users/:id', requireAakritiPortalAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (id === req.aakritiPortal.sub) {
      return res.status(400).json({ status: 'error', message: 'You cannot remove your own account' });
    }
    const doc = await AakritiPortalUser.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    res.json({ status: 'success' });
  } catch (error) {
    console.error('Aakriti portal delete user error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete user' });
  }
});

portalApi.get('/stylists', async (_req, res) => {
  try {
    const rows = await AakritiStylist.find({ isActive: true })
      .select('name gender mediaUrl mediaMimeType mediaKind createdAt')
      .sort({ gender: 1, name: 1 })
      .lean();
    res.json({
      status: 'success',
      data: {
        stylists: rows.map((x) => ({
          id: String(x._id),
          name: x.name,
          gender: x.gender,
          mediaUrl: x.mediaUrl || '',
          mediaMimeType: x.mediaMimeType || '',
          mediaKind: x.mediaKind || '',
          createdAt: x.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('Aakriti stylists list error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load stylists' });
  }
});

portalApi.post('/stylists', requireAakritiPortalAdmin, stylistUpload.single('media'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const gender = String(req.body?.gender || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ status: 'error', message: 'Name is required' });
    if (!['male', 'female'].includes(gender)) {
      return res.status(400).json({ status: 'error', message: 'Gender must be male or female' });
    }

    const nameKey = name.toLowerCase();
    const mediaUrl = req.file ? `/uploads/aakriti-stylists/${req.file.filename}` : '';
    const mediaMimeType = req.file ? String(req.file.mimetype || '').toLowerCase() : '';
    const mediaKind = mediaMimeType.startsWith('video/') ? 'video' : mediaMimeType ? 'image' : '';

    const doc = await AakritiStylist.create({
      name,
      nameKey,
      gender,
      mediaUrl,
      mediaMimeType,
      mediaKind
    });
    res.status(201).json({
      status: 'success',
      data: {
        stylist: {
          id: String(doc._id),
          name: doc.name,
          gender: doc.gender,
          mediaUrl: doc.mediaUrl || '',
          mediaMimeType: doc.mediaMimeType || '',
          mediaKind: doc.mediaKind || ''
        }
      }
    });
  } catch (error) {
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }
    if (error.code === 11000) {
      return res.status(400).json({ status: 'error', message: 'Stylist already exists for this gender' });
    }
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    console.error('Aakriti stylist create error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create stylist' });
  }
});

portalApi.delete('/stylists/:id', requireAakritiPortalAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const doc = await AakritiStylist.findOneAndDelete({ _id: id, isActive: true });
    if (!doc) return res.status(404).json({ status: 'error', message: 'Stylist not found' });
    if (doc.mediaUrl) {
      const filePath = path.join(__dirname, '../public', doc.mediaUrl.replace(/^\//, ''));
      fs.unlink(filePath, () => {});
    }
    res.json({ status: 'success' });
  } catch (error) {
    console.error('Aakriti stylist delete error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete stylist' });
  }
});

function monthBounds(year, month1to12) {
  const y = Number(year);
  const m = Number(month1to12);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    };
  }
  return {
    start: new Date(y, m - 1, 1, 0, 0, 0, 0),
    end: new Date(y, m, 0, 23, 59, 59, 999)
  };
}

function dayStartLocal(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function dayEndLocal(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function parseYmdToLocalStart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return new Date(y, mo - 1, d, 0, 0, 0, 0);
}

function stylistReportRange(period, from, to) {
  const now = new Date();
  if (period === 'day' || period === 'today') {
    return { start: dayStartLocal(now), end: dayEndLocal(now) };
  }
  if (period === 'week') {
    const dow = now.getDay();
    const delta = dow === 0 ? 6 : dow - 1; // week starts Monday
    const start = dayStartLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - delta));
    const end = dayEndLocal(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6));
    return { start, end };
  }
  if (period === 'month') {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    };
  }
  if (period === 'custom') {
    const s = parseYmdToLocalStart(from);
    const e0 = parseYmdToLocalStart(to);
    if (!s || !e0) return null;
    const e = dayEndLocal(e0);
    if (s.getTime() > e.getTime()) return null;
    return { start: s, end: e };
  }
  // default
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
  };
}

/**
 * Bookings in a calendar month: daily counts and totals by creator type.
 */
portalApi.get('/analytics/month', async (req, res) => {
  try {
    const year = parseInt(String(req.query.year || ''), 10);
    const month = parseInt(String(req.query.month || ''), 10);
    const { start, end } = monthBounds(year, month);

    const match = { createdAt: { $gte: start, $lte: end } };

    const [byDay, byType, totalArr] = await Promise.all([
      AakritiAppointment.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      AakritiAppointment.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$createdByType',
            count: { $sum: 1 }
          }
        }
      ]),
      AakritiAppointment.countDocuments(match)
    ]);

    const byTypeMap = { customer: 0, admin: 0, staff: 0 };
    byType.forEach((row) => {
      const k = row._id == null || row._id === '' ? 'customer' : row._id;
      if (byTypeMap[k] !== undefined) byTypeMap[k] = row.count;
    });

    res.json({
      status: 'success',
      data: {
        year: start.getFullYear(),
        month: start.getMonth() + 1,
        range: { start: start.toISOString(), end: end.toISOString() },
        total: totalArr,
        byDay: byDay.map((d) => ({ date: d._id, count: d.count })),
        byType: byTypeMap
      }
    });
  } catch (error) {
    console.error('Aakriti portal analytics/month error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load analytics' });
  }
});

/**
 * Stylist productivity report for completed work in a date range.
 * Query:
 *   period=day|week|month|custom
 *   from=YYYY-MM-DD (required when period=custom)
 *   to=YYYY-MM-DD   (required when period=custom)
 *   stylist=<name substring> (optional)
 */
portalApi.get('/reports/stylists', async (req, res) => {
  try {
    const period = String(req.query.period || 'month').trim().toLowerCase();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const stylistQ = String(req.query.stylist || '').trim().toLowerCase();
    const range = stylistReportRange(period, from, to);
    if (!range) {
      return res.status(400).json({ status: 'error', message: 'Invalid date range. Use from/to as YYYY-MM-DD.' });
    }

    const docs = await AakritiAppointment.find({
      status: 'finished',
      updatedAt: { $gte: range.start, $lte: range.end }
    })
      .select('name gender mobile staffName guests updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    const byStylist = new Map();
    docs.forEach((doc) => {
      const people = [
        { name: doc.name || '', gender: doc.gender || '', mobile: doc.mobile || '', staffName: doc.staffName || '' },
        ...((Array.isArray(doc.guests) ? doc.guests : []).map((g) => ({
          name: g.name || '',
          gender: g.gender || '',
          mobile: doc.mobile || '',
          staffName: g.staffName || ''
        })))
      ];
      people.forEach((p) => {
        const stylist = String(p.staffName || '').trim();
        if (!stylist) return;
        const stylistKey = stylist.toLowerCase();
        if (stylistQ && !stylistKey.includes(stylistQ)) return;
        if (!byStylist.has(stylistKey)) {
          byStylist.set(stylistKey, { stylistName: stylist, completedCount: 0, works: [] });
        }
        const entry = byStylist.get(stylistKey);
        entry.completedCount += 1;
        entry.works.push({
          customerName: p.name || 'Guest',
          customerGender: p.gender || '',
          mobile: p.mobile || '',
          completedAt: doc.updatedAt
        });
      });
    });

    const stylists = Array.from(byStylist.values())
      .map((x) => ({
        stylistName: x.stylistName,
        completedCount: x.completedCount,
        works: x.works.slice(0, 500)
      }))
      .sort((a, b) => (b.completedCount - a.completedCount) || a.stylistName.localeCompare(b.stylistName));

    res.json({
      status: 'success',
      data: {
        period,
        range: { start: range.start.toISOString(), end: range.end.toISOString() },
        totalStylists: stylists.length,
        totalCompletedTasks: stylists.reduce((sum, s) => sum + s.completedCount, 0),
        stylists
      }
    });
  } catch (error) {
    console.error('Aakriti stylist report error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load stylist report' });
  }
});

/**
 * Distinct customers by mobile with visit counts and last visit.
 * Query: search | q — case-insensitive substring match on latest name or mobile.
 */
portalApi.get('/customers', async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));
    const rawSearch = req.query.search ?? req.query.q;
    const search = Array.isArray(rawSearch) ? String(rawSearch[0] || '').trim() : String(rawSearch || '').trim();

    const pipeline = [
      {
        $group: {
          _id: '$mobile',
          name: { $last: '$name' },
          bookingCount: { $sum: 1 },
          lastVisit: { $max: '$createdAt' },
          firstVisit: { $min: '$createdAt' }
        }
      }
    ];

    if (search.length >= 1) {
      const esc = escapeRegex(search);
      pipeline.push({
        $match: {
          $or: [
            { _id: { $regex: esc, $options: 'i' } },
            { name: { $regex: esc, $options: 'i' } }
          ]
        }
      });
    }

    pipeline.push({ $sort: { lastVisit: -1 } });
    pipeline.push({ $limit: limit });

    const rows = await AakritiAppointment.aggregate(pipeline);

    res.json({
      status: 'success',
      data: {
        customers: rows.map((r) => ({
          mobile: r._id,
          name: r.name,
          bookingCount: r.bookingCount,
          lastVisit: r.lastVisit,
          firstVisit: r.firstVisit
        }))
      }
    });
  } catch (error) {
    console.error('Aakriti portal customers error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to list customers' });
  }
});

/**
 * Update the name on all appointments for a given mobile (admin only).
 */
portalApi.put('/customers/:mobile', requireAakritiPortalAdmin, async (req, res) => {
  try {
    const mobile = decodeURIComponent(String(req.params.mobile || '').trim());
    const name = String(req.body?.name || '').trim();
    if (!mobile) return res.status(400).json({ status: 'error', message: 'Mobile is required' });
    if (!name) return res.status(400).json({ status: 'error', message: 'Name is required' });
    const result = await AakritiAppointment.updateMany({ mobile }, { name });
    res.json({ status: 'success', data: { modifiedCount: result.modifiedCount } });
  } catch (error) {
    console.error('Aakriti update customer error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update customer' });
  }
});

/**
 * Delete all appointments for a given mobile (admin only).
 */
portalApi.delete('/customers/:mobile', requireAakritiPortalAdmin, async (req, res) => {
  try {
    const mobile = decodeURIComponent(String(req.params.mobile || '').trim());
    if (!mobile) return res.status(400).json({ status: 'error', message: 'Mobile is required' });
    const result = await AakritiAppointment.deleteMany({ mobile });
    res.json({ status: 'success', data: { deletedCount: result.deletedCount } });
  } catch (error) {
    console.error('Aakriti delete customer error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete customer' });
  }
});

const VALID_ADVANCE_LIMITS = new Set(['same_day', '1', '2', '3', '4', '5', '6', '7', 'any']);

portalApi.get('/settings', async (req, res) => {
  try {
    let s = await AakritiSettings.findOne({}).lean();
    if (!s) { s = (await AakritiSettings.create({})).toObject(); }
    res.json({
      status: 'success',
      data: {
        bookingClosed: !!s.bookingClosed,
        closedMessage: s.closedMessage || '',
        advanceBookingLimit: s.advanceBookingLimit || 'any'
      }
    });
  } catch (error) {
    console.error('Portal get-settings error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch settings' });
  }
});

portalApi.put('/settings', requireAakritiPortalAdmin, async (req, res) => {
  try {
    const { bookingClosed, closedMessage, advanceBookingLimit } = req.body || {};
    const update = {};
    if (typeof bookingClosed === 'boolean') update.bookingClosed = bookingClosed;
    if (typeof closedMessage === 'string') update.closedMessage = closedMessage.trim().slice(0, 300);
    if (advanceBookingLimit != null) {
      const v = String(advanceBookingLimit).trim();
      if (!VALID_ADVANCE_LIMITS.has(v)) {
        return res.status(400).json({ status: 'error', message: 'Invalid advanceBookingLimit value' });
      }
      update.advanceBookingLimit = v;
    }
    const s = await AakritiSettings.findOneAndUpdate(
      {},
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({
      status: 'success',
      data: {
        bookingClosed: !!s.bookingClosed,
        closedMessage: s.closedMessage || '',
        advanceBookingLimit: s.advanceBookingLimit || 'any'
      }
    });
  } catch (error) {
    console.error('Portal put-settings error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update settings' });
  }
});

portalApi.use(aakritiAppointmentHandlers);

router.use('/api/aakriti/portal', portalApi);

router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-login.html'));
});

router.get('/aakriti/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-login.html'));
});

router.get('/aakriti/dashboard/staff', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-staff.html'));
});

router.get('/aakriti/dashboard/stylists', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-stylists.html'));
});

router.get('/aakriti/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-dashboard.html'));
});

router.get('/aakriti/dashboard/today-bookings', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-dashboard.html'));
});

router.get('/aakriti/dashboard/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-analytics.html'));
});

router.get('/aakriti/dashboard/customers', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-customers.html'));
});

router.get('/aakriti/dashboard/reports', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/aakriti-portal-reports.html'));
});

module.exports = router;
