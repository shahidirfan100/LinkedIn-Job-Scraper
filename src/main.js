/**
 * ============================================================================
 *  LinkedIn Job Scraper — Keyword Mode (Guest API, FAST + STEALTH)
 *  main.js
 *  - Guest list:   /jobs-guest/jobs/api/seeMoreJobPostings/search
 *  - Guest detail: /jobs-guest/jobs/api/jobPosting/{jobId}
 *  - Parallel list pagination + immediate detail pipeline
 *  - Honors maxJobs exactly (with bounded retries)
 *  - No external dependencies
 * ============================================================================
 */
import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

// ------------------------------- Constants ----------------------------------

const TPR_MAP = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => Math.random() * (max - min) + min;
const pick = (s) => (s || '').trim() || null;
const abs = (href) => (href?.startsWith('http') ? href : new URL(href, 'https://www.linkedin.com').toString());
const getJobId = (u) => (u?.match(/\b(\d{8,})\b/) || [])[1] || null;

// ------------------------------- Input --------------------------------------

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
    maxConcurrency: Math.max(6, Math.min(48, Number(maxConcurrency) || 24)),
    proxyConfiguration,
  };
};

// ---------------------------- Guest Endpoints --------------------------------

const buildGuestListParams = (kw, loc, time) => {
  const p = new URLSearchParams();
  if (kw) p.set('keywords', kw);
  if (loc) p.set('location', loc);
  if (time && time !== 'anytime') p.set('f_TPR', TPR_MAP[time] || '');
  p.set('sortBy', 'R');
  return p;
};

const guestListUrl = (params, start) => {
  const p = new URLSearchParams(params);
  p.set('start', String(start));
  p.set('trk', 'public_jobs_jserp-result');
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
};

const guestDetailUrl = (jobId) =>
  `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;

const fetchPage = async (url, proxyUrl) => {
  const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  // very small jitter to de-sync
  await sleep(rnd(20, 60));
  const res = await gotScraping({
    url,
    headers: { ...DEFAULT_HEADERS, referer: 'https://www.linkedin.com/jobs/search/', 'user-agent': ua },
    proxyUrl,
    timeout: { request: 16000 },
    retry: { limit: 1 },
  });
  if (res.statusCode >= 200 && res.statusCode < 300) return res.body || '';
  throw new Error(`Bad status: ${res.statusCode}`);
};

const extractJobIdsFromListHtml = (html) => {
  const $ = cheerio.load(html);
  const ids = new Set();

  $('div.base-card').each((_, el) => {
    const urn = $(el).attr('data-entity-urn');
    const id = urn?.match(/\d{8,}/)?.[0];
    if (id) ids.add(id);
  });

  $('a[href*="jobs/view"]').each((_, el) => {
    const id = getJobId($(el).attr('href'));
    if (id) ids.add(id);
  });

  const m = html.match(/\bjobs\/view\/(\d{8,})/g) || [];
  for (const t of m) {
    const id = getJobId(t);
    if (id) ids.add(id);
  }

  return Array.from(ids);
};

// ----------------------------- Extraction -----------------------------------

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

const extractDescription = ($) => {
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

// ------------------------------- State --------------------------------------

const collectedIds = new Set();            // all discovered jobIds
const enqueuedDetail = new Set();          // jobIds with a DETAIL request enqueued
const completedDetail = new Set();         // jobIds successfully pushed
const ctxById = Object.create(null);       // best-effort search context per id

let failureStreakList = 0;
let failureStreakDetail = 0;

// ------------------------------- Runner -------------------------------------

await Actor.init();

const raw = (await Actor.getInput()) || {};
const {
  keywords, location, timeRange, maxJobs,
  maxConcurrency, proxyConfiguration,
} = normalizeInput(raw);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
// fix a proxy per short window; rotate only on streak failures
let listProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
let detailProxyUrl = listProxyUrl;

log.info(`🔎 Keywords: ${keywords.join(' | ')} | Location: "${location}" | Time: ${timeRange}`);
log.info(`🎯 Target jobs: ${maxJobs} | Concurrency: ${maxConcurrency}`);

// Core crawler used only as a scheduler + HTML parser for guest endpoints
const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  maxConcurrency,
  minConcurrency: Math.max(3, Math.floor(maxConcurrency / 2)),
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 25,
  navigationTimeoutSecs: 25,

  preNavigationHooks: [
    async ({ request }) => {
      // set lightweight headers per request
      request.headers = { ...DEFAULT_HEADERS, referer: 'https://www.linkedin.com/jobs/search/' };
      // tiny jitter to avoid bursts
      await sleep(rnd(10, 40));
    },
  ],

  requestHandler: async (ctx) => {
    const { request, $, addRequests } = ctx;

    // Early exit if we’ve already hit the target
    if (completedDetail.size >= maxJobs) return;

    if (request.userData.label === 'LIST') {
      // Extract ids
      const ids = new Set();

      $('div.base-card').each((_, el) => {
        const urn = $(el).attr('data-entity-urn');
        const id = urn?.match(/\d{8,}/)?.[0];
        if (id) ids.add(id);
      });
      $('a[href*="jobs/view"]').each((_, el) => {
        const id = getJobId($(el).attr('href'));
        if (id) ids.add(id);
      });
      const m = request.loadedUrl?.match(/\bjobs\/view\/(\d{8,})/g) || [];
      for (const t of m) {
        const id = getJobId(t);
        if (id) ids.add(id);
      }

      let newCount = 0;
      const ctxInfo = request.userData.searchContext;

      for (const id of ids) {
        if (completedDetail.size >= maxJobs) break;

        if (!collectedIds.has(id)) {
          collectedIds.add(id);
          if (!ctxById[id]) ctxById[id] = ctxInfo;
          newCount++;
        }

        // Immediately enqueue detail if not already
        if (!enqueuedDetail.has(id) && completedDetail.size < maxJobs) {
          enqueuedDetail.add(id);
          await addRequests([{
            url: guestDetailUrl(id),
            userData: { label: 'DETAIL', jobId: id },
            priority: 5,
          }]);
        }
      }

      log.info(`LIST start=${request.userData.start} | pageIds=${ids.size} | new=${newCount} | totalFound=${collectedIds.size} | pushed=${completedDetail.size}/${maxJobs}`);

      // If still under target, fan out next list pages for this keyword
      if (completedDetail.size < maxJobs) {
        const nextStart = (request.userData.start || 0) + 25;
        const params = request.userData.params;
        const nextUrl = guestListUrl(params, nextStart);
        await addRequests([{
          url: nextUrl,
          userData: { label: 'LIST', start: nextStart, params, searchContext: ctxInfo },
          priority: 8,
        }]);
      }

      return;
    }

    // ------------------------ DETAIL ------------------------
    if (request.userData.label === 'DETAIL') {
      const jobId = request.userData.jobId || getJobId(request.url);
      if (!jobId) return;

      // If we already stored it (possible retry), skip
      if (completedDetail.has(jobId)) return;

      // Parse detail HTML already loaded by crawler:
      let $html = $;

      // If content looks thin, re-fetch via gotScraping to avoid stale cache
      const short = !$html || !$html('*').length || pick($html.text() || '').length < 40;
      if (short) {
        try {
          const html = await fetchPage(request.url, detailProxyUrl);
          $html = cheerio.load(html);
        } catch (e) {
          // Defer retry via crawl retry; do not mark completed
          throw e;
        }
      }

      const record = extractJobData($html, request.url, ctxById[jobId] || {});
      if (!record.title && request.retryCount < 1) {
        // Force one re-fetch attempt if title missing
        const html = await fetchPage(request.url, detailProxyUrl);
        const $2 = cheerio.load(html);
        const rec2 = extractJobData($2, request.url, ctxById[jobId] || {});
        if (rec2.title) Object.assign(record, rec2);
      }

      await Dataset.pushData(record);
      completedDetail.add(jobId);

      if (completedDetail.size % 25 === 0 || completedDetail.size === maxJobs) {
        log.info(`✓ Completed ${completedDetail.size}/${maxJobs}`);
      }
      return;
    }
  },

  failedRequestHandler: async ({ request, error }, err2) => {
    const lbl = request.userData.label;
    if (lbl === 'LIST') {
      failureStreakList++;
      if (failureStreakList % 3 === 0 && proxyConfig) {
        listProxyUrl = await proxyConfig.newUrl();
        log.info('🔁 Rotated proxy for LIST streak failures.');
      }
    } else if (lbl === 'DETAIL') {
      failureStreakDetail++;
      if (failureStreakDetail % 6 === 0 && proxyConfig) {
        detailProxyUrl = await proxyConfig.newUrl();
        log.info('🔁 Rotated proxy for DETAIL streak failures.');
      }
      // If a detail failed and we’re still under target, re-enqueue once
      const jobId = request.userData.jobId || getJobId(request.url);
      if (jobId && !completedDetail.has(jobId) && request.retryCount < 1) {
        await crawler.addRequests([{
          url: guestDetailUrl(jobId),
          userData: { label: 'DETAIL', jobId },
          priority: 6,
        }]);
      }
    }

    log.warning(`Request failed [${lbl}] ${request.url.slice(0, 120)} — ${error?.message || err2?.message || 'error'}`);
    // Small cooldown on heavy bursts
    await sleep(rnd(200, 600));
  },
});

// ------------------------ Seed initial LIST pages (parallel) -----------------

const seedRequests = [];
for (const kw of keywords) {
  const params = buildGuestListParams(kw, location, timeRange);
  const ctxInfo = { searchQuery: kw, searchLocation: location, searchTimeRange: timeRange };

  // aggressively pre-enqueue several pages per keyword up-front (fast start)
  // We'll enqueue up to the amount needed to satisfy maxJobs, capped to 12 pages/kw.
  const pagesNeeded = Math.ceil(Math.min(maxJobs, 600) / 25); // up to first 600 items/kw
  const pagesToKick = Math.min(12, pagesNeeded);              // cap initial burst

  for (let i = 0; i < pagesToKick; i++) {
    const start = i * 25;
    const url = guestListUrl(params, start);
    seedRequests.push({
      url,
      userData: { label: 'LIST', start, params, searchContext: ctxInfo },
      priority: 9,
    });
  }
}

// Start fast: many LIST pages at once; details pipeline begins immediately
await crawler.addRequests(seedRequests);
await crawler.run();

// If we somehow ended below the target due to transient fails, do a brief mop-up:
// (Re-enqueue remaining details that were discovered but not completed)
if (completedDetail.size < maxJobs) {
  const remaining = Array.from(collectedIds).filter((id) => !completedDetail.has(id));
  const take = Math.max(0, Math.min(maxJobs - completedDetail.size, remaining.length));
  const extra = remaining.slice(0, take).map((id) => ({
    url: guestDetailUrl(id),
    userData: { label: 'DETAIL', jobId: id },
    priority: 6,
  }));
  if (extra.length) {
    log.info(`Mop-up: re-enqueueing ${extra.length} remaining details to hit target ${maxJobs}.`);
    await crawler.addRequests(extra);
    await crawler.run();
  }
}

log.info(`✅ Done. Jobs pushed: ${completedDetail.size} / ${maxJobs}`);
await Actor.exit();
