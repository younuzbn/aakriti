/**
 * Read-only export of Aakriti data from the OLD (shared Kochi One) MongoDB.
 *
 * Usage:
 *   OLD_MONGODB_URI="mongodb+srv://..." node scripts/export-aakriti-data.js
 *
 * It only READS. It finds every collection whose name starts with "aakriti"
 * (aakritiappointments, aakritistylists, aakritisettings, aakritiportalusers)
 * and writes them to ./migration-data/<collection>.json (Extended JSON, so
 * ObjectIds and Dates are preserved exactly).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const OUT_DIR = path.join(__dirname, '..', 'migration-data');

async function main() {
  const uri = process.env.OLD_MONGODB_URI;
  if (!uri) {
    console.error('Set OLD_MONGODB_URI to the old (shared) database connection string.');
    process.exit(1);
  }

  const conn = await mongoose.createConnection(uri).asPromise();
  console.log(`Connected to OLD database: ${conn.name}`);

  const all = await conn.db.listCollections().toArray();
  const names = all.map((c) => c.name).filter((n) => /^aakriti/i.test(n)).sort();
  if (!names.length) {
    console.error('No collections starting with "aakriti" found in this database.');
    await conn.close();
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const name of names) {
    const docs = await conn.db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), EJSON.stringify(docs, { relaxed: false }, 2));
    console.log(`  ${name}: ${docs.length} documents`);
  }

  await conn.close();
  console.log(`\nExport complete -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
