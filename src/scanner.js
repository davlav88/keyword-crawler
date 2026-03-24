import path from 'path';
import puppeteer from 'puppeteer';
import { searchPage, searchHtml } from './matcher.js';
import { screenshotElement } from './screenshotter.js';
import { workQueue, sleep, log, verbose, warn } from './utils.js';

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

// ── Browser launcher with crash recovery ─────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}

// ── Page loader ───────────────────────────────────────────────────────────────

async function loadPage(browser, url, delay) {
  const page = await browser.newPage();
  await page.setUserAgent('KeywordCrawler/1.0');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  await page.setViewport({ width: 1280, height: 900 });

  try {
    await sleep(delay);

    // Use 'domcontentloaded' so we aren't blocked by persistent background
    // network activity (analytics, chat widgets, etc.).
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (navErr) {
      // Navigation threw (e.g. net::ERR_*). If the page is already showing
      // content (redirected to a usable URL), try to continue anyway.
      if (!page.url() || page.url() === 'about:blank') throw navErr;
      verbose(`Navigation warning on ${url}: ${navErr.message} — attempting scan on partial load`);
    }

    if (response) {
      const status = response.status();
      if (status >= 400) throw new Error(`HTTP ${status}`);

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('text/html')) {
        throw new Error(`Non-HTML content-type: ${contentType}`);
      }
    }

    // Check final URL (redirect) — must stay same origin
    const finalUrl = page.url();
    if (!finalUrl || finalUrl === 'about:blank') throw new Error('No response');
    if (new URL(finalUrl).hostname !== new URL(url).hostname) {
      throw new Error(`Redirect to different origin: ${finalUrl}`);
    }

    // Give JS a moment to render without hard-blocking on network idle.
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 5000 }).catch(() => {
      verbose(`Network did not idle on ${url} — proceeding with current DOM`);
    });

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

const CLEAR_LINE = '\x1b[2K\r';

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

  // Launch a single browser instance shared across all pages.
  // If the browser crashes mid-scan, we relaunch and continue.
  let browser = await launchBrowser();

  async function ensureBrowser() {
    try {
      // Quick connectivity check
      await browser.version();
    } catch {
      warn('Browser disconnected — relaunching');
      browser = await launchBrowser();
    }
    return browser;
  }

  try {
    await workQueue(urls, concurrency, async (url) => {
      done++;
      process.stdout.write(`${CLEAR_LINE}  [${done}/${total}] Scanning ${url.slice(0, 80)}`);

      const activeBrowser = await ensureBrowser();
      const result = await scanPage(activeBrowser, url, keywords, {
        ...options,
        screenshotsDir,
      });

      if (result.error) {
        allErrors.push({ url: result.url, error: result.error });
      }
      // Collect matches even if there was an error (partial results)
      if (result.matches.length > 0) {
        for (const m of result.matches) allMatches.push(m);
      }
    });

    process.stdout.write(`${CLEAR_LINE}`);
  } finally {
    await browser.close().catch(() => {});
  }

  return { matches: allMatches, errors: allErrors };
}
