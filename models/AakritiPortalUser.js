const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const aakritiPortalUserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 64,
      match: [/^[a-z0-9._-]+$/, 'Username may only contain letters, numbers, dot, hyphen, underscore']
    },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'staff'], required: true, index: true },
    gender: { type: String, enum: ['male', 'female', ''], default: '' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

aakritiPortalUserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

module.exports = mongoose.model('AakritiPortalUser', aakritiPortalUserSchema);
