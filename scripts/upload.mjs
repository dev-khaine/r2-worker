#!/usr/bin/env node
/**
 * upload.mjs — Upload any file to the Capital R2 bucket
 *
 * Usage:
 *   node scripts/upload.mjs post    my-article.md
 *   node scripts/upload.mjs image   hero-photo.jpg         [--subdir heroes]
 *   node scripts/upload.mjs image   inline-chart.png       [--subdir inline]
 *   node scripts/upload.mjs file    q1-report.pdf
 *   node scripts/upload.mjs asset   og-default.jpg
 *
 * The type determines the R2 prefix:
 *   post   → posts/<slug>.md
 *   image  → images/[subdir/]<filename>
 *   file   → files/<filename>
 *   asset  → assets/<filename>
 *
 * After uploading a post, revalidation is triggered automatically.
 * For images/files/assets, pass --revalidate to also trigger a rebuild.
 */

import { execSync }                       from 'node:child_process';
import { existsSync, statSync }           from 'node:fs';
import { basename, extname }              from 'node:path';
import { createRequire }                  from 'node:module';

const require = createRequire(import.meta.url);

// Load dotenv without ESM import issues
try { require('dotenv').config(); } catch { /* dotenv optional */ }

// ── CONFIG ────────────────────────────────────────────────────────────────

const BUCKET        = 'capital-blog-content';
const WORKER_URL    = process.env.R2_WORKER_URL?.replace(/\/$/, '');
const WORKER_SECRET = process.env.R2_WORKER_SECRET;

// ── MIME TYPES ────────────────────────────────────────────────────────────

const MIME = {
  '.md':   'text/markdown; charset=utf-8',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
  '.csv':  'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.txt':  'text/plain; charset=utf-8',
};

// ── HELPERS ───────────────────────────────────────────────────────────────

const log  = (msg)  => console.log(`   ${msg}`);
const ok   = (msg)  => console.log(`✓  ${msg}`);
const warn = (msg)  => console.warn(`⚠  ${msg}`);
const fail = (msg)  => { console.error(`✗  ${msg}`); process.exit(1); };
const hr   = ()     => console.log('─'.repeat(52));

function slugify(filename) {
  return basename(filename, extname(filename))
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getMime(filename) {
  const ext = extname(filename).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function fmtSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── UPLOAD ────────────────────────────────────────────────────────────────

function uploadToR2(localPath, r2Key) {
  if (!existsSync(localPath)) fail(`File not found: ${localPath}`);
  const size = fmtSize(statSync(localPath).size);
  const mime = getMime(localPath);

  log(`${localPath}  (${size})`);
  log(`→ R2: ${BUCKET}/${r2Key}`);
  log(`  Content-Type: ${mime}`);

  try {
    execSync(
      `wrangler r2 object put "${BUCKET}/${r2Key}" --file="${localPath}" --content-type="${mime}"`,
      { stdio: 'inherit' }
    );
    ok(`Uploaded: ${r2Key}\n`);
    return true;
  } catch {
    fail(`wrangler upload failed for ${localPath}`);
  }
}

// ── REVALIDATE ────────────────────────────────────────────────────────────

async function triggerRevalidate() {
  if (!WORKER_URL || !WORKER_SECRET) {
    warn('R2_WORKER_URL or R2_WORKER_SECRET not set — skipping revalidation.');
    return;
  }
  log(`Calling ${WORKER_URL}/revalidate ...`);
  try {
    const res  = await fetch(`${WORKER_URL}/revalidate`, {
      method: 'POST',
      headers: { 'X-Revalidate-Secret': WORKER_SECRET },
    });
    const body = await res.json();
    if (!res.ok) { warn(`Revalidate returned ${res.status}: ${JSON.stringify(body)}`); return; }
    ok(`Revalidation triggered → ${body.message}`);
  } catch (e) {
    warn(`Revalidation request failed: ${e.message}`);
  }
}

// ── TYPE HANDLERS ─────────────────────────────────────────────────────────

function uploadPost(filePath) {
  if (!filePath.endsWith('.md')) fail('Post files must be .md');
  const slug  = slugify(filePath);
  const r2Key = `posts/${slug}.md`;
  uploadToR2(filePath, r2Key);
  return true; // always revalidate after a post upload
}

function uploadImage(filePath, subdir) {
  const validExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg'];
  if (!validExts.includes(extname(filePath).toLowerCase())) {
    fail(`Not a supported image format: ${filePath}\nSupported: ${validExts.join(', ')}`);
  }
  const filename = basename(filePath);
  const r2Key    = subdir
    ? `images/${subdir}/${filename}`
    : `images/${filename}`;
  uploadToR2(filePath, r2Key);

  // Print the URL they can use in frontmatter/markdown
  if (WORKER_URL) {
    const imgUrl = `${WORKER_URL}/img/${subdir ? `${subdir}/` : ''}${filename}`;
    console.log(`   📎 Use in frontmatter:  heroImage: "${imgUrl}"`);
    console.log(`   📎 Use in markdown:     ![alt](${imgUrl}?w=800)\n`);
  }
  return false; // caller decides whether to revalidate
}

function uploadFile(filePath) {
  const filename = basename(filePath);
  const r2Key    = `files/${filename}`;
  uploadToR2(filePath, r2Key);
  if (WORKER_URL) {
    console.log(`   📎 Download URL: ${WORKER_URL}/file/${filename}\n`);
  }
  return false;
}

function uploadAsset(filePath) {
  const filename = basename(filePath);
  const r2Key    = `assets/${filename}`;
  uploadToR2(filePath, r2Key);
  if (WORKER_URL) {
    console.log(`   📎 Asset URL: ${WORKER_URL}/asset/${filename}\n`);
  }
  return false;
}

// ── ARG PARSING ───────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const type       = args[0];
const filePath   = args[1];
const subdirFlag = args.indexOf('--subdir');
const subdir     = subdirFlag !== -1 ? args[subdirFlag + 1] : null;
const forceReval = args.includes('--revalidate');

const TYPES = ['post', 'image', 'file', 'asset'];

if (!type || !TYPES.includes(type) || !filePath) {
  console.log(`
  Usage:
    node scripts/upload.mjs post    <file.md>
    node scripts/upload.mjs image   <file.jpg>  [--subdir heroes|inline]
    node scripts/upload.mjs file    <file.pdf>
    node scripts/upload.mjs asset   <file.jpg>  [--revalidate]

  Options:
    --subdir <name>   Put image under images/<subdir>/  (e.g. heroes, inline)
    --revalidate      Trigger a Pages rebuild after upload (auto for posts)

  Examples:
    node scripts/upload.mjs post  articles/fed-dilemma.md
    node scripts/upload.mjs image photos/fed-photo.jpg --subdir heroes
    node scripts/upload.mjs image photos/sp500-chart.png --subdir inline
    node scripts/upload.mjs file  reports/q1-2024.pdf
    node scripts/upload.mjs asset og-default.jpg --revalidate
  `);
  process.exit(1);
}

// ── MAIN ──────────────────────────────────────────────────────────────────

hr();
console.log(`  Uploading ${type.toUpperCase()}: ${filePath}`);
hr();
console.log();

let shouldRevalidate = forceReval;

switch (type) {
  case 'post':  shouldRevalidate = uploadPost(filePath) || forceReval; break;
  case 'image': shouldRevalidate = uploadImage(filePath, subdir) || forceReval; break;
  case 'file':  shouldRevalidate = uploadFile(filePath) || forceReval; break;
  case 'asset': shouldRevalidate = uploadAsset(filePath) || forceReval; break;
}

if (shouldRevalidate) {
  hr();
  console.log('  Triggering site revalidation...');
  hr();
  console.log();
  await triggerRevalidate();
}

hr();
console.log(`  🎉 Done!${shouldRevalidate ? ' Site rebuild triggered — live in ~1-2 min.' : ''}`);
hr();
console.log();
