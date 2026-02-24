/**
 * capital-r2-api — Cloudflare Worker
 *
 * ── BUCKET LAYOUT ─────────────────────────────────────────────────────────
 *
 *   posts/                     ← markdown articles
 *     fed-dilemma-2024.md
 *     bitcoin-etf.md
 *
 *   images/                    ← hero images + inline article images
 *     heroes/
 *       fed-dilemma-2024.jpg
 *     inline/
 *       chart-sp500.png
 *
 *   assets/                    ← site-level assets (og-image, etc.)
 *     og-default.jpg
 *     logo.svg
 *
 *   files/                     ← downloadable files (PDFs, data)
 *     report-q1-2024.pdf
 *     dataset-inflation.csv
 *
 * ── API ROUTES ────────────────────────────────────────────────────────────
 *
 *   GET  /posts                → list published posts (metadata)
 *   GET  /posts/:slug          → single post (metadata + body)
 *   GET  /img/:path            → proxy image through Cloudflare Image Transforms
 *                                ?w=800&h=450&f=webp&fit=cover&q=85
 *   GET  /file/:path           → serve downloadable file from R2
 *   GET  /asset/:path          → serve site asset from R2
 *   POST /revalidate           → trigger CF Pages deploy hook (authenticated)
 *   GET  /health               → health check
 */

// ── TYPES ──────────────────────────────────────────────────────────────────

interface Env {
  BLOG_CONTENT:       R2Bucket;
  ALLOWED_ORIGINS:    string;
  R2_PUBLIC_URL:      string;   // e.g. https://pub-abc123.r2.dev  (no trailing slash)
  WORKER_SECRET:      string;   // wrangler secret put WORKER_SECRET
  PAGES_DEPLOY_HOOK?: string;   // wrangler secret put PAGES_DEPLOY_HOOK
}

interface PostFrontmatter {
  title:        string;
  description:  string;
  pubDate:      string;
  updatedDate?: string;
  heroImage?:   string;
  tags?:        string[];
  draft?:       boolean;
}

interface PostMeta extends PostFrontmatter {
  slug:     string;
  sortDate: string;
}

interface PostFull extends PostMeta {
  body: string;
}

// Image transform options passed as query params to GET /img/:path
interface ImgParams {
  w?:   number;
  h?:   number;
  f?:   string;   // format: webp | avif | jpeg | png
  q?:   number;   // quality 1–100
  fit?: string;   // cover | contain | scale-down | crop | pad
}

// ── HELPERS ────────────────────────────────────────────────────────────────

function getCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin  = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  const allowedOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Revalidate-Secret',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function jsonResp(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200
        ? 'public, s-maxage=60, stale-while-revalidate=300'
        : 'no-store',
      ...extra,
    },
  });
}

function errResp(message: string, status: number, extra: HeadersInit = {}): Response {
  return jsonResp({ error: message }, status, extra);
}

// ── FRONTMATTER PARSER ────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { data: Partial<PostFrontmatter>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };

  const [, yamlBlock, body] = match;
  const data: Partial<PostFrontmatter> = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim() as keyof PostFrontmatter;
    let   value = line.slice(colonIdx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === 'tags') {
      const arr = value.replace(/^\[|\]$/g, '').split(',')
        .map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      (data as Record<string, unknown>)[key] = arr;
    } else if (key === 'draft') {
      (data as Record<string, unknown>)[key] = value === 'true';
    } else {
      (data as Record<string, unknown>)[key] = value;
    }
  }

  return { data, body: body.trim() };
}

// ── MIME TYPE MAP ─────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg:  'image/svg+xml',
  pdf:  'application/pdf',
  csv:  'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt:  'text/plain; charset=utf-8',
};

function getMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

// ── IMAGE TRANSFORM URL BUILDER ───────────────────────────────────────────
// Cloudflare Image Transforms syntax:
//   /cdn-cgi/image/<options>/<source-url>
//
// The source URL must be a public URL — we use the R2 public bucket URL.
// The transform request must hit a domain on your Cloudflare zone.
// Typically you'll route your Worker on your main domain so transforms work.

function buildTransformUrl(
  env: Env,
  r2Path: string,      // e.g. "images/heroes/post.jpg"
  params: ImgParams
): string {
  // Build the options string: width=800,height=450,format=webp,quality=85,fit=cover
  const opts: string[] = [];
  if (params.w)   opts.push(`width=${params.w}`);
  if (params.h)   opts.push(`height=${params.h}`);
  if (params.f)   opts.push(`format=${params.f}`);
  if (params.q)   opts.push(`quality=${params.q}`);
  if (params.fit) opts.push(`fit=${params.fit}`);

  // If no transform options, just return the direct R2 public URL
  if (opts.length === 0) {
    return `${env.R2_PUBLIC_URL}/${r2Path}`;
  }

  const sourceUrl = `${env.R2_PUBLIC_URL}/${r2Path}`;
  return `/cdn-cgi/image/${opts.join(',')}/${sourceUrl}`;
}

// ── ROUTE HANDLERS ────────────────────────────────────────────────────────

// GET /posts
async function handleListPosts(
  request: Request, env: Env, cors: HeadersInit
): Promise<Response> {
  const url    = new URL(request.url);
  const tag    = url.searchParams.get('tag');
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  ?? '50', 10), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0',  10), 0);

  const listed = await env.BLOG_CONTENT.list({ prefix: 'posts/', limit: 500 });
  const mdKeys = listed.objects.map(o => o.key).filter(k => k.endsWith('.md'));

  const posts: PostMeta[] = [];

  await Promise.all(mdKeys.map(async (key) => {
    const obj = await env.BLOG_CONTENT.get(key);
    if (!obj) return;
    const raw  = await obj.text();
    const slug = key.replace(/^posts\//, '').replace(/\.md$/, '');
    const { data } = parseFrontmatter(raw);
    if (!data.title || !data.description || !data.pubDate) return;
    if (data.draft) return;
    posts.push({
      slug,
      title:       data.title,
      description: data.description,
      pubDate:     data.pubDate,
      sortDate:    new Date(data.pubDate).toISOString(),
      updatedDate: data.updatedDate,
      heroImage:   data.heroImage,
      tags:        data.tags ?? [],
      draft:       false,
    });
  }));

  let sorted = posts.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
  if (tag) sorted = sorted.filter(p => p.tags?.includes(tag));

  const total  = sorted.length;
  const sliced = sorted.slice(offset, offset + limit);

  return jsonResp({ total, offset, limit, posts: sliced }, 200, {
    ...cors,
    'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
  });
}

// GET /posts/:slug
async function handleGetPost(
  slug: string, _req: Request, env: Env, cors: HeadersInit
): Promise<Response> {
  const obj = await env.BLOG_CONTENT.get(`posts/${slug}.md`);
  if (!obj) return errResp('Post not found', 404, cors);

  const raw  = await obj.text();
  const { data, body } = parseFrontmatter(raw);

  if (!data.title || !data.description || !data.pubDate) {
    return errResp('Post has invalid frontmatter', 422, cors);
  }
  if (data.draft) return errResp('Post not found', 404, cors);

  return jsonResp({
    slug,
    title:       data.title,
    description: data.description,
    pubDate:     data.pubDate,
    sortDate:    new Date(data.pubDate).toISOString(),
    updatedDate: data.updatedDate,
    heroImage:   data.heroImage,
    tags:        data.tags ?? [],
    draft:       false,
    body,
  } satisfies PostFull, 200, {
    ...cors,
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
  });
}

// GET /img/:path?w=&h=&f=webp&q=85&fit=cover
// Redirects to a Cloudflare Image Transform URL.
// The browser/CDN fetches the transformed image from the transform URL.
async function handleImage(
  imagePath: string,
  request: Request,
  env: Env,
  cors: HeadersInit
): Promise<Response> {
  const r2Key = `images/${imagePath}`;

  // Verify the object actually exists in R2 before redirecting
  const head = await env.BLOG_CONTENT.head(r2Key);
  if (!head) return errResp('Image not found', 404, cors);

  const url    = new URL(request.url);
  const params: ImgParams = {
    w:   url.searchParams.has('w')   ? parseInt(url.searchParams.get('w')!)   : undefined,
    h:   url.searchParams.has('h')   ? parseInt(url.searchParams.get('h')!)   : undefined,
    f:   url.searchParams.get('f')   ?? 'webp',  // default → webp
    q:   url.searchParams.has('q')   ? parseInt(url.searchParams.get('q')!)   : 85,
    fit: url.searchParams.get('fit') ?? 'cover',
  };

  const transformUrl = buildTransformUrl(env, r2Key, params);

  // 302 → browser fetches transform URL directly (CDN caches the result)
  return Response.redirect(transformUrl, 302);
}

// GET /file/:path — serve a downloadable file (PDF, CSV, etc.)
async function handleFile(
  filePath: string, _req: Request, env: Env, cors: HeadersInit
): Promise<Response> {
  const r2Key = `files/${filePath}`;
  const obj   = await env.BLOG_CONTENT.get(r2Key);
  if (!obj) return errResp('File not found', 404, cors);

  const filename = filePath.split('/').pop() ?? filePath;
  const mime     = getMime(filePath);

  return new Response(obj.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type':        mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'public, s-maxage=86400, stale-while-revalidate=604800',
      'ETag':                obj.httpEtag,
    },
  });
}

// GET /asset/:path — serve a site-level asset (logo, og-image, etc.)
async function handleAsset(
  assetPath: string, _req: Request, env: Env, cors: HeadersInit
): Promise<Response> {
  const r2Key = `assets/${assetPath}`;
  const obj   = await env.BLOG_CONTENT.get(r2Key);
  if (!obj) return errResp('Asset not found', 404, cors);

  const mime = getMime(assetPath);

  return new Response(obj.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type':  mime,
      'Cache-Control': 'public, s-maxage=31536000, immutable', // 1 year for assets
      'ETag':          obj.httpEtag,
    },
  });
}

// POST /revalidate
async function handleRevalidate(
  request: Request, env: Env, cors: HeadersInit
): Promise<Response> {
  const secret = request.headers.get('X-Revalidate-Secret')
    ?? new URL(request.url).searchParams.get('secret');

  if (!env.WORKER_SECRET || secret !== env.WORKER_SECRET) {
    return errResp('Unauthorized', 401, cors);
  }

  if (env.PAGES_DEPLOY_HOOK) {
    const hookRes = await fetch(env.PAGES_DEPLOY_HOOK, { method: 'POST' });
    if (!hookRes.ok) {
      return jsonResp(
        { ok: false, error: 'Deploy hook failed', status: hookRes.status },
        502, cors
      );
    }
  }

  return jsonResp({
    ok: true,
    message: 'Revalidation triggered',
    timestamp: new Date().toISOString(),
  }, 200, cors);
}

// ── MAIN ENTRY ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors     = getCorsHeaders(request, env);
    const url      = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '');
    const parts    = pathname.split('/').filter(Boolean);
    const method   = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET /health
    if (method === 'GET' && pathname === '/health') {
      return jsonResp({ ok: true, service: 'capital-r2-api', ts: new Date().toISOString() }, 200, cors);
    }

    // GET /posts
    if (method === 'GET' && parts[0] === 'posts' && !parts[1]) {
      return handleListPosts(request, env, cors);
    }

    // GET /posts/:slug
    if (method === 'GET' && parts[0] === 'posts' && parts[1]) {
      return handleGetPost(parts.slice(1).join('/'), request, env, cors);
    }

    // GET /img/:path   (everything after /img/)
    if (method === 'GET' && parts[0] === 'img' && parts[1]) {
      return handleImage(parts.slice(1).join('/'), request, env, cors);
    }

    // GET /file/:path
    if (method === 'GET' && parts[0] === 'file' && parts[1]) {
      return handleFile(parts.slice(1).join('/'), request, env, cors);
    }

    // GET /asset/:path
    if (method === 'GET' && parts[0] === 'asset' && parts[1]) {
      return handleAsset(parts.slice(1).join('/'), request, env, cors);
    }

    // POST /revalidate
    if (method === 'POST' && parts[0] === 'revalidate') {
      return handleRevalidate(request, env, cors);
    }

    return errResp('Not found', 404, cors);
  },
} satisfies ExportedHandler<Env>;
