# keyword-crawler

A Node.js CLI tool that crawls websites, searches page content for keywords/phrases, and outputs structured results including the exact DOM location and optional screenshots of matched nodes.

## Requirements

- Node.js ≥ 18
- npm

## Installation

```bash
git clone https://github.com/davlav88/keyword-crawler.git
cd keyword-crawler
npm install
```

## Usage

```bash
node src/index.js [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--url <url>` | — | Single seed URL to crawl |
| `--urls <file>` | — | CSV file with one URL per row |
| `--keywords <file>` | — | CSV file with keywords/phrases **(required)** |
| `--concurrency <n>` | `3` | Max concurrent pages |
| `--delay <ms>` | `500` | Delay between requests (polite crawling) |
| `--ignore-case` / `--no-ignore-case` | `true` | Case-insensitive matching |
| `--selector <sel>` | `body` | Limit search to a CSS selector (e.g. `main`, `.content`) |
| `--output <path>` | `./results` | Output directory for reports and screenshots |
| `--screenshots` | `false` | Capture screenshots of matched DOM elements |
| `--yes` | `false` | Skip confirmation prompt on large sites (>500 URLs) |
| `--urls-only` | `false` | Run discovery only — no keyword scanning |
| `--verbose` | `false` | Verbose logging |

### Input file formats

**URLs CSV** (`--urls`): one URL per row, no header required (a `url` header is tolerated).

```
https://example.com
https://example.com/blog
```

**Keywords CSV** (`--keywords`): one keyword or phrase per row, no header required.

```
free consultation
book now
contact us
```

## Examples

```bash
# Single URL + keywords, with screenshots
node src/index.js --url https://example.com/blog --keywords ./keywords.csv --screenshots

# Multiple seed URLs, deeper crawl, higher concurrency
node src/index.js --urls ./sites.csv --keywords ./keywords.csv --depth 5 --concurrency 5

# Scope search to main content, custom output dir
node src/index.js --url https://example.com --keywords ./kw.csv --selector "main" --output ./audit-results

# Discovery only — preview what will be crawled
node src/index.js --url https://example.com --keywords ./kw.csv --urls-only

# Skip confirmation on large sites, verbose logging
node src/index.js --url https://example.com --keywords ./kw.csv --yes --verbose
```

## How it works

### Phase 1 — Discovery

Builds a URL inventory exclusively from the site's declared sitemap — no link crawling, no undeclared pages:

1. Checks `robots.txt` for `Sitemap:` directives
2. Fetches `sitemap.xml` (falls back to `/sitemap.xml` if robots.txt has none)
3. Recursively resolves sitemap index files and `.xml.gz` compressed sitemaps
4. Normalizes and deduplicates all `<loc>` URLs, filters out non-HTML resources
5. Saves the full URL list to `<output>/discovered-urls.txt`

### Phase 2 — Scanning

Visits every discovered URL in parallel and searches for keyword matches:

- Uses **Puppeteer** for JS-rendered pages with a shared browser instance
- Falls back to **Cheerio** static HTML parsing if Puppeteer evaluation fails
- Matches keywords against visible text content (not raw HTML)
- Generates precise CSS selectors for each matched element (preferring IDs and classes over nth-child)
- Optionally captures element-level screenshots for every match

## Output

All output is written to `--output` (default: `./results`):

| File | Description |
|---|---|
| `report.json` | Full structured report with metadata, all matches, and errors |
| `report.csv` | Flat CSV summary — one row per match |
| `discovered-urls.txt` | Full list of URLs found in Phase 1 |
| `screenshots/` | PNG screenshots of matched elements (when `--screenshots` is enabled) |

### report.json structure

```json
{
  "meta": {
    "runDate": "2026-03-24T14:30:00Z",
    "seedUrls": ["https://example.com/blog"],
    "totalKeywords": 5,
    "discovery": {
      "sitemapUrls": 132,
      "crawledUrls": 41,
      "totalUniqueUrls": 156,
      "filteredOut": 17,
      "urlsScanned": 139
    },
    "totalMatches": 23,
    "options": { "depth": 3, "concurrency": 3, "delay": 500, "ignoreCase": true, "screenshots": true, "selector": "body" }
  },
  "matches": [
    {
      "url": "https://example.com/blog/post-1",
      "keyword": "free consultation",
      "matchedText": "Free Consultation",
      "selector": "main > section.cta > h2",
      "nodeHTML": "<h2 class=\"cta-title\">Book Your Free Consultation Today</h2>",
      "context": "...ready to start? **Book Your Free Consultation** Today...",
      "screenshotFile": "screenshots/a3f8c1-free-consultation-0.png"
    }
  ],
  "errors": [
    { "url": "https://example.com/broken", "error": "HTTP 404" }
  ]
}
```

### report.csv columns

`url`, `keyword`, `matchedText`, `selector`, `context`, `screenshotFile`

## Architecture

```
src/
├── index.js          CLI entry point (Commander, validation, orchestration)
├── discovery.js      Phase 1: sitemap parsing + link crawling
├── scanner.js        Phase 2: Puppeteer work queue + page loading
├── matcher.js        DOM keyword search (browser-side) + Cheerio fallback
├── screenshotter.js  Element screenshot capture
├── reporter.js       JSON + CSV output generation
└── utils.js          URL normalization, filtering, logging, concurrency queue
```
