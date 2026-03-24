/**
 * matcher.js — DOM keyword search and CSS selector generation.
 *
 * The heavy lifting runs inside page.evaluate() (browser context),
 * so this module exports a function that takes a Puppeteer page and
 * returns matches.
 */

// ── Browser-side logic (serialised and injected via page.evaluate) ────────────

/**
 * This function is stringified and executed inside the browser.
 * Must be self-contained — no imports, no closure references.
 */
function browserSearch({ keywords, ignoreCase, selector, maxNodes }) {
  // ── CSS selector generator ────────────────────────────────────────────────

  function buildSelector(el) {
    const parts = [];
    let node = el;

    while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
      let part = node.tagName.toLowerCase();

      if (node.id) {
        part += `#${CSS.escape(node.id)}`;
        parts.unshift(part);
        break; // ID is unique, stop here
      }

      // Prefer meaningful classes (skip layout/utility class noise)
      const classes = Array.from(node.classList)
        .filter((c) => c.length > 1 && !/^(js-|is-|has-|d-|m-|p-|col-|row-)/.test(c))
        .slice(0, 2);

      if (classes.length > 0) {
        part += '.' + classes.map((c) => CSS.escape(c)).join('.');
        parts.unshift(part);
        // Don't stop — add parent context too (up to 3 levels)
        if (parts.length >= 3) break;
        node = node.parentElement;
        continue;
      }

      // Fall back to nth-child
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(
            (c) => c.tagName === node.tagName,
          )
        : [];

      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        part += `:nth-child(${idx})`;
      }

      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 5) break;
    }

    return parts.join(' > ');
  }

  // ── Context extractor ─────────────────────────────────────────────────────

  function buildContext(text, matchIndex, matchLength, windowSize = 100) {
    const start = Math.max(0, matchIndex - windowSize);
    const end = Math.min(text.length, matchIndex + matchLength + windowSize);
    let ctx = '';
    if (start > 0) ctx += '…';
    ctx += text.slice(start, matchIndex);
    ctx += `**${text.slice(matchIndex, matchIndex + matchLength)}**`;
    ctx += text.slice(matchIndex + matchLength, end);
    if (end < text.length) ctx += '…';
    return ctx;
  }

  // ── Walk text nodes ───────────────────────────────────────────────────────

  function getTextNodes(root, limit) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Skip script / style / hidden
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    let node;
    while ((node = walker.nextNode()) && nodes.length < limit) {
      nodes.push(node);
    }
    return nodes;
  }

  // ── Main search ────────────────────────────────────────────────────────────

  const root = document.querySelector(selector) || document.body;
  if (!root) return [];

  const textNodes = getTextNodes(root, maxNodes);
  const matches = [];
  const flags = ignoreCase ? 'gi' : 'g';

  for (const keyword of keywords) {
    // Escape regex special chars
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, flags);

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const parent = textNode.parentElement;
        if (!parent) continue;

        const sel = buildSelector(parent);
        const rawHTML = parent.outerHTML;
        const nodeHTML = rawHTML.length > 500 ? rawHTML.slice(0, 497) + '…' : rawHTML;
        const context = buildContext(text, m.index, m[0].length);

        matches.push({
          keyword,
          matchedText: m[0],
          selector: sel,
          nodeHTML,
          context,
        });
      }
    }
  }

  return matches;
}

// ── Exported function ─────────────────────────────────────────────────────────

/**
 * Run keyword search on an already-loaded Puppeteer page.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} pageUrl
 * @param {string[]} keywords
 * @param {object} opts
 * @param {boolean} opts.ignoreCase
 * @param {string}  opts.selector   CSS selector to limit search scope
 * @returns {Promise<Array>}
 */
export async function searchPage(page, pageUrl, keywords, opts) {
  const { ignoreCase = true, selector = 'body' } = opts;

  const rawMatches = await page.evaluate(browserSearch, {
    keywords,
    ignoreCase,
    selector,
    maxNodes: 500,
  });

  return rawMatches.map((m) => ({
    url: pageUrl,
    keyword: m.keyword,
    matchedText: m.matchedText,
    selector: m.selector,
    nodeHTML: m.nodeHTML,
    context: m.context,
    screenshotFile: null, // populated later by screenshotter
  }));
}

/**
 * Fallback: keyword search on static HTML using Cheerio (no browser).
 */
export async function searchHtml(html, pageUrl, keywords, opts) {
  const { ignoreCase = true, selector = 'body' } = opts;
  const { load } = await import('cheerio');
  const $ = load(html);
  const matches = [];
  const flags = ignoreCase ? 'gi' : 'g';

  const root = $(selector).length ? $(selector) : $('body');

  root.find('*').addBack().each((_i, el) => {
    if (['script', 'style', 'noscript'].includes(el.type)) return;
    // Only leaf-level text nodes
    const children = $(el).contents().filter((_j, n) => n.nodeType === 3);
    if (children.length === 0) return;

    const text = $(el).text();

    for (const keyword of keywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, flags);
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const start = Math.max(0, m.index - 100);
        const end = Math.min(text.length, m.index + m[0].length + 100);
        let context = '';
        if (start > 0) context += '…';
        context += text.slice(start, m.index);
        context += `**${m[0]}**`;
        context += text.slice(m.index + m[0].length, end);
        if (end < text.length) context += '…';

        const rawHTML = $.html(el);
        matches.push({
          url: pageUrl,
          keyword,
          matchedText: m[0],
          selector: el.attribs?.id ? `#${el.attribs.id}` : el.tagName || 'unknown',
          nodeHTML: rawHTML.length > 500 ? rawHTML.slice(0, 497) + '…' : rawHTML,
          context,
          screenshotFile: null,
        });
      }
    }
  });

  return matches;
}
