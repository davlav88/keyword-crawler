import fs from 'fs/promises';
import path from 'path';
import { log } from './utils.js';

// ── JSON report ───────────────────────────────────────────────────────────────

export async function writeJsonReport(outputDir, meta, matches, errors) {
  const report = {
    meta: {
      runDate: new Date().toISOString(),
      ...meta,
    },
    matches,
    errors,
  };

  const filepath = path.join(outputDir, 'report.json');
  await fs.writeFile(filepath, JSON.stringify(report, null, 2), 'utf-8');
  return filepath;
}

// ── CSV report ────────────────────────────────────────────────────────────────

function escapeCsv(val) {
  if (val == null) return '';
  const str = String(val);
  // If contains comma, quote, or newline — wrap in quotes and escape inner quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCsv(values) {
  return values.map(escapeCsv).join(',');
}

export async function writeCsvReport(outputDir, matches) {
  const header = rowToCsv(['url', 'keyword', 'matchedText', 'selector', 'context', 'screenshotFile']);
  const rows = matches.map((m) =>
    rowToCsv([m.url, m.keyword, m.matchedText, m.selector, m.context, m.screenshotFile ?? '']),
  );

  const content = [header, ...rows].join('\n') + '\n';
  const filepath = path.join(outputDir, 'report.csv');
  await fs.writeFile(filepath, content, 'utf-8');
  return filepath;
}

// ── Console summary ────────────────────────────────────────────────────────────

export function printDiscoverySummary(stats, urlsToScan) {
  log('\n── Phase 1: Discovery ──');
  log(`  Sitemap URLs found: ${stats.sitemapUrls}`);
  log(`  Crawled URLs found: ${stats.crawledUrls}`);
  log(`  Total unique URLs:  ${stats.totalUniqueUrls}`);
  log(`  Filtered out:       ${stats.filteredOut} (non-HTML / off-domain)`);
  log(`  URLs to scan:       ${urlsToScan}`);
}

export function printScanSummary(total, matches, errors, outputDir, screenshotsEnabled) {
  const screenshotCount = matches.filter((m) => m.screenshotFile).length;
  log('\n── Phase 2: Scanning ──');
  log(`  [${total}/${total}] Scanning complete`);
  log(`  Total matches:      ${matches.length}`);
  log(`  Errors:             ${errors.length}`);
  log('\n✓ Done');
  log(`  Report: ${path.join(outputDir, 'report.json')}`);
  log(`  CSV:    ${path.join(outputDir, 'report.csv')}`);
  if (screenshotsEnabled) {
    log(`  Screenshots: ${path.join(outputDir, 'screenshots')}/ (${screenshotCount} files)`);
  }
}
