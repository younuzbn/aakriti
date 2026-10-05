/**
 * Import the files produced by export-aakriti-data.js into the NEW Aakriti database.
 *
 * Usage:
 *   node scripts/import-aakriti-data.js            # uses MONGODB_URI from .env
 *   node scripts/import-aakriti-data.js --replace  # wipe those collections first, then import
 *
 * Without --replace, documents are upserted by _id (safe to re-run: it adds new
 * documents and updates changed ones, never deletes). Original _id values are
 * kept, so booking tokens/ids that customers already hold keep working.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const IN_DIR = path.join(__dirname, '..', 'migration-data');
const REPLACE = process.argv.includes('--replace');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI (the NEW database) is not set in .env');
    process.exit(1);
  }
  if (process.env.OLD_MONGODB_URI && process.env.OLD_MONGODB_URI === uri) {
    console.error('MONGODB_URI equals OLD_MONGODB_URI. Refusing to import into the source database.');
    process.exit(1);
  }
  if (!fs.existsSync(IN_DIR)) {
    console.error(`No ${IN_DIR} folder. Run the export script first.`);
    process.exit(1);
  }

  const files = fs.readdirSync(IN_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    console.error('No .json files to import.');
    process.exit(1);
  }

  const conn = await mongoose.createConnection(uri).asPromise();
  console.log(`Connected to NEW database: ${conn.name}`);

  for (const file of files) {
    const name = path.basename(file, '.json');
    const docs = EJSON.parse(fs.readFileSync(path.join(IN_DIR, file), 'utf8'), { relaxed: false });
    const col = conn.db.collection(name);

    if (REPLACE) {
      await col.deleteMany({});
    }
    if (docs.length) {
      const ops = docs.map((d) => ({
        replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true }
      }));
      await col.bulkWrite(ops, { ordered: false });
    }
    const count = await col.countDocuments();
    console.log(`  ${name}: imported ${docs.length}, collection now has ${count}`);
  }

  await conn.close();
  console.log('\nImport complete. Start the server once so Mongoose builds the indexes.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
