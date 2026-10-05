const mongoose = require('mongoose');

const aakritiSettingsSchema = new mongoose.Schema(
  {
    bookingClosed: { type: Boolean, default: false },
    closedMessage: { type: String, default: '', trim: true, maxlength: 300 },
    advanceBookingLimit: {
      type: String,
      enum: ['same_day', '1', '2', '3', '4', '5', '6', '7', 'any'],
      default: 'any'
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AakritiSettings', aakritiSettingsSchema);
