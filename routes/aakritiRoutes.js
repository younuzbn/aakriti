const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const AakritiAppointment = require('../models/AakritiAppointment');
const AakritiSettings = require('../models/AakritiSettings');
const AakritiStylist = require('../models/AakritiStylist');

function queueLabelForDoc(doc) {
  if (doc.status === 'pending') {
    return doc.queuePosition === 0 ? 'next' : String(doc.queuePosition);
  }
  const labels = {
    finished: 'completed',
    unreachable: 'unreachable',
    no_show: 'no-show',
    cancelled: 'cancelled'
  };
  return labels[doc.status] || doc.status;
}

function parsePreferredDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function preferredDateToApi(doc) {
  if (!doc || !doc.preferredDate) return null;
  try {
    return new Date(doc.preferredDate).toISOString().slice(0, 10);
  } catch (e) {
    return null;
  }
}

function pendingDateBucketFilter(preferredDate) {
  if (!preferredDate) return { preferredDate: null };
  const start = new Date(preferredDate);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { preferredDate: { $gte: start, $lt: end } };
}

function createdByDisplayPublic(doc) {
  const type = doc.createdByType || 'customer';
  const username = String(doc.createdByUsername || '').trim();
  if (type === 'customer') {
    return username && username !== 'Online' ? username : 'Customer (online)';
  }
  const roleLabel = type === 'admin' ? 'Admin' : 'Staff';
  return username ? `${roleLabel}: ${username}` : roleLabel;
}

const formatAppointment = (doc, genderQueuePos, personQueuePositions) => ({
  id: String(doc._id),
  name: doc.name,
  gender: doc.gender || '',
  staffName: doc.staffName || '',
  preferredStylistName: doc.preferredStylistName || '',
  mobile: doc.mobile,
  peopleCount: doc.peopleCount,
  guests: Array.isArray(doc.guests)
    ? doc.guests.map((g) => ({
        name: g.name || '',
        gender: g.gender || '',
        preferredStylistName: g.preferredStylistName || '',
        staffName: g.staffName || ''
      }))
    : [],
  notes: doc.notes || '',
  preferredDate: preferredDateToApi(doc),
  status: doc.status,
  queuePosition: doc.queuePosition,
  queueLabel: queueLabelForDoc(doc),
  genderQueuePos: genderQueuePos != null ? genderQueuePos : null,
  personQueuePositions: Array.isArray(personQueuePositions) ? personQueuePositions : null,
  createdByType: doc.createdByType || 'customer',
  createdByUsername: doc.createdByUsername != null && String(doc.createdByUsername).trim() !== '' ? String(doc.createdByUsername).trim() : '—',
  createdByDisplay: createdByDisplayPublic(doc),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt
});

/**
 * Given a sorted list of pending docs, compute per-gender 1-based positions
 * counting every individual person (primary + guests) across all bookings.
 * Returns:
 *   malePosMap   – booking id → primary person's gents position
 *   femalePosMap – booking id → primary person's ladies position
 *   personPosMap – booking id → [{name, gender, pos}] for every person in the booking
 */
function computeGenderPositions(sortedPending) {
  const malePosMap = new Map();
  const femalePosMap = new Map();
  const personPosMap = new Map();
  const maleCountByDate = new Map();
  const femaleCountByDate = new Map();

  sortedPending.forEach((doc) => {
    const id = String(doc._id);
    const dateKey = preferredDateToApi(doc) || 'none';
    let maleCount = maleCountByDate.get(dateKey) || 0;
    let femaleCount = femaleCountByDate.get(dateKey) || 0;

    const guests = Array.isArray(doc.guests) ? doc.guests : [];
    const allPersons = [
      { name: doc.name || '', gender: doc.gender || '' },
      ...guests.map(g => ({ name: g.name || '', gender: g.gender || '' }))
    ];
    const positions = allPersons.map(p => {
      let pos = null;
      if (p.gender === 'male') {
        maleCount++;
        pos = maleCount;
      } else if (p.gender === 'female') {
        femaleCount++;
        pos = femaleCount;
      }
      return { name: p.name, gender: p.gender, pos };
    });

    maleCountByDate.set(dateKey, maleCount);
    femaleCountByDate.set(dateKey, femaleCount);

    personPosMap.set(id, positions);
    if (doc.gender === 'male') malePosMap.set(id, positions[0].pos);
    else if (doc.gender === 'female') femalePosMap.set(id, positions[0].pos);
  });
  return { malePosMap, femalePosMap, personPosMap };
}

function genderQueuePosFor(doc, malePosMap, femalePosMap) {
  if (doc.status !== 'pending') return null;
  if (doc.gender === 'male') return malePosMap.get(String(doc._id)) || null;
  if (doc.gender === 'female') return femalePosMap.get(String(doc._id)) || null;
  return null;
}

async function getSettings() {
  let s = await AakritiSettings.findOne({}).lean();
  if (!s) {
    s = await AakritiSettings.create({});
    s = s.toObject();
  }
  return s;
}

function todayUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function normalizePreferredStylistName(rawName, gender) {
  const clean = String(rawName || '').trim();
  if (!clean) return '';
  if (!['male', 'female'].includes(gender)) return '';
  const stylist = await AakritiStylist.findOne({
    nameKey: clean.toLowerCase(),
    gender,
    isActive: true
  }).select({ name: 1 }).lean();
  if (!stylist) {
    const err = new Error('Selected stylist is unavailable for the chosen gender.');
    err.statusCode = 400;
    throw err;
  }
  return stylist.name;
}

async function normalizeGuests(guests) {
  if (!Array.isArray(guests)) return [];
  const out = [];
  for (const g of guests.slice(0, 19)) {
    const gender = ['male', 'female'].includes(g.gender) ? g.gender : '';
    out.push({
      name: String(g.name || '').trim().slice(0, 120),
      gender,
      preferredStylistName: await normalizePreferredStylistName(g.preferredStylistName, gender)
    });
  }
  return out;
}

function validateAdvanceBookingLimit(pd, limit) {
  if (!pd) return null;
  const today = todayUtcMidnight();
  const pdTime = pd.getTime();
  if (pdTime < today.getTime()) return 'Preferred date cannot be in the past.';
  if (limit === 'same_day') {
    if (pdTime !== today.getTime()) return 'Bookings are only available for today.';
  } else if (limit !== 'any') {
    const days = parseInt(limit, 10);
    if (Number.isFinite(days) && days >= 0) {
      const maxDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
      if (pdTime > maxDate.getTime()) {
        return `Bookings can only be made up to ${days} day${days !== 1 ? 's' : ''} in advance.`;
      }
    }
  }
  return null;
}

async function normalizePendingQueue() {
  const pending = await AakritiAppointment.find({ status: 'pending' }).sort({ queuePosition: 1, createdAt: 1 });
  const bucketPos = new Map();
  for (let i = 0; i < pending.length; i += 1) {
    const key = preferredDateToApi(pending[i]) || 'none';
    const pos = bucketPos.has(key) ? bucketPos.get(key) : 0;
    bucketPos.set(key, pos + 1);
    if (pending[i].queuePosition !== pos) {
      pending[i].queuePosition = pos;
      await pending[i].save();
    }
  }
}

async function broadcastQueue(io, options = {}) {
  if (!io) return;
  const pending = await AakritiAppointment.find({ status: 'pending' })
    .sort({ queuePosition: 1, createdAt: 1 })
    .lean();
  const { malePosMap, femalePosMap, personPosMap } = computeGenderPositions(pending);
  pending.forEach((appointment) => {
    const id = String(appointment._id);
    const gQueuePos = genderQueuePosFor(appointment, malePosMap, femalePosMap);
    io.to(`aakriti:booking:${id}`).emit('aakriti_queue_update', {
      appointmentId: id,
      queuePosition: appointment.queuePosition,
      queueLabel: queueLabelForDoc(appointment),
      genderQueuePos: gQueuePos,
      personQueuePositions: personPosMap.get(id) || null,
      status: appointment.status,
      preferredDate: preferredDateToApi(appointment)
    });
  });

  const rawIds = Array.isArray(options.affectedBookingIds) ? options.affectedBookingIds : [];
  const extraIds = [...new Set(rawIds.map((x) => String(x || '').trim()).filter(Boolean))];
  for (const id of extraIds) {
    const stillPending = pending.some((p) => String(p._id) === id);
    if (stillPending) continue;
    const doc = await AakritiAppointment.findById(id).lean();
    if (doc) {
      io.to(`aakriti:booking:${id}`).emit('aakriti_queue_update', {
        appointmentId: id,
        queuePosition: doc.queuePosition,
        queueLabel: queueLabelForDoc(doc),
        status: doc.status,
        preferredDate: preferredDateToApi(doc)
      });
    } else {
      io.to(`aakriti:booking:${id}`).emit('aakriti_queue_update', {
        appointmentId: id,
        removed: true
      });
    }
  }

  io.to('aakriti:watch').emit('aakriti_changed', { at: Date.now() });
}

router.get('/settings', async (req, res) => {
  try {
    const s = await getSettings();
    res.json({
      status: 'success',
      data: {
        bookingClosed: !!s.bookingClosed,
        closedMessage: s.closedMessage || '',
        advanceBookingLimit: s.advanceBookingLimit || 'any'
      }
    });
  } catch (error) {
    console.error('Aakriti settings error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch settings' });
  }
});

router.get('/queue', async (req, res) => {
  try {
    const pending = await AakritiAppointment.find({ status: 'pending' })
      .sort({ queuePosition: 1, createdAt: 1 })
      .select({ name: 1, queuePosition: 1, createdAt: 1 })
      .lean();

    res.json({
      status: 'success',
      data: {
        queue: pending.map((item) => ({
          id: String(item._id),
          name: item.name,
          queuePosition: item.queuePosition,
          queueLabel: item.queuePosition === 0 ? 'next' : String(item.queuePosition),
          createdAt: item.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('Aakriti queue error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch queue' });
  }
});

router.get('/staff-members', async (req, res) => {
  try {
    const gender = String(req.query.gender || '').trim().toLowerCase();
    const filter = { isActive: true };
    if (gender === 'male' || gender === 'female') filter.gender = gender;
    const rows = await AakritiStylist.find(filter)
      .select('name gender mediaUrl mediaMimeType mediaKind')
      .sort({ name: 1 })
      .lean();
    res.json({
      status: 'success',
      data: {
        staff: rows.map((x) => ({
          id: String(x._id),
          name: x.name,
          gender: x.gender,
          mediaUrl: x.mediaUrl || '',
          mediaMimeType: x.mediaMimeType || '',
          mediaKind: x.mediaKind || ''
        }))
      }
    });
  } catch (error) {
    console.error('Aakriti public staff-members error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load staff members' });
  }
});

router.get('/lookup', async (req, res) => {
  try {
    const cleanMobile = String(req.query.mobile || '').trim();
    if (!cleanMobile || cleanMobile.length < 10) {
      return res.status(400).json({ status: 'error', message: 'Mobile number is required' });
    }

    const doc = await AakritiAppointment.findOne({ mobile: cleanMobile })
      .sort({ createdAt: -1 })
      .select({ name: 1 })
      .lean();

    res.json({
      status: 'success',
      data: { name: doc && doc.name ? String(doc.name).trim() : '' }
    });
  } catch (error) {
    console.error('Aakriti lookup error:', error);
    res.status(500).json({ status: 'error', message: 'Lookup failed' });
  }
});

router.post('/book', async (req, res) => {
  try {
    const { name, mobile, peopleCount, notes, preferredDate: prefIn, gender, guests, preferredStylistName: prefStylistIn } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanMobile = String(mobile || '').trim();
    const parsedPeople = Number(peopleCount);
    const cleanNotes = String(notes || '').trim();
    const pd = parsePreferredDate(prefIn);
    const cleanGender = ['male', 'female'].includes(gender) ? gender : '';
    const cleanPreferredStylistName = await normalizePreferredStylistName(prefStylistIn, cleanGender);
    const cleanGuests = await normalizeGuests(guests);

    if (!cleanName || !cleanMobile || !Number.isFinite(parsedPeople) || parsedPeople < 1) {
      return res.status(400).json({ status: 'error', message: 'Name, mobile and people count are required' });
    }

    const settings = await getSettings();
    if (settings.bookingClosed) {
      const msg = settings.closedMessage && settings.closedMessage.trim()
        ? settings.closedMessage.trim()
        : 'Bookings are temporarily closed. Please check back later.';
      return res.status(403).json({ status: 'error', message: msg });
    }
    const limitError = validateAdvanceBookingLimit(pd, settings.advanceBookingLimit || 'any');
    if (limitError) {
      return res.status(400).json({ status: 'error', message: limitError });
    }

    const pendingCount = await AakritiAppointment.countDocuments({
      status: 'pending',
      ...pendingDateBucketFilter(pd)
    });
    const token = crypto.randomBytes(24).toString('hex');
    const appointment = await AakritiAppointment.create({
      name: cleanName,
      gender: cleanGender,
      mobile: cleanMobile,
      peopleCount: parsedPeople,
      guests: cleanGuests,
      preferredStylistName: cleanPreferredStylistName,
      notes: cleanNotes,
      preferredDate: pd,
      status: 'pending',
      queuePosition: pendingCount,
      sessionToken: token,
      createdByType: 'customer',
      createdByUsername: 'Online'
    });

    const io = req.app.get('io');
    await broadcastQueue(io);

    // Compute gender queue positions for all persons in the newly created booking
    const allPending = await AakritiAppointment.find({ status: 'pending' })
      .sort({ queuePosition: 1, createdAt: 1 })
      .lean();
    const { malePosMap, femalePosMap, personPosMap } = computeGenderPositions(allPending);
    const newId = String(appointment._id);
    const gQueuePos = genderQueuePosFor(appointment, malePosMap, femalePosMap);
    const personPositions = personPosMap.get(newId) || null;

    res.status(201).json({
      status: 'success',
      data: {
        token,
        appointment: formatAppointment(appointment, gQueuePos, personPositions)
      }
    });
  } catch (error) {
    if (error && error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error('Aakriti booking error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create booking' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const cleanMobile = String(req.body?.mobile || '').trim();
    if (!cleanMobile) {
      return res.status(400).json({ status: 'error', message: 'Mobile number is required' });
    }

    let appointment = await AakritiAppointment.findOne({ mobile: cleanMobile, status: 'pending' })
      .sort({ queuePosition: 1, createdAt: 1 });
    if (!appointment) {
      appointment = await AakritiAppointment.findOne({ mobile: cleanMobile }).sort({ createdAt: -1 });
    }
    if (!appointment) {
      return res.status(404).json({ status: 'error', message: 'No booking found for this mobile number' });
    }

    if (!appointment.sessionToken) {
      appointment.sessionToken = crypto.randomBytes(24).toString('hex');
      await appointment.save();
    }

    res.json({
      status: 'success',
      data: {
        token: appointment.sessionToken,
        appointment: formatAppointment(appointment)
      }
    });
  } catch (error) {
    console.error('Aakriti login error:', error);
    res.status(500).json({ status: 'error', message: 'Login failed' });
  }
});

router.get('/my-booking', async (req, res) => {
  try {
    const token = String(req.headers['x-aakriti-token'] || req.query.token || '').trim();
    if (!token) {
      return res.status(401).json({ status: 'error', message: 'Token is required' });
    }

    const appointment = await AakritiAppointment.findOne({ sessionToken: token }).lean();
    if (!appointment) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    let gQueuePos = null;
    let personPositions = null;
    if (appointment.status === 'pending') {
      const allPending = await AakritiAppointment.find({ status: 'pending' })
        .sort({ queuePosition: 1, createdAt: 1 })
        .lean();
      const { malePosMap, femalePosMap, personPosMap } = computeGenderPositions(allPending);
      const id = String(appointment._id);
      gQueuePos = genderQueuePosFor(appointment, malePosMap, femalePosMap);
      personPositions = personPosMap.get(id) || null;
    }

    res.json({ status: 'success', data: { appointment: formatAppointment(appointment, gQueuePos, personPositions) } });
  } catch (error) {
    console.error('Aakriti my-booking error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch booking' });
  }
});

router.post('/cancel', async (req, res) => {
  try {
    const token = String(req.headers['x-aakriti-token'] || req.body?.token || '').trim();
    if (!token) {
      return res.status(401).json({ status: 'error', message: 'Token is required' });
    }

    const appointment = await AakritiAppointment.findOne({ sessionToken: token });
    if (!appointment) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }
    if (appointment.status !== 'pending') {
      return res.status(400).json({ status: 'error', message: 'Only active queue bookings can be cancelled' });
    }

    appointment.status = 'cancelled';
    appointment.queuePosition = 0;
    await appointment.save();
    await normalizePendingQueue();

    const io = req.app.get('io');
    await broadcastQueue(io, { affectedBookingIds: [String(appointment._id)] });

    res.json({ status: 'success', data: { appointment: formatAppointment(appointment) } });
  } catch (error) {
    console.error('Aakriti cancel error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to cancel booking' });
  }
});

module.exports = { router, broadcastQueue };
