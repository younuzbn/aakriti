const express = require('express');
const AakritiAppointment = require('../models/AakritiAppointment');
const AakritiSettings = require('../models/AakritiSettings');
const AakritiStylist = require('../models/AakritiStylist');
const { broadcastQueue } = require('./aakritiRoutes');

const TERMINAL_STATUSES = new Set(['finished', 'unreachable', 'no_show', 'cancelled']);
const ALL_STATUSES = new Set(['pending', ...TERMINAL_STATUSES]);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstQuery(val) {
  if (val == null) return '';
  if (Array.isArray(val)) return String(val[0] ?? '').trim();
  return String(val).trim();
}

/** Accepts YYYY-MM-DD; returns UTC Date or null. Invalid / empty → null. */
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

function preferredDateToPayload(doc) {
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

function resolveCreatedBy(req) {
  if (req.aakritiPortal) {
    const role = req.aakritiPortal.role;
    return {
      createdByType: role === 'admin' ? 'admin' : 'staff',
      createdByUsername: String(req.aakritiPortal.username || '').trim()
    };
  }
  if (req.user && (req.user.email || req.user.name)) {
    const label = req.user.email || req.user.name || 'admin';
    return {
      createdByType: 'admin',
      createdByUsername: String(label).trim()
    };
  }
  return {
    createdByType: 'customer',
    createdByUsername: 'Online'
  };
}

function createdByDisplay(doc) {
  const type = doc.createdByType || 'customer';
  const username = String(doc.createdByUsername || '').trim();
  if (type === 'customer') {
    return username && username !== 'Online' ? username : 'Customer (online)';
  }
  const roleLabel = type === 'admin' ? 'Admin' : 'Staff';
  return username ? `${roleLabel}: ${username}` : roleLabel;
}

function queueChipLabel(doc) {
  if (doc.status === 'pending') {
    return doc.queuePosition === 0 ? 'next' : String(doc.queuePosition);
  }
  const map = {
    finished: 'completed',
    unreachable: 'unreachable',
    no_show: 'no-show',
    cancelled: 'cancelled'
  };
  return map[doc.status] || doc.status;
}

const toPayload = (doc) => ({
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
  preferredDate: preferredDateToPayload(doc),
  status: doc.status,
  queuePosition: doc.queuePosition,
  queueLabel: queueChipLabel(doc),
  createdByType: doc.createdByType || 'customer',
  createdByUsername: doc.createdByUsername != null && String(doc.createdByUsername).trim() !== '' ? String(doc.createdByUsername).trim() : '—',
  createdByDisplay: createdByDisplay(doc),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt
});

async function normalizeQueue() {
  const pending = await AakritiAppointment.find({ status: 'pending' }).sort({ queuePosition: 1, createdAt: 1 });
  const bucketPos = new Map();
  for (let i = 0; i < pending.length; i += 1) {
    const key = preferredDateToPayload(pending[i]) || 'none';
    const pos = bucketPos.has(key) ? bucketPos.get(key) : 0;
    bucketPos.set(key, pos + 1);
    if (pending[i].queuePosition !== pos) {
      pending[i].queuePosition = pos;
      await pending[i].save();
    }
  }
}

/**
 * Set booking status from any valid state to any other (e.g. correct a mistaken completion,
 * move between terminal outcomes, or return a closed booking to the queue).
 */
async function updateAppointmentStatus(appointmentId, nextStatus, app) {
  if (!ALL_STATUSES.has(nextStatus)) {
    const err = new Error('Invalid status');
    err.statusCode = 400;
    throw err;
  }
  const appointment = await AakritiAppointment.findById(appointmentId);
  if (!appointment) {
    const err = new Error('Appointment not found');
    err.statusCode = 404;
    throw err;
  }
  if (appointment.status === nextStatus) {
    return appointment;
  }

  if (nextStatus === 'pending') {
    const pendingCount = await AakritiAppointment.countDocuments({
      status: 'pending',
      ...pendingDateBucketFilter(appointment.preferredDate || null)
    });
    appointment.status = 'pending';
    appointment.queuePosition = pendingCount;
    await appointment.save();
    await normalizeQueue();
    const io = app.get('io');
    await broadcastQueue(io, { affectedBookingIds: [String(appointment._id)] });
    return appointment;
  }

  appointment.status = nextStatus;
  appointment.queuePosition = 0;
  await appointment.save();
  await normalizeQueue();
  const io = app.get('io');
  await broadcastQueue(io, { affectedBookingIds: [String(appointment._id)] });
  return appointment;
}

const router = express.Router();

/**
 * Compute gender-specific queue positions for a sorted list of pending docs,
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
    const dateKey = preferredDateToPayload(doc) || 'none';
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

/**
 * Annotate a payload with genderQueuePos + personQueuePositions.
 */
function withGenderPos(p, docId, gender, malePosMap, femalePosMap, personPosMap) {
  if (p.status !== 'pending') return p;
  const id = String(docId);
  if (gender === 'male') p.genderQueuePos = malePosMap.get(id) || null;
  else if (gender === 'female') p.genderQueuePos = femalePosMap.get(id) || null;
  p.personQueuePositions = personPosMap ? (personPosMap.get(id) || null) : null;
  return p;
}

router.get('/appointments', async (req, res) => {
  try {
    const filter = {};
    const portal = req.aakritiPortal;
    const canFilter = portal && ['admin', 'staff'].includes(portal.role);

    const preferredDateQ = firstQuery(req.query.preferredDate);
    if (preferredDateQ) {
      const day = parsePreferredDate(preferredDateQ);
      if (!day) {
        return res.status(400).json({ status: 'error', message: 'Invalid preferredDate query' });
      }
      const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
      filter.preferredDate = { $gte: day, $lt: nextDay };
    }
    if (canFilter) {
      const t = firstQuery(req.query.createdByType).toLowerCase();
      if (['customer', 'admin', 'staff'].includes(t)) {
        filter.createdByType = t;
      }
      const u = firstQuery(req.query.createdByUsername);
      if (u.length >= 1) {
        filter.createdByUsername = { $regex: escapeRegex(u), $options: 'i' };
      }
    }

    const appointments = await AakritiAppointment.find(filter)
      .sort({ status: 1, queuePosition: 1, createdAt: -1 })
      .lean();

    // For date-filtered views, queue position is local to the selected preferred day.
    if (preferredDateQ) {
      const pendingOnly = appointments
        .filter((a) => a.status === 'pending')
        .sort((a, b) => (a.queuePosition - b.queuePosition) || (new Date(a.createdAt) - new Date(b.createdAt)));
      const localPosById = new Map(pendingOnly.map((a, idx) => [String(a._id), idx]));
      const { malePosMap, femalePosMap, personPosMap } = computeGenderPositions(pendingOnly);
      const payload = appointments.map((doc) => {
        const p = toPayload(doc);
        if (p.status === 'pending' && localPosById.has(String(doc._id))) {
          const pos = localPosById.get(String(doc._id));
          p.queuePosition = pos;
          p.queueLabel = pos === 0 ? 'next' : String(pos);
        }
        withGenderPos(p, doc._id, doc.gender, malePosMap, femalePosMap, personPosMap);
        return p;
      });
      return res.json({ status: 'success', data: { appointments: payload } });
    }

    const pendingOnly = appointments
      .filter((a) => a.status === 'pending')
      .sort((a, b) => (a.queuePosition - b.queuePosition) || (new Date(a.createdAt) - new Date(b.createdAt)));
    const { malePosMap, femalePosMap, personPosMap } = computeGenderPositions(pendingOnly);
    const payload = appointments.map((doc) => {
      const p = toPayload(doc);
      withGenderPos(p, doc._id, doc.gender, malePosMap, femalePosMap, personPosMap);
      return p;
    });
    res.json({ status: 'success', data: { appointments: payload } });
  } catch (error) {
    console.error('List Aakriti appointments error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to list appointments' });
  }
});

router.post('/appointments', async (req, res) => {
  try {
    const { name, mobile, peopleCount, notes, preferredDate: prefIn, gender, guests, preferredStylistName: prefStylistIn } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanMobile = String(mobile || '').trim();
    const parsedPeople = Number(peopleCount);
    const pd = parsePreferredDate(prefIn);
    const cleanGender = ['male', 'female'].includes(gender) ? gender : '';
    const cleanPreferredStylistName = await normalizePreferredStylistName(prefStylistIn, cleanGender);
    const cleanGuests = await normalizeGuests(guests);

    if (!cleanName || !cleanMobile || !Number.isFinite(parsedPeople) || parsedPeople < 1) {
      return res.status(400).json({ status: 'error', message: 'Name, mobile and people count are required' });
    }

    const pendingCount = await AakritiAppointment.countDocuments({
      status: 'pending',
      ...pendingDateBucketFilter(pd)
    });
    const by = resolveCreatedBy(req);
    const appointment = await AakritiAppointment.create({
      name: cleanName,
      gender: cleanGender,
      mobile: cleanMobile,
      peopleCount: parsedPeople,
      guests: cleanGuests,
      preferredStylistName: cleanPreferredStylistName,
      notes: String(notes || '').trim(),
      preferredDate: pd,
      status: 'pending',
      queuePosition: pendingCount,
      createdByType: by.createdByType,
      createdByUsername: by.createdByUsername
    });

    const io = req.app.get('io');
    await broadcastQueue(io);

    res.status(201).json({ status: 'success', data: { appointment: toPayload(appointment) } });
  } catch (error) {
    if (error && error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error('Create Aakriti appointment error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create appointment' });
  }
});

router.put('/appointments/:id', async (req, res) => {
  try {
    const { name, mobile, peopleCount, notes, preferredDate: prefIn, gender, guests, preferredStylistName: prefStylistIn } = req.body || {};
    const update = {
      name: String(name || '').trim(),
      gender: ['male', 'female'].includes(gender) ? gender : '',
      mobile: String(mobile || '').trim(),
      peopleCount: Number(peopleCount),
      notes: String(notes || '').trim()
    };
    if (guests !== undefined) {
      update.guests = await normalizeGuests(guests);
    }
    if (prefStylistIn !== undefined) {
      update.preferredStylistName = await normalizePreferredStylistName(prefStylistIn, update.gender);
    }
    if (prefIn !== undefined) {
      update.preferredDate = parsePreferredDate(prefIn);
    }
    if (!update.name || !update.mobile || !Number.isFinite(update.peopleCount) || update.peopleCount < 1) {
      return res.status(400).json({ status: 'error', message: 'Invalid appointment details' });
    }

    const appointment = await AakritiAppointment.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!appointment) return res.status(404).json({ status: 'error', message: 'Appointment not found' });

    const io = req.app.get('io');
    await broadcastQueue(io, { affectedBookingIds: [String(req.params.id)] });

    res.json({ status: 'success', data: { appointment: toPayload(appointment) } });
  } catch (error) {
    if (error && error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error('Update Aakriti appointment error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update appointment' });
  }
});

router.delete('/appointments/:id', async (req, res) => {
  try {
    if (req.aakritiPortal && req.aakritiPortal.role === 'staff') {
      return res.status(403).json({ status: 'error', message: 'Staff accounts cannot delete bookings' });
    }
    const appointment = await AakritiAppointment.findByIdAndDelete(req.params.id);
    if (!appointment) return res.status(404).json({ status: 'error', message: 'Appointment not found' });

    await normalizeQueue();
    const io = req.app.get('io');
    await broadcastQueue(io, { affectedBookingIds: [String(appointment._id)] });

    res.json({ status: 'success' });
  } catch (error) {
    console.error('Delete Aakriti appointment error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete appointment' });
  }
});

router.post('/appointments/:id/finish', async (req, res) => {
  try {
    const appointment = await updateAppointmentStatus(req.params.id, 'finished', req.app);
    res.json({ status: 'success', data: { appointment: toPayload(appointment) } });
  } catch (error) {
    const code = error.statusCode || 500;
    if (code >= 500) console.error('Finish Aakriti appointment error:', error);
    res.status(code).json({ status: 'error', message: error.message || 'Failed to finish appointment' });
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
    console.error('Aakriti staff-members error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load staff members' });
  }
});

/**
 * Mark an individual person in a booking as served by a specific staff member.
 * personIndex 0 = primary person, 1+ = guests[personIndex - 1].
 * When all persons in the booking have a staffName, the whole appointment
 * is automatically moved to 'finished'.
 */
router.post('/appointments/:id/person-complete', async (req, res) => {
  try {
    const personIndex = Number(req.body?.personIndex ?? 0);
    const staffName = String(req.body?.staffName || '').trim();
    if (!staffName) {
      return res.status(400).json({ status: 'error', message: 'Staff name is required' });
    }
    const appointment = await AakritiAppointment.findById(req.params.id);
    if (!appointment) {
      return res.status(404).json({ status: 'error', message: 'Appointment not found' });
    }

    if (personIndex === 0) {
      appointment.staffName = staffName;
    } else {
      const guestIdx = personIndex - 1;
      if (!appointment.guests[guestIdx]) {
        return res.status(400).json({ status: 'error', message: 'Invalid person index' });
      }
      appointment.guests[guestIdx].staffName = staffName;
    }

    // Auto-finish when every person has been assigned a staff member
    const primaryDone = Boolean(appointment.staffName);
    const guestsDone = appointment.guests.every(g => Boolean(g.staffName));
    if (primaryDone && guestsDone && appointment.status === 'pending') {
      appointment.status = 'finished';
      appointment.queuePosition = 0;
      await appointment.save();
      await normalizeQueue();
    } else {
      await appointment.save();
    }

    const io = req.app.get('io');
    await broadcastQueue(io, { affectedBookingIds: [String(appointment._id)] });

    res.json({ status: 'success', data: { appointment: toPayload(appointment) } });
  } catch (error) {
    console.error('Person complete error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to complete person' });
  }
});

router.post('/appointments/:id/resolve', async (req, res) => {
  try {
    const nextStatus = String(req.body?.status || '').trim();
    const appointment = await updateAppointmentStatus(req.params.id, nextStatus, req.app);
    res.json({ status: 'success', data: { appointment: toPayload(appointment) } });
  } catch (error) {
    const code = error.statusCode || 500;
    if (code >= 500) console.error('Resolve Aakriti appointment error:', error);
    res.status(code).json({ status: 'error', message: error.message || 'Failed to update appointment' });
  }
});

const VALID_ADVANCE_LIMITS = new Set(['same_day', '1', '2', '3', '4', '5', '6', '7', 'any']);

router.get('/settings', async (req, res) => {
  try {
    let s = await AakritiSettings.findOne({}).lean();
    if (!s) {
      s = await AakritiSettings.create({});
      s = s.toObject();
    }
    res.json({
      status: 'success',
      data: {
        bookingClosed: !!s.bookingClosed,
        closedMessage: s.closedMessage || '',
        advanceBookingLimit: s.advanceBookingLimit || 'any'
      }
    });
  } catch (error) {
    console.error('Aakriti admin get-settings error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch settings' });
  }
});

router.put('/settings', async (req, res) => {
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
    console.error('Aakriti admin put-settings error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update settings' });
  }
});

module.exports = router;
