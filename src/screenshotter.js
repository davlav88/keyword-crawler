import path from 'path';
import fs from 'fs/promises';
import { hashUrl, slugifyKeyword, warn, verbose } from './utils.js';

const MAX_ELEMENT_DIMENSION = 2000; // px

/**
 * Capture a screenshot of the DOM element tagged with `data-kc-match="${matchId}"`.
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
      warn(`Screenshot: element not found for matchId "${matchId}" on ${pageUrl}`);
      return null;
    }

    // Scroll into view (compatible with all Puppeteer versions)
    await page.evaluate((el) => el.scrollIntoView({ block: 'center' }), elementHandle);

    // Brief pause for any lazy-loaded content / scroll animations
    await new Promise((r) => setTimeout(r, 300));

    // Check element dimensions
    const box = await elementHandle.boundingBox();
    if (!box) {
      warn(`Screenshot: no bounding box for matchId "${matchId}" on ${pageUrl}`);
      return null;
    }

    if (box.width > MAX_ELEMENT_DIMENSION || box.height > MAX_ELEMENT_DIMENSION) {
      verbose(`Screenshot: element too large (${Math.round(box.width)}×${Math.round(box.height)}), using viewport screenshot`);
      await page.screenshot({ path: filepath, type: 'png' });
    } else {
      await elementHandle.screenshot({ path: filepath, type: 'png' });
    }

    verbose(`Screenshot saved: ${filename}`);
    return path.join('screenshots', filename);
  } catch (err) {
    warn(`Screenshot failed for keyword "${keyword}" on ${pageUrl}: ${err.message}`);
    return null;
  }
}
