import path from 'path';
import puppeteer from 'puppeteer';
import { searchPage, searchHtml } from './matcher.js';
import { screenshotElement } from './screenshotter.js';
import { workQueue, isHtmlUrl, sleep, log, verbose, warn } from './utils.js';

// ── Cookie banner dismissal ───────────────────────────────────────────────────

const COOKIE_SELECTORS = [
  '[class*="cookie"] button[class*="accept"]',
  '[class*="cookie"] button[class*="agree"]',
  '[id*="cookie"] button[class*="accept"]',
  '#accept-cookies',
  '#acceptCookies',
  'button[aria-label*="Accept"]',
  'button[aria-label*="Agree"]',
  '[class*="consent"] button[class*="accept"]',
  '.cc-accept',
  '.cc-allow',
];

async function dismissCookieBanner(page) {
  for (const sel of COOKIE_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
        verbose(`Dismissed cookie banner: ${sel}`);
        return;
      }
    } catch {
      // ignore — try next selector
    }
  }
}

// ── Page loader ───────────────────────────────────────────────────────────────

async function loadPage(browser, url, delay) {
  const page = await browser.newPage();
  await page.setUserAgent('KeywordCrawler/1.0');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Set a reasonable viewport
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await sleep(delay);

    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    if (!response) throw new Error('No response');

    const status = response.status();
    if (status >= 400) throw new Error(`HTTP ${status}`);

    // Check Content-Type — skip non-HTML
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('text/html')) {
      throw new Error(`Non-HTML content-type: ${contentType}`);
    }

    // Check final URL (redirect) — must stay same origin
    const finalUrl = page.url();
    if (new URL(finalUrl).hostname !== new URL(url).hostname) {
      throw new Error(`Redirect to different origin: ${finalUrl}`);
    }

    // Try to dismiss cookie banners
    await dismissCookieBanner(page);

    return { page, finalUrl, ok: true };
  } catch (err) {
    await page.close().catch(() => {});
    return { ok: false, error: err.message };
  }
}

// ── Single page scan ──────────────────────────────────────────────────────────

async function scanPage(browser, url, keywords, options) {
  const { delay, ignoreCase, selector, screenshots, screenshotsDir } = options;

  verbose(`Scanning: ${url}`);

  const { page, finalUrl, ok, error } = await loadPage(browser, url, delay);

  if (!ok) {
    return { url, matches: [], error };
  }

  try {
    let matches;

    try {
      matches = await searchPage(page, finalUrl, keywords, { ignoreCase, selector });
    } catch (matchErr) {
      // Puppeteer-based matching failed — fall back to Cheerio on raw HTML
      warn(`Puppeteer match failed on ${url}, using Cheerio fallback: ${matchErr.message}`);
      const html = await page.content();
      matches = await searchHtml(html, finalUrl, keywords, { ignoreCase, selector });
    }

    // Capture screenshots
    if (screenshots && matches.length > 0) {
      const matchCountPerKeyword = {};
      for (const match of matches) {
        const key = match.keyword;
        matchCountPerKeyword[key] = (matchCountPerKeyword[key] || 0);
        const idx = matchCountPerKeyword[key]++;

        match.screenshotFile = await screenshotElement(
          page,
          match.url,
          match.selector,
          match.keyword,
          idx,
          screenshotsDir,
        );
      }
    }

    return { url: finalUrl, matches, error: null };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Phase 2 entry point ───────────────────────────────────────────────────────

/**
 * Scan all URLs for keywords.
 *
 * @param {string[]} urls
 * @param {string[]} keywords
 * @param {object}   options
 * @returns {Promise<{ matches: Array, errors: Array }>}
 */
export async function scanUrls(urls, keywords, options) {
  const { concurrency, output } = options;
  const screenshotsDir = path.join(output, 'screenshots');

  const allMatches = [];
  const allErrors = [];
  const total = urls.length;
  let done = 0;

  // Launch a single browser instance shared across all pages
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    await workQueue(urls, concurrency, async (url) => {
      done++;
      process.stdout.write(`\r  [${done}/${total}] Scanning ${url.slice(0, 80)}`);

      const result = await scanPage(browser, url, keywords, {
        ...options,
        screenshotsDir,
      });

      if (result.error) {
        allErrors.push({ url: result.url, error: result.error });
      } else {
        allMatches.push(...result.matches);
      }
    });

    process.stdout.write('\n');
  } finally {
    await browser.close().catch(() => {});
  }

  return { matches: allMatches, errors: allErrors };
}
