import { createApp } from './app.js';
import { assertConfig, loadConfig } from './config.js';
import { openDb } from './db.js';
import { createMediaStore, detectFfmpeg } from './media.js';
import { createNotifier } from './notify.js';

const config = loadConfig();
try {
  assertConfig(config);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = openDb(config.dataDir);
const ffmpeg = await detectFfmpeg();
const media = createMediaStore({ dataDir: config.dataDir, keepOriginals: config.keepOriginals, ffmpeg });
const notifier = createNotifier(config);
const app = createApp({ config, db, media, notifier });

const server = app.listen(config.port, config.host, () => {
  console.log(`IPA backend listening on http://${config.host}:${config.port}`);
  console.log(`Admin panel: ${config.publicUrl}/admin/`);
  if (!ffmpeg) console.warn('ffmpeg not found: videos are stored as uploaded, without poster images.');
});
// Large video uploads over slow connections can take a while.
server.requestTimeout = 60 * 60 * 1000;

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
