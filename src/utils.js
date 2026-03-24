import crypto from 'crypto';
import { URL } from 'url';

// ── URL filtering ────────────────────────────────────────────────────────────

const NON_HTML_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif',
  '.css', '.js', '.mjs', '.ts',
  '.zip', '.gz', '.tar', '.rar',
  '.mp4', '.mp3', '.mov', '.avi', '.wmv', '.webm',
  '.woff', '.woff2', '.ttf', '.eot',
  '.ico', '.json', '.xml', '.txt',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

const BLOCKED_PATTERNS = [
  '/wp-json/', '/feed/', '/xmlrpc.php', '/wp-admin/',
  '/wp-content/uploads/', '/wp-includes/',
  '/comment-page-', '/trackback/', '/embed/',
];

export function normalizeUrl(rawUrl, base) {
  try {
    const u = new URL(rawUrl, base);
    // Remove fragment
    u.hash = '';
    // Lowercase hostname
    u.hostname = u.hostname.toLowerCase();
    // Strip trailing slash (except root /)
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return null;
  }
}

export function isHtmlUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const pathname = u.pathname.toLowerCase();

    // Check file extension
    const lastSegment = pathname.split('/').pop();
    const dotIdx = lastSegment.lastIndexOf('.');
    if (dotIdx !== -1) {
      const ext = lastSegment.slice(dotIdx);
      if (NON_HTML_EXTENSIONS.has(ext)) return false;
    }

    // Check blocked path patterns
    const full = u.pathname.toLowerCase();
    for (const pat of BLOCKED_PATTERNS) {
      if (full.includes(pat)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function isSameOrigin(url, seedUrl) {
  try {
    return new URL(url).hostname === new URL(seedUrl).hostname;
  } catch {
    return false;
  }
}

// ── Hashing / naming ─────────────────────────────────────────────────────────

export function hashUrl(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
}

export function slugifyKeyword(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

// ── Logging ───────────────────────────────────────────────────────────────────

let _verbose = false;

export function setVerbose(v) {
  _verbose = v;
}

export function log(...args) {
  console.log(...args);
}

export function verbose(...args) {
  if (_verbose) console.log('[verbose]', ...args);
}

export function warn(...args) {
  console.error('[warn]', ...args);
}

export function logError(...args) {
  console.error('[error]', ...args);
}

// ── Concurrency ───────────────────────────────────────────────────────────────

/**
 * Run `processor` over all `items` with at most `concurrency` running at once.
 * Returns array of { result, error } in original order.
 */
export async function workQueue(items, concurrency, processor) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = { result: await processor(items[i], i) };
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Delay ─────────────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

export async function fetchWithTimeout(url, timeoutMs = 15000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'KeywordCrawler/1.0',
        ...extraHeaders,
      },
      redirect: 'follow',
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ── Robots.txt (best-effort) ──────────────────────────────────────────────────

const robotsCache = new Map();

export async function checkRobots(url) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;

    if (!robotsCache.has(u.origin)) {
      const resp = await fetchWithTimeout(robotsUrl, 5000);
      if (resp.ok) {
        robotsCache.set(u.origin, await resp.text());
      } else {
        robotsCache.set(u.origin, '');
      }
    }

    const robotsTxt = robotsCache.get(u.origin);
    if (!robotsTxt) return true;

    // Simple parser: find Disallow rules for * or KeywordCrawler
    let inRelevantAgent = false;
    const lines = robotsTxt.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('User-agent:')) {
        const agent = trimmed.split(':')[1].trim();
        inRelevantAgent = agent === '*' || agent.toLowerCase().includes('keywordcrawler');
      } else if (inRelevantAgent && trimmed.startsWith('Disallow:')) {
        const disallowedPath = trimmed.split(':')[1].trim();
        if (disallowedPath && u.pathname.startsWith(disallowedPath)) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return true; // On error, allow
  }
}
