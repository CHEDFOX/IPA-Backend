import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { HttpError } from './util.js';

const run = promisify(execFile);

// Longest edge of each web copy. The originals are never served.
const IMAGE_SIZES = { sm: 640, md: 1280, lg: 2048 };
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif', 'heif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm']);

export async function detectFfmpeg() {
  try {
    await run('ffmpeg', ['-version'], { timeout: 5000 });
    await run('ffprobe', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function move(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

export function isVideoUpload(upload) {
  return (
    upload.mimetype?.startsWith('video/') ||
    VIDEO_EXTENSIONS.has(path.extname(upload.originalname || '').toLowerCase())
  );
}

export function createMediaStore({ dataDir, keepOriginals = true, ffmpeg = false }) {
  const mediaDir = path.join(dataDir, 'media');
  const originalsDir = path.join(dataDir, 'originals');
  const tmpDir = path.join(dataDir, 'tmp');
  for (const dir of [mediaDir, originalsDir, tmpDir]) fs.mkdirSync(dir, { recursive: true });

  const newKey = () => crypto.randomBytes(10).toString('hex');
  const relPath = (key, suffix) => `${key.slice(0, 2)}/${key}${suffix}`;

  async function target(rel) {
    const full = path.join(mediaDir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    return full;
  }

  // sharp drops EXIF (including GPS position) unless asked to keep it.
  async function writeImageVariants(input, key) {
    const variants = {};
    try {
      for (const [name, size] of Object.entries(IMAGE_SIZES)) {
        const rel = relPath(key, `-${name}.webp`);
        const info = await sharp(input)
          .rotate()
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(await target(rel));
        variants[name] = { file: rel, width: info.width, height: info.height };
      }
      // 1200x630 JPEG is what chat apps and social sites expect for link previews.
      const ogRel = relPath(key, '-og.jpg');
      const og = await sharp(input)
        .rotate()
        .resize(1200, 630, { fit: 'cover', position: sharp.strategy.attention })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 78, mozjpeg: true })
        .toFile(await target(ogRel));
      variants.og = { file: ogRel, width: og.width, height: og.height };
      return variants;
    } catch (err) {
      await removeFiles({ variants });
      throw err;
    }
  }

  async function processImage(tmpPath, name) {
    let meta;
    try {
      meta = await sharp(tmpPath).metadata();
    } catch {
      throw new HttpError(400, `${name}: not a supported image file.`);
    }
    if (!IMAGE_FORMATS.has(meta.format)) {
      throw new HttpError(400, `${name}: use JPEG, PNG, WebP or AVIF images.`);
    }
    const key = newKey();
    let variants;
    try {
      variants = await writeImageVariants(tmpPath, key);
    } catch {
      const hint = meta.format === 'heif' ? ' iPhone HEIC photos must be exported as JPEG first.' : '';
      throw new HttpError(400, `${name}: this image could not be processed.${hint}`);
    }
    const sideways = (meta.orientation ?? 1) >= 5;
    const { size } = await fsp.stat(tmpPath);
    let original = null;
    if (keepOriginals) {
      original = `${key}.${meta.format === 'jpeg' ? 'jpg' : meta.format}`;
      await move(tmpPath, path.join(originalsDir, original));
    }
    return {
      kind: 'image',
      key,
      mime: `image/${meta.format}`,
      bytes: size,
      width: sideways ? meta.height : meta.width,
      height: sideways ? meta.width : meta.height,
      duration: null,
      file: null,
      original,
      variants,
    };
  }

  async function probe(file) {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout);
    const video = (data.streams || []).find((s) => s.codec_type === 'video');
    if (!video) throw new Error('no video stream');
    let { width, height } = video;
    const rotation = Number(
      video.tags?.rotate ?? video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0,
    );
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    const duration = Number.parseFloat(data.format?.duration ?? video.duration ?? '');
    return { width: width ?? null, height: height ?? null, duration: Number.isFinite(duration) ? duration : null };
  }

  async function posterVariants(videoFile, key, duration) {
    const frame = path.join(tmpDir, `${key}-poster.jpg`);
    const at = duration ? Math.min(1, duration / 3) : 0;
    try {
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', videoFile, '-frames:v', '1', '-q:v', '2', frame], {
        timeout: 120_000,
      });
      return await writeImageVariants(frame, key);
    } catch {
      return {};
    } finally {
      await fsp.rm(frame, { force: true });
    }
  }

  async function processVideo(tmpPath, name) {
    const ext = path.extname(name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) {
      throw new HttpError(400, `${name}: videos must be MP4, MOV, M4V or WebM.`);
    }
    const key = newKey();
    const webm = ext === '.webm';
    const rel = relPath(key, webm ? '.webm' : '.mp4');
    const out = await target(rel);
    let info = { width: null, height: null, duration: null };
    let variants = {};

    if (ffmpeg) {
      try {
        info = await probe(tmpPath);
      } catch {
        throw new HttpError(400, `${name}: this video could not be read.`);
      }
      // Copy the streams (no re-encoding) into a web container, drop metadata such as the
      // GPS position phones record, and put the index first so playback starts straight away.
      const args = ['-y', '-v', 'error', '-i', tmpPath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-map_metadata', '-1'];
      if (!webm) args.push('-movflags', '+faststart');
      args.push(out);
      try {
        await run('ffmpeg', args, { timeout: 30 * 60 * 1000 });
        await fsp.rm(tmpPath, { force: true });
      } catch {
        // Unusual codec for the container: keep the file exactly as uploaded.
        await move(tmpPath, out);
      }
      variants = await posterVariants(out, key, info.duration);
    } else {
      await move(tmpPath, out);
    }

    const { size } = await fsp.stat(out);
    return {
      kind: 'video',
      key,
      mime: webm ? 'video/webm' : 'video/mp4',
      bytes: size,
      ...info,
      file: rel,
      original: null,
      variants,
    };
  }

  async function processDocument(tmpPath, name) {
    const handle = await fsp.open(tmpPath, 'r');
    const head = Buffer.alloc(5);
    try {
      await handle.read(head, 0, 5, 0);
    } finally {
      await handle.close();
    }
    if (head.toString('latin1') !== '%PDF-') {
      throw new HttpError(400, `${name}: brochures must be PDF files.`);
    }
    const key = newKey();
    const rel = relPath(key, '.pdf');
    const { size } = await fsp.stat(tmpPath);
    await move(tmpPath, await target(rel));
    return { kind: 'document', key, mime: 'application/pdf', bytes: size, width: null, height: null, duration: null, file: rel, original: null, variants: {} };
  }

  async function processUpload(upload, role) {
    const name = upload.originalname || 'file';
    try {
      if (role === 'brochure') return await processDocument(upload.path, name);
      if (role === 'gallery' && isVideoUpload(upload)) return await processVideo(upload.path, name);
      return await processImage(upload.path, name);
    } finally {
      await fsp.rm(upload.path, { force: true });
    }
  }

  async function removeFiles(row) {
    const variants = typeof row.variants === 'string' ? JSON.parse(row.variants || '{}') : row.variants || {};
    const files = Object.values(variants).map((v) => path.join(mediaDir, v.file));
    if (row.file) files.push(path.join(mediaDir, row.file));
    if (row.original) files.push(path.join(originalsDir, row.original));
    await Promise.all(files.map((f) => fsp.rm(f, { force: true })));
  }

  return { mediaDir, tmpDir, ffmpeg, processUpload, removeFiles };
}
