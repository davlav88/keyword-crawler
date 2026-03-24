import path from 'path';
import fs from 'fs/promises';
import { hashUrl, slugifyKeyword, warn, verbose } from './utils.js';

const MAX_ELEMENT_DIMENSION = 2000; // px

/**
 * Capture a screenshot of the DOM element tagged with `data-kc-match="${matchId}"`.
 *
 * @param {import('puppeteer').Page} page        Already-navigated Puppeteer page
 * @param {string}  pageUrl                       URL of the page (for filename)
 * @param {string}  matchId                       Unique match ID set on the element by the matcher
 * @param {string}  keyword                       Keyword that triggered this match
 * @param {number}  index                         Match index (for unique filenames)
 * @param {string}  screenshotsDir               Absolute path to screenshots directory
 * @returns {Promise<string|null>}               Relative filename, or null on failure
 */
export async function screenshotElement(page, pageUrl, matchId, keyword, index, screenshotsDir) {
  try {
    await fs.mkdir(screenshotsDir, { recursive: true });

    const urlHash = hashUrl(pageUrl);
    const kwSlug = slugifyKeyword(keyword);
    const filename = `${urlHash}-${kwSlug}-${index}.png`;
    const filepath = path.join(screenshotsDir, filename);

    // Find the element by the unique data attribute set during matching
    const elementHandle = await page.$(`[data-kc-match="${matchId}"]`);
    if (!elementHandle) {
      verbose(`Screenshot: element not found for matchId "${matchId}" on ${pageUrl}`);
      return null;
    }

    // Scroll into view
    await elementHandle.scrollIntoView();

    // Check element dimensions
    const box = await elementHandle.boundingBox();
    if (!box) {
      verbose(`Screenshot: could not get bounding box for matchId "${matchId}" on ${pageUrl}`);
      return null;
    }

    if (box.width > MAX_ELEMENT_DIMENSION || box.height > MAX_ELEMENT_DIMENSION) {
      // Element too large — take a viewport screenshot with element in view
      verbose(`Screenshot: element too large (${Math.round(box.width)}×${Math.round(box.height)}), using viewport screenshot`);
      await page.screenshot({ path: filepath, type: 'png' });
    } else {
      // Screenshot just the element
      await elementHandle.screenshot({ path: filepath, type: 'png' });
    }

    verbose(`Screenshot saved: ${filename}`);
    return path.join('screenshots', filename);
  } catch (err) {
    warn(`Screenshot failed for keyword "${keyword}" on ${pageUrl}: ${err.message}`);
    return null;
  }
}
