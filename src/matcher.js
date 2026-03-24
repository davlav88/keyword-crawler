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
        if (parts.length >= 3) break;
        node = node.parentElement;
        continue;
      }

      // Fall back to nth-of-type (counts siblings of same tag, not all children)
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(
            (c) => c.tagName === node.tagName,
          )
        : [];

      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        part += `:nth-of-type(${idx})`;
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
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
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

  // ── Visibility check (only called on matched elements) ─────────────────

  function isVisible(el) {
    try {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    } catch {
      return true;
    }
  }

  // ── Main search ────────────────────────────────────────────────────────────

  const root = document.querySelector(selector) || document.body;
  if (!root) return [];

  const textNodes = getTextNodes(root, maxNodes);
  const matches = [];
  const flags = ignoreCase ? 'gi' : 'g';

  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, flags);

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const parent = textNode.parentElement;
        if (!parent) continue;
        if (!isVisible(parent)) continue;

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

  const rawMatches = await Promise.race([
    page.evaluate(browserSearch, {
      keywords,
      ignoreCase,
      selector,
      maxNodes: 500,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Keyword search timed out after 30s')), 30000),
    ),
  ]);

  return rawMatches.map((m) => ({
    url: pageUrl,
    keyword: m.keyword,
    matchedText: m.matchedText,
    selector: m.selector,
    nodeHTML: m.nodeHTML,
    context: m.context,
    screenshotFile: null,
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

  // Build a set of elements that are the deepest match for each keyword hit,
  // so we don't report the same text from parent AND child.
  const matchedSet = new Set();

  root.find('*').addBack().each((_i, el) => {
    const tagName = el.name || '';
    if (['script', 'style', 'noscript'].includes(tagName)) return;

    // Only consider elements with direct text node children
    const hasDirectText = $(el)
      .contents()
      .toArray()
      .some((n) => n.nodeType === 3 && n.data && n.data.trim());
    if (!hasDirectText) return;

    // Skip if a child element already matched (walk is depth-last, so
    // leaf elements are visited first; reverse the selection to go leaves-first)
    const directText = $(el)
      .contents()
      .filter((_j, n) => n.nodeType === 3)
      .text();
    if (!directText.trim()) return;

    for (const keyword of keywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, flags);
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(directText)) !== null) {
        // Dedup key: element + keyword + match index
        const dedup = `${_i}:${keyword}:${m.index}`;
        if (matchedSet.has(dedup)) continue;
        matchedSet.add(dedup);

        const start = Math.max(0, m.index - 100);
        const end = Math.min(directText.length, m.index + m[0].length + 100);
        let context = '';
        if (start > 0) context += '…';
        context += directText.slice(start, m.index);
        context += `**${m[0]}**`;
        context += directText.slice(m.index + m[0].length, end);
        if (end < directText.length) context += '…';

        const rawHTML = $.html(el);
        matches.push({
          url: pageUrl,
          keyword,
          matchedText: m[0],
          selector: el.attribs?.id ? `#${el.attribs.id}` : tagName || 'unknown',
          nodeHTML: rawHTML.length > 500 ? rawHTML.slice(0, 497) + '…' : rawHTML,
          context,
          screenshotFile: null,
        });
      }
    }
  });

  return matches;
}
