const mongoose = require('mongoose');

const AakritiStylistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameKey: { type: String, required: true, lowercase: true, trim: true },
    gender: { type: String, enum: ['male', 'female'], required: true },
    mediaUrl: { type: String, default: '' },
    mediaMimeType: { type: String, default: '' },
    mediaKind: { type: String, enum: ['image', 'video', ''], default: '' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

AakritiStylistSchema.index({ gender: 1, nameKey: 1 }, { unique: true });
AakritiStylistSchema.index({ isActive: 1, gender: 1, name: 1 });

module.exports = mongoose.model('AakritiStylist', AakritiStylistSchema);
