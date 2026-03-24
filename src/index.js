#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { Command } from 'commander';
import { parse } from 'csv-parse/sync';
import { discoverUrls } from './discovery.js';
import { scanUrls } from './scanner.js';
import { writeJsonReport, writeCsvReport, printDiscoverySummary, printScanSummary } from './reporter.js';
import { setVerbose, normalizeUrl, log, warn, logError } from './utils.js';

// ── CSV helpers ───────────────────────────────────────────────────────────────

async function readCsv(filepath) {
  const content = await fs.readFile(filepath, 'utf-8');
  const records = parse(content, {
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  return records
    .flat()
    .map((v) => String(v).trim())
    .filter((v) => v && v.toLowerCase() !== 'url' && v.toLowerCase() !== 'keyword');
}

// ── Confirmation prompt ───────────────────────────────────────────────────────

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const program = new Command();

  program
    .name('keyword-crawler')
    .description('Crawl websites and search for keyword matches in the DOM')
    .version('1.0.0')
    // Input
    .option('--url <url>', 'Single seed URL to crawl')
    .option('--urls <file>', 'CSV file with one URL per row')
    .option('--keywords <file>', 'CSV file with keywords/phrases (required)')
    // Crawl behaviour
    .option('--concurrency <n>', 'Max concurrent pages', (v) => parseInt(v, 10), 3)
    .option('--delay <ms>', 'Delay between requests (ms)', (v) => parseInt(v, 10), 500)
    // Matching
    .option('--ignore-case', 'Case-insensitive keyword matching (default)', true)
    .option('--no-ignore-case', 'Case-sensitive keyword matching')
    .option('--selector <sel>', 'Limit search to CSS selector', 'body')
    // Output
    .option('--output <path>', 'Output directory for reports + screenshots', './results')
    .option('--screenshots', 'Capture screenshots of matched DOM elements')
    // UX
    .option('--yes', 'Skip large-site confirmation prompt')
    .option('--urls-only', 'Run Phase 1 only (discovery), skip scanning')
    .option('--verbose', 'Verbose logging');

  program.parse(process.argv);
  const opts = program.opts();

  // ── Validate inputs ──────────────────────────────────────────────────────────

  if (!opts.url && !opts.urls) {
    logError('Provide --url <url> or --urls <file>');
    process.exit(1);
  }
  if (!opts.keywords) {
    logError('Provide --keywords <file>');
    process.exit(1);
  }

  if (opts.verbose) setVerbose(true);

  // ── Load seed URLs ────────────────────────────────────────────────────────────

  let seedUrls = [];

  if (opts.url) {
    const normalized = normalizeUrl(opts.url, opts.url);
    if (!normalized) { logError(`Invalid URL: ${opts.url}`); process.exit(1); }
    seedUrls.push(normalized);
  }

  if (opts.urls) {
    const raw = await readCsv(opts.urls);
    for (const u of raw) {
      const normalized = normalizeUrl(u, u);
      if (normalized) seedUrls.push(normalized);
      else warn(`Skipping invalid URL: ${u}`);
    }
  }

  // Deduplicate
  seedUrls = [...new Set(seedUrls)];

  if (seedUrls.length === 0) {
    logError('No valid seed URLs found.');
    process.exit(1);
  }

  // ── Load keywords ─────────────────────────────────────────────────────────────

  const keywords = await readCsv(opts.keywords);
  if (keywords.length === 0) {
    logError('No keywords found in the keywords file.');
    process.exit(1);
  }

  log(`\nSeed URLs (${seedUrls.length}):`);
  for (const u of seedUrls) log(`  ${u}`);
  log(`\nKeywords (${keywords.length}): ${keywords.slice(0, 5).join(', ')}${keywords.length > 5 ? '…' : ''}`);

  const outputDir = path.resolve(opts.output);
  await fs.mkdir(outputDir, { recursive: true });

  // ── Phase 1: Discovery ────────────────────────────────────────────────────────

  const discoveryOptions = {
    output: outputDir,
    verbose: opts.verbose,
  };

  const { urls, stats } = await discoverUrls(seedUrls, discoveryOptions);

  printDiscoverySummary(stats, urls.length);

  if (opts.urlsOnly) {
    log(`\nURL list saved to: ${path.join(outputDir, 'discovered-urls.txt')}`);
    return;
  }

  // Large-site confirmation
  if (urls.length > 500 && !opts.yes) {
    const proceed = await confirm(`  Proceed? [Y/n] `);
    if (!proceed) {
      log('Aborted.');
      return;
    }
  } else {
    log('  Proceed? [Y/n] Y');
  }

  if (urls.length === 0) {
    logError('No URLs to scan.');
    return;
  }

  // ── Phase 2: Scanning ─────────────────────────────────────────────────────────

  log(`\n── Phase 2: Scanning ──`);

  const scanOptions = {
    concurrency: opts.concurrency,
    delay: opts.delay,
    ignoreCase: opts.ignoreCase,
    selector: opts.selector,
    screenshots: opts.screenshots || false,
    output: outputDir,
    verbose: opts.verbose,
  };

  const { matches, errors } = await scanUrls(urls, keywords, scanOptions);

  // ── Write reports ─────────────────────────────────────────────────────────────

  const meta = {
    seedUrls,
    totalKeywords: keywords.length,
    discovery: {
      sitemapUrls: stats.sitemapUrls,
      totalUniqueUrls: stats.totalUniqueUrls,
      filteredOut: stats.filteredOut,
      urlsScanned: urls.length,
    },
    totalMatches: matches.length,
    options: {
      concurrency: opts.concurrency,
      delay: opts.delay,
      ignoreCase: opts.ignoreCase,
      screenshots: opts.screenshots || false,
      selector: opts.selector,
    },
  };

  await writeJsonReport(outputDir, meta, matches, errors);
  await writeCsvReport(outputDir, matches);

  printScanSummary(urls.length, matches, errors, outputDir, opts.screenshots, keywords.length);
}

main().catch((err) => {
  logError('Fatal error:', err.message);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
