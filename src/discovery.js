import { URL } from 'url';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import {
  normalizeUrl,
  isHtmlUrl,
  isSameOrigin,
  fetchWithTimeout,
  log,
  verbose,
} from './utils.js';

// ── Sitemap parsing ───────────────────────────────────────────────────────────

async function decompressGzip(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const gunzip = createGunzip();
    Readable.from(buffer).pipe(gunzip);
    gunzip.on('data', (chunk) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    gunzip.on('error', reject);
  });
}

async function fetchSitemapContent(url) {
  const resp = await fetchWithTimeout(url, 20000);
  if (!resp.ok) return null;

  const contentType = resp.headers.get('content-type') || '';
  const isGzip = url.endsWith('.gz') || contentType.includes('gzip');

  if (isGzip) {
    const buf = Buffer.from(await resp.arrayBuffer());
    return decompressGzip(buf);
  }
  return resp.text();
}

/**
 * Recursively parse a sitemap (or sitemap index) and return all page URLs.
 */
async function parseSitemap(sitemapUrl, visitedSitemaps = new Set()) {
  if (visitedSitemaps.has(sitemapUrl)) return [];
  visitedSitemaps.add(sitemapUrl);

  const urls = [];

  try {
    verbose(`Fetching sitemap: ${sitemapUrl}`);
    const content = await fetchSitemapContent(sitemapUrl);
    if (!content) return urls;

    // Check for sitemap index (contains <sitemap> entries)
    const sitemapIndexRe = /<sitemap[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi;
    let isIndex = false;
    for (const match of content.matchAll(sitemapIndexRe)) {
      isIndex = true;
      const childUrl = match[1].trim();
      const childUrls = await parseSitemap(childUrl, visitedSitemaps);
      urls.push(...childUrls);
    }

    // If not an index, parse <url> entries
    if (!isIndex) {
      const urlRe = /<url[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/url>/gi;
      for (const match of content.matchAll(urlRe)) {
        urls.push(match[1].trim());
      }
    }
  } catch (err) {
    verbose(`Sitemap error for ${sitemapUrl}: ${err.message}`);
  }

  return urls;
}

// ── robots.txt sitemap discovery ─────────────────────────────────────────────

async function getSitemapUrlsFromRobots(origin) {
  try {
    const resp = await fetchWithTimeout(`${origin}/robots.txt`, 5000);
    if (!resp.ok) return [];
    const text = await resp.text();
    const sitemapUrls = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('sitemap:')) {
        sitemapUrls.push(trimmed.slice(8).trim());
      }
    }
    return sitemapUrls;
  } catch {
    return [];
  }
}

// ── Phase 1 entry point ───────────────────────────────────────────────────────

export async function discoverUrls(seedUrls, options) {
  const { output } = options;

  const allUrls = new Set();
  let totalSitemapRaw = 0;
  let totalFilteredOut = 0;

  for (const seedUrl of seedUrls) {
    const origin = new URL(seedUrl).origin;

    log(`\nFetching sitemaps for ${origin}...`);

    // Check robots.txt for Sitemap: directives first
    const robotsSitemaps = await getSitemapUrlsFromRobots(origin);
    const sitemapSources = robotsSitemaps.length > 0
      ? robotsSitemaps
      : [`${origin}/sitemap.xml`];

    const sitemapRaw = [];
    for (const sitemapUrl of sitemapSources) {
      const found = await parseSitemap(sitemapUrl);
      sitemapRaw.push(...found);
    }
    totalSitemapRaw += sitemapRaw.length;

    let sitemapAdded = 0;
    for (const rawUrl of sitemapRaw) {
      const normalized = normalizeUrl(rawUrl, seedUrl);
      if (!normalized || !isSameOrigin(normalized, seedUrl) || !isHtmlUrl(normalized)) {
        totalFilteredOut++;
        continue;
      }
      if (!allUrls.has(normalized)) {
        allUrls.add(normalized);
        sitemapAdded++;
        process.stdout.write(`\r  Found: ${allUrls.size} URLs`);
      }
    }
    process.stdout.write('\n');
    verbose(`Sitemap: ${sitemapAdded} new URLs added (${sitemapRaw.length} raw)`);
  }

  const urlList = [...allUrls];

  // Save discovered URLs to file
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, 'discovered-urls.txt'),
    urlList.join('\n') + '\n',
    'utf-8',
  );
  verbose(`Saved discovered URLs to ${path.join(output, 'discovered-urls.txt')}`);

  return {
    urls: urlList,
    stats: {
      sitemapUrls: totalSitemapRaw,
      totalUniqueUrls: urlList.length,
      filteredOut: totalFilteredOut,
    },
  };
}
