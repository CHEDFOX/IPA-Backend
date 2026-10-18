// Adds sample listings for local development. Not for production data.
//
//   npm run seed                      # sample listings with generated placeholder photos
//   npm run seed -- --photos ./pics   # use your own JPEG/PNG files (3 per listing, in name order)
//
// Listings whose web address already exists are skipped, so it is safe to run twice.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMediaStore, detectFfmpeg } from '../src/media.js';
import { createPropertyRepo } from '../src/properties.js';
import { slugify } from '../src/util.js';

const SAMPLES = [
  {
    title: 'Hilltop Acreage',
    type: 'land',
    location: 'East Hills',
    area: 6.1,
    areaUnit: 'ha',
    price: null,
    featured: true,
    summary: 'Open hilltop land with long views, road access on two sides',
    details: [
      { label: 'Zoning', value: 'Agricultural', key: true },
      { label: 'Title', value: 'Freehold', key: true },
      { label: 'Road access', value: 'Gravel road on two sides', key: true },
      { label: 'Terrain', value: 'Rolling, south-facing', key: false },
    ],
  },
  {
    title: 'White Villa, Palm Road',
    type: 'residential',
    status: 'under_offer',
    location: 'Palm District',
    area: 420,
    areaUnit: 'm2',
    bedrooms: 5,
    bathrooms: 6,
    price: 640000,
    featured: true,
    summary: 'Five-bedroom villa with pool and garden on a quiet street',
    details: [
      { label: 'Plot area', value: '900 m²', key: true },
      { label: 'Parking', value: '2 covered spaces', key: false },
    ],
  },
  {
    title: 'Development Site, Ring Road',
    type: 'commercial',
    location: 'Ring Road',
    area: 1.2,
    areaUnit: 'ha',
    price: 1150000,
    featured: true,
    summary: 'Corner site on the ring road, approved for mixed use',
    details: [
      { label: 'Zoning', value: 'Mixed use', key: true },
      { label: 'Frontage', value: '160 m on Ring Road', key: true },
    ],
  },
  {
    title: 'Cedar House',
    type: 'residential',
    location: 'Old Town',
    area: 310,
    areaUnit: 'm2',
    bedrooms: 4,
    bathrooms: 3,
    price: 475000,
    summary: 'Timber-clad family house with a large garden',
    details: [{ label: 'Year built', value: '2019', key: true }],
  },
  {
    title: 'Office Floor, Level 7',
    type: 'commercial',
    location: 'City Centre',
    area: 860,
    areaUnit: 'm2',
    price: null,
    summary: 'Open-plan office floor with city views, ready to fit out',
    details: [{ label: 'Parking', value: '12 spaces', key: true }],
  },
  {
    title: 'West Farm with Barn',
    type: 'land',
    status: 'sold',
    location: 'West Farms',
    area: 14,
    areaUnit: 'ha',
    price: 390000,
    summary: 'Working farmland with a barn and well',
    details: [{ label: 'Water', value: 'Private well', key: true }],
  },
];

const PLACEHOLDER_COLORS = ['#5f7d5a', '#8a7a5c', '#4f6a78', '#7a6250', '#62705a', '#6f6a5e'];

async function placeholder(file, label, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">
    <rect width="100%" height="100%" fill="${color}"/>
    <text x="50%" y="50%" fill="#ffffff" fill-opacity="0.85" font-family="sans-serif" font-size="56" text-anchor="middle">${label}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(file);
}

const args = process.argv.slice(2);
const photosDir = args.includes('--photos') ? path.resolve(args[args.indexOf('--photos') + 1]) : null;
const photos = photosDir
  ? fs
      .readdirSync(photosDir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .map((f) => path.join(photosDir, f))
  : [];
if (photosDir && !photos.length) {
  console.error(`No JPEG, PNG or WebP files found in ${photosDir}`);
  process.exit(1);
}

const config = loadConfig();
const db = openDb(config.dataDir);
const media = createMediaStore({ dataDir: config.dataDir, keepOriginals: false, ffmpeg: await detectFfmpeg() });
const repo = createPropertyRepo(db);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-seed-'));
const insertMedia = db.prepare(
  `INSERT INTO media (property_id, role, kind, key, original_name, mime, bytes, width, height, file, original, variants, sort_order)
   VALUES (@property_id, 'gallery', @kind, @key, @original_name, @mime, @bytes, @width, @height, @file, @original, @variants, @sort_order)`,
);

let photoIndex = 0;
let added = 0;
for (const [n, sample] of SAMPLES.entries()) {
  if (repo.getBySlug(slugify(sample.title))) {
    console.log(`skip  ${sample.title} (already exists)`);
    continue;
  }
  const row = repo.create({ ...sample, visibility: 'public', sortOrder: n });
  for (let i = 0; i < 3; i++) {
    // copy, because processUpload moves or deletes the file it is given
    const tmpFile = path.join(tmp, `${n}-${i}.jpg`);
    if (photos.length) fs.copyFileSync(photos[photoIndex++ % photos.length], tmpFile);
    else await placeholder(tmpFile, `${sample.title} · sample ${i + 1}`, PLACEHOLDER_COLORS[(n + i) % PLACEHOLDER_COLORS.length]);
    const result = await media.processUpload({ path: tmpFile, originalname: path.basename(tmpFile), mimetype: 'image/jpeg' }, 'gallery');
    insertMedia.run({
      property_id: row.id,
      kind: result.kind,
      key: result.key,
      original_name: path.basename(tmpFile),
      mime: result.mime,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      file: result.file,
      original: result.original,
      variants: JSON.stringify(result.variants),
      sort_order: i,
    });
  }
  added += 1;
  console.log(`added ${sample.title}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
db.close();
console.log(`Done: ${added} sample listing${added === 1 ? '' : 's'} added.`);
