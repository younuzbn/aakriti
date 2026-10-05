const mongoose = require('mongoose');

const aakritiAppointmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    gender: { type: String, enum: ['male', 'female', ''], default: '' },
    mobile: { type: String, required: true, trim: true, maxlength: 20, index: true },
    peopleCount: { type: Number, required: true, min: 1, max: 20 },
    guests: {
      type: [{
        name: { type: String, trim: true, maxlength: 120, default: '' },
        gender: { type: String, enum: ['male', 'female', ''], default: '' },
        preferredStylistName: { type: String, trim: true, maxlength: 120, default: '' },
        staffName: { type: String, trim: true, maxlength: 80, default: '' }
      }],
      default: []
    },
    /** Staff member who served the primary person (empty = not yet served). */
    staffName: { type: String, trim: true, maxlength: 80, default: '' },
    /** Optional stylist preference chosen during booking. */
    preferredStylistName: { type: String, trim: true, maxlength: 120, default: '' },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    /** Optional calendar day the customer prefers (walk-in queue is still live / same day). */
    preferredDate: { type: Date, default: null },
    status: {
      type: String,
      enum: ['pending', 'finished', 'unreachable', 'no_show', 'cancelled'],
      default: 'pending',
      index: true
    },
    queuePosition: { type: Number, min: 0, index: true, default: 0 },
    sessionToken: { type: String, trim: true, index: true, default: '' },
    /** Who created the booking: customer site, portal staff, portal admin, or main admin panel. */
    createdByType: {
      type: String,
      enum: ['customer', 'admin', 'staff'],
      default: 'customer',
      index: true
    },
    createdByUsername: { type: String, trim: true, maxlength: 120, default: '' }
  },
  { timestamps: true }
);

aakritiAppointmentSchema.index({ status: 1, queuePosition: 1 });
aakritiAppointmentSchema.index({ mobile: 1, status: 1, createdAt: -1 });
aakritiAppointmentSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AakritiAppointment', aakritiAppointmentSchema);
