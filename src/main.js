/**
 * ============================================================================
 *  LinkedIn Job Scraper — Keyword Mode (Guest API, High-Throughput, Stealth)
 *  main.js  (NO external queue deps; works on Apify base images)
 * ============================================================================
 */

import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

// ------------------------------- Constants ----------------------------------

const TPR_MAP = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };

// Rotated per request
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
];

const DEFAULT_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'cache-control': 'no-cache',
};

// --------------------------------- Utils ------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => Math.random() * (max - min) + min;

const pick = (s) => (s || '').trim() || null;
const abs = (href) => (href?.startsWith('http') ? href : new URL(href, 'https://www.linkedin.com').toString());
const getJobId = (u) => (u?.match(/\b(\d{8,})\b/) || [])[1] || null;

const textOf = ($, sel) => pick($(sel).first().text());
const hrefOf = ($, sel) => {
  const h = $(sel).first().attr('href');
  return h ? abs(h) : null;
};

const validateLocation = (locationText, companyName) => {
  if (!locationText) return null;
  const cleaned = locationText.trim();
  if (!cleaned) return null;
  if (companyName && cleaned.toLowerCase() === companyName.toLowerCase()) return null;
  const suffixes = /\b(inc\.?|llc\.?|ltd\.?|corp\.?|corporation|company|co\.?|group|solutions|technologies|tech|systems|services|enterprises|holdings|international|global|worldwide)\b/i;
  if (suffixes.test(cleaned)) return null;
  if (cleaned.length < 2 || /^[A-Z]{2,}$/.test(cleaned)) return null;
  return cleaned;
};

// -------------------------------- Input -------------------------------------

const normalizeInput = (input) => {
  const {
    keywords, keyword, query,
    location, timeRange, posted_date,
    maxJobs, results_wanted,
    maxConcurrency,
    proxyConfiguration,
  } = input || {};

  const kws = (Array.isArray(keywords) && keywords.length)
    ? keywords
    : (keyword ? [keyword] : (query ? [query] : []));

  if (!kws.length) {
    throw new Error('Provide at least one keyword via "keywords" (array) or "keyword"/"query" (string).');
  }

  return {
    keywords: kws.filter(Boolean).map((s) => s.trim()).filter(Boolean),
    location: (location || '').trim(),
    timeRange: (timeRange || posted_date || 'anytime').toLowerCase(),
    maxJobs: Math.max(1, Math.min(10000, Number(maxJobs) || Number(results_wanted) || 300)),
    maxConcurrency: Math.max(4, Math.min(48, Number(maxConcurrency) || 24)),
    proxyConfiguration,
  };
};

// ------------------------------- Networking ---------------------------------

const buildGuestListParams = (kw, loc, time) => {
  const p = new URLSearchParams();
  if (kw) p.set('keywords', kw);
  if (loc) p.set('location', loc);
  if (time && time !== 'anytime') p.set('f_TPR', TPR_MAP[time] || '');
  p.set('sortBy', 'R'); // recency
  return p;
};

const guestListUrl = (params, start) => {
  const p = new URLSearchParams(params);
  p.set('start', String(start));
  // harmless tracker param to vary the URL and reduce edge-caching patterns
  p.set('trk', 'public_jobs_jserp-result');
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
};

const guestDetailUrl = (jobId) =>
  `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;

const fetchPage = async (url, proxyUrl) => {
  const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  await sleep(rnd(60, 180)); // tiny jitter
  const res = await gotScraping({
    url,
    headers: { ...DEFAULT_HEADERS, referer: 'https://www.linkedin.com/jobs/search/', 'user-agent': ua },
    proxyUrl,
    timeout: { request: 18000 },
    retry: { limit: 1 },
  });
  if (res.statusCode >= 200 && res.statusCode < 300) return res.body || '';
  throw new Error(`Bad status: ${res.statusCode}`);
};

const extractJobIdsFromListHtml = (html) => {
  const $ = cheerio.load(html);
  const ids = new Set();

  // Primary: base-card URN
  $('div.base-card').each((_, el) => {
    const urn = $(el).attr('data-entity-urn');
    const id = urn?.match(/\d{8,}/)?.[0];
    if (id) ids.add(id);
  });

  // Common: any jobs/view link
  $('a[href*="jobs/view"]').each((_, el) => {
    const id = getJobId($(el).attr('href'));
    if (id) ids.add(id);
  });

  // Raw fallback (handles minimal HTML)
  const m = html.match(/\bjobs\/view\/(\d{8,})/g) || [];
  for (const t of m) {
    const id = getJobId(t);
    if (id) ids.add(id);
  }

  return Array.from(ids);
};

// --------------------------- Extraction (Selectors) --------------------------

const extractDescription = ($) => {
  // Keep common containers used across your codebase
  const containers = [
    'div.show-more-less-html__markup',
    'div.description__text',
    'section.show-more-less-html',
    'div.jobs-description__content',
    'article.jobs-description',
  ];
  for (const sel of containers) {
    const node = $(sel).first();
    if (node && node.length) {
      const html = node.html();
      const text = pick(node.text());
      if (text && text.length > 30) return { html, text };
    }
  }
  return { html: null, text: null };
};

const extractJobData = ($, url, ctx) => {
  const title = textOf($, 'h2.top-card-layout__title, h1.top-card-layout__title, h2.topcard__title');
  const company = textOf($, 'a.topcard__org-name-link, div.topcard__org-name-link, span.topcard__flavor');
  const companyUrl = hrefOf($, 'a.topcard__org-name-link');

  let location = null;
  for (const s of [
    'span.topcard__flavor--bullet',
    'span.job-result-card__location',
    'div.topcard__flavor-row span:not(.topcard__org-name-link)',
    'span.topcard__flavor:not(:first-child)',
    'span.topcard__flavor',
  ]) {
    const v = validateLocation(textOf($, s), company);
    if (v) { location = v; break; }
  }

  const postedAt = textOf($, 'span.posted-time-ago__text, span.topcard__flavor--metadata');

  let seniority = null, workType = null;
  $('li.description__job-criteria-item').each((_, li) => {
    const h = $(li).find('h3').text().toLowerCase();
    const val = pick($(li).find('span.description__job-criteria-text').text());
    if (h.includes('seniority') || h.includes('level')) seniority = val;
    if (h.includes('employment') || h.includes('type')) workType = val;
  });

  const { html: descriptionHtml, text: descriptionText } = extractDescription($);

  return {
    jobUrl: url,
    jobId: getJobId(url),
    title, company, companyUrl,
    location, postedAt, workType, seniority,
    descriptionHtml, descriptionText,
    collectedAt: new Date().toISOString(),
    searchQuery: ctx.searchQuery || '',
    searchLocation: ctx.searchLocation || '',
    searchTimeRange: ctx.searchTimeRange || 'anytime',
  };
};

// --------------------------- Lightweight Task Pool ---------------------------
/**
 * Simple dependency-free pool with:
 *  - max concurrency
 *  - per-interval cap (token bucket)
 *  - optional proxy rotation callback on failure streaks
 */
class TaskPool {
  constructor({ concurrency, intervalMs, intervalCap }) {
    this.concurrency = Math.max(1, concurrency || 8);
    this.intervalMs = intervalMs || 1000;
    this.intervalCap = Math.max(1, intervalCap || this.concurrency);
    this.running = 0;
    this.queue = [];
    this.timestamps = []; // start times within the current interval window
    this.idleResolvers = [];
  }

  _pruneWindow(now) {
    while (this.timestamps.length && now - this.timestamps[0] > this.intervalMs) {
      this.timestamps.shift();
    }
  }

  async _takeSlot() {
    while (true) {
      const now = Date.now();
      this._pruneWindow(now);
      if (this.running < this.concurrency && this.timestamps.length < this.intervalCap) {
        this.running++;
        this.timestamps.push(now);
        return;
      }
      // wait a bit and try again
      await sleep(30);
    }
  }

  _release() {
    this.running--;
    // drain queued tasks
    this._drain();
    // resolve idle if no work
    if (this.running === 0 && this.queue.length === 0) {
      this.idleResolvers.splice(0).forEach((r) => r());
    }
  }

  _drain() {
    while (this.queue.length && this.running < this.concurrency) {
      const task = this.queue.shift();
      task();
    }
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        try {
          await this._takeSlot();
          const res = await fn();
          resolve(res);
        } catch (e) {
          reject(e);
        } finally {
          this._release();
        }
      };
      this.queue.push(run);
      this._drain();
    });
  }

  onIdle() {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }
}

// ------------------------------- Runner -------------------------------------

await Actor.init();

const raw = (await Actor.getInput()) || {};
const {
  keywords, location, timeRange, maxJobs,
  maxConcurrency, proxyConfiguration,
} = normalizeInput(raw);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

// Use a stable proxy URL per phase; rotate on streak failures
let currentProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
let failureStreak = 0;

const allJobIds = new Set();
const ctxById = Object.create(null);
let pagesFetched = 0;

log.info(`🔎 Keywords: ${keywords.join(' | ')} | Location: "${location}" | Time: ${timeRange}`);
log.info(`🎯 Target jobs: ${maxJobs} | Concurrency: ${maxConcurrency}`);

// ------------------------ LIST: Collect IDs per keyword ----------------------

for (const kw of keywords) {
  if (allJobIds.size >= maxJobs) break;

  const params = buildGuestListParams(kw, location, timeRange);
  let start = 0;
  let pageStreakWithoutNew = 0;

  while (allJobIds.size < maxJobs) {
    const url = guestListUrl(params, start);
    let html = '';

    try {
      html = await fetchPage(url, currentProxyUrl);
      pagesFetched++;
      failureStreak = 0;
    } catch (e) {
      failureStreak++;
      log.warning(`List fetch error (start=${start}, kw="${kw}"): ${e.message}`);
      await sleep(rnd(350, 900));
      if (proxyConfig && failureStreak >= 3) {
        currentProxyUrl = await proxyConfig.newUrl();
        failureStreak = 0;
        log.info('🔁 Rotated proxy for list fetches due to failures.');
      }
    }

    const ids = extractJobIdsFromListHtml(html);
    let newlyAdded = 0;

    for (const id of ids) {
      if (!allJobIds.has(id)) {
        allJobIds.add(id);
        if (!ctxById[id]) ctxById[id] = { searchQuery: kw, searchLocation: location, searchTimeRange: timeRange };
        newlyAdded++;
        if (allJobIds.size >= maxJobs) break;
      }
    }

    log.info(`[${kw}] start=${start} → page=${ids.length}, new=${newlyAdded}, total=${allJobIds.size}/${maxJobs}`);

    pageStreakWithoutNew = newlyAdded === 0 ? pageStreakWithoutNew + 1 : 0;
    if (ids.length === 0 || pageStreakWithoutNew >= 2) break;

    start += 25; // LinkedIn page step
    await sleep(rnd(140, 320));
  }
}

log.info(`📄 Pages fetched: ${pagesFetched} | Unique IDs: ${allJobIds.size}`);

// ----------------------- DETAIL: Parallel fetch + parse ----------------------

const idsList = Array.from(allJobIds);

// Token bucket-ish pacing: per-second cap ≈ 1.6x concurrency (tunable)
const pool = new TaskPool({
  concurrency: maxConcurrency,
  intervalMs: 1000,
  intervalCap: Math.max(10, Math.floor(maxConcurrency * 1.6)),
});

let processed = 0;
let detailFailures = 0;
let detailProxyUrl = currentProxyUrl;

const runDetail = async (jobId) => {
  const url = guestDetailUrl(jobId);

  try {
    const html = await fetchPage(url, detailProxyUrl);
    const $ = cheerio.load(html);
    let record = extractJobData($, url, ctxById[jobId] || {});

    if (!record.title) {
      await sleep(rnd(120, 300));
      const html2 = await fetchPage(url, detailProxyUrl);
      const $2 = cheerio.load(html2);
      record = extractJobData($2, url, ctxById[jobId] || {});
    }

    await Dataset.pushData(record);
    processed++;
    if (processed % 25 === 0) log.info(`✓ Processed ${processed}/${idsList.length}`);
  } catch (e) {
    detailFailures++;
    log.debug(`Detail error ${jobId}: ${e.message}`);
    if (detailFailures % 12 === 0 && proxyConfig) {
      detailProxyUrl = await proxyConfig.newUrl();
      log.info('🔁 Rotated proxy for detail fetches due to failures.');
    }
    // brief cooldown on repeated errors
    if (detailFailures % 8 === 0) await sleep(rnd(600, 1400));
  }
};

// Enqueue
for (const id of idsList) {
  if (processed >= maxJobs) break;
  pool.add(() => runDetail(id));
}

// Wait for all to finish
await pool.onIdle();

// Final log + exit
log.info(`✅ Done. Jobs pushed: ${processed} | Failures: ${detailFailures} | Requested: ${maxJobs}`);
await Actor.exit();
