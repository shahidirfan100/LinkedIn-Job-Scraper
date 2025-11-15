/**
 * ============================================================================
 *  LinkedIn Job Scraper — Keyword Mode (Guest API, FAST + STEALTH)
 *  main.js (Complete)
 *  - Guest list:   /jobs-guest/jobs/api/seeMoreJobPostings/search
 *  - Guest detail: /jobs-guest/jobs/api/jobPosting/{jobId}
 *  - Parallel list pagination + immediate detail pipeline
 *  - Honors maxJobs exactly (bounded retries + mop-up)
 *  - Handles application/octet-stream responses (CheerioCrawler MIME fix)
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

const CH_UA_POOL = [
  '"Chromium";v="127", "Not;A Brand";v="99"',
  '"Google Chrome";v="127", "Not;A Brand";v="99"',
  '"Microsoft Edge";v="127", "Not;A Brand";v="99"',
];

const ACCEPT_LANGUAGE_POOL = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.8,fr;q=0.7',
  'en-US,en;q=0.8,es;q=0.6',
];

// --------------------------------- Utils ------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => Math.random() * (b - a) + a;
const pick = (s) => (s || '').trim() || null;
const abs = (href) => (href?.startsWith('http') ? href : new URL(href, 'https://www.linkedin.com').toString());
const getJobId = (u) => (u?.match(/\b(\d{8,})\b/) || [])[1] || null;

const textOf = ($, sel) => pick($(sel).first().text());
const hrefOf = ($, sel) => { const h = $(sel).first().attr('href'); return h ? abs(h) : null; };

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

// ---------------------------- Guest Endpoints --------------------------------

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
  p.set('trk', 'public_jobs_jserp-result'); // harmless tracker to vary URL
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
};

const guestDetailUrl = (id) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;

const fetchPage = async (url, proxyUrl) => {
  const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const secChUa = CH_UA_POOL[Math.floor(Math.random() * CH_UA_POOL.length)];
  const acceptLang = ACCEPT_LANGUAGE_POOL[Math.floor(Math.random() * ACCEPT_LANGUAGE_POOL.length)];
  await sleep(rnd(20, 60)); // tiny jitter
  const res = await gotScraping({
    url,
    headers: { ...DEFAULT_HEADERS, referer: 'https://www.linkedin.com/jobs/search/', 'user-agent': ua, 'sec-ch-ua': secChUa, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'accept-language': acceptLang },
    proxyUrl,
    timeout: { request: 16000 },
    retry: { limit: 1 },
  });
  log.debug(`Fetch ${url.slice(0, 140)} | code=${res.statusCode} | len=${(res.body || '').length}`);
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

  // Links with jobs/view
  $('a[href*="jobs/view"]').each((_, el) => {
    const id = getJobId($(el).attr('href'));
    if (id) ids.add(id);
  });

  // Fallback regex
  const m = html.match(/\bjobs\/view\/(\d{8,})/g) || [];
  for (const t of m) {
    const id = getJobId(t);
    if (id) ids.add(id);
  }

  return Array.from(ids);
};

// ----------------------------- Extraction -----------------------------------

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

  let seniority = null, jobType = null;
  $('li.description__job-criteria-item').each((_, li) => {
    const h = $(li).find('h3').text().toLowerCase();
    const val = pick($(li).find('span.description__job-criteria-text').text());
    if (h.includes('seniority') || h.includes('level')) seniority = val;
    if (h.includes('employment') || h.includes('type')) jobType = val;
  });

  const { html: descriptionHtml, text: descriptionText } = extractDescription($);

  // Salary: LinkedIn uses multiple selectors; collect best available
  let salary = null;
  for (const s of ['span.salary', 'div.salary', 'span.compensation', 'li.salary', 'span.salary-text', 'div.compensation']) {
    const v = pick($(s).first().text());
    if (v && v.length > 2) { salary = v; break; }
  }

  // URNs are useful for dedup and linking to internal objects
  const html = $.html();
  const companyUrn = (html.match(/urn:li:fs_normalized_company:[^"\s>]+/) || [])[0] || null;
  const jobPostingUrn = (html.match(/urn:li:jobPosting:\d+/) || [])[0] || null;

  return {
    jobUrl: url,
    jobId: getJobId(url),
    title, company, companyUrl,
    location, postedAt, jobType, seniority, salary,
    descriptionHtml, descriptionText,
    companyUrn, jobPostingUrn,
    collectedAt: new Date().toISOString(),
    searchQuery: ctx.searchQuery || '',
    searchLocation: ctx.searchLocation || '',
    searchTimeRange: ctx.searchTimeRange || 'anytime',
  };
};

const isBlockedHtml = (html) => {
  if (!html) return true;
  const s = html.toLowerCase();
  // Indicators of blocked/guest pages or sign-in gate
  if (s.includes('sign in') && s.includes('linkedin')) return true;
  if (s.includes('access denied') || s.includes('too many requests') || s.includes('captcha')) return true;
  // Empty listings on job pages are abnormal
  if (s.length < 500) return true;
  return false;
};

const makeRequestHeaders = (referer = 'https://www.linkedin.com/jobs/search/') => {
  const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const secChUa = CH_UA_POOL[Math.floor(Math.random() * CH_UA_POOL.length)];
  const acceptLang = ACCEPT_LANGUAGE_POOL[Math.floor(Math.random() * ACCEPT_LANGUAGE_POOL.length)];

  return {
    ...DEFAULT_HEADERS,
    referer,
    'user-agent': ua,
    'accept-language': acceptLang,
    'sec-ch-ua': secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
};

// ------------------------------- State --------------------------------------

const collectedIds = new Set();      // discovered job IDs
const enqueuedDetail = new Set();    // detail requests enqueued
const completedDetail = new Set();   // details pushed to dataset
const ctxById = Object.create(null); // per-id search context

let failureStreakList = 0;
let failureStreakDetail = 0;

// ------------------------------- Runner -------------------------------------

await Actor.init();

const raw = (await Actor.getInput()) || {};
const {
  keywords, keyword, query,
  location, timeRange, posted_date,
  maxJobs: IN_maxJobs, results_wanted,
  maxConcurrency: IN_maxConcurrency,
  proxyConfiguration,
} = raw;

const keywordsArr = (Array.isArray(keywords) && keywords.length)
  ? keywords
  : (keyword ? [keyword] : (query ? [query] : []));

if (!keywordsArr.length) throw new Error('Provide at least one keyword via "keywords" (array) or "keyword"/"query" (string).');

const locationStr = (location || '').trim();
const timeRangeStr = (timeRange || posted_date || 'anytime').toLowerCase();
const maxJobs = Math.max(1, Math.min(10000, Number(IN_maxJobs) || Number(results_wanted) || 300));
const maxConcurrency = Math.max(6, Math.min(48, Number(IN_maxConcurrency) || 24));

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
// Stable proxy per phase; rotate on streak failures
let listProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
let detailProxyUrl = listProxyUrl;

log.info(`🔎 Keywords: ${keywordsArr.join(' | ')} | Location: "${locationStr}" | Time: ${timeRangeStr}`);
log.info(`🎯 Target jobs: ${maxJobs} | Concurrency: ${maxConcurrency}`);

// Crawler (accepts application/octet-stream to avoid the MIME abort)
const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  useSessionPool: true,
  maxConcurrency,
  minConcurrency: Math.max(3, Math.floor(maxConcurrency / 2)),
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 25,
  navigationTimeoutSecs: 25,
  additionalMimeTypes: ['application/octet-stream', 'text/plain'],

  preNavigationHooks: [
    async ({ request }) => {
      request.headers = makeRequestHeaders('https://www.linkedin.com/jobs/search/');
      await sleep(rnd(10, 40));
    },
  ],

  requestHandler: async (ctx) => {
    const { request, $, addRequests } = ctx;
    if (completedDetail.size >= maxJobs) return;

    // ------------------------ LIST ------------------------
    if (request.userData.label === 'LIST') {
      if (typeof $ !== 'function') {
        $ = cheerio.load(ctx.response?.body || '');
      }

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
      for (const t of m) { const id = getJobId(t); if (id) ids.add(id); }

      let newCount = 0;
      const ctxInfo = request.userData.searchContext;

      // If no IDs found on this LIST page, it's likely a block or an empty page.
      if (ids.size === 0) {
        // Rotate proxy on repeated list failures
        failureStreakList++;
        if (failureStreakList % 3 === 0 && proxyConfig) {
          listProxyUrl = await proxyConfig.newUrl();
          log.info('🔁 Rotated proxy after empty LIST detection.');
        }
        log.warning(`LIST page contains no job entries start=${request.userData.start} — possible block; re-enqueueing.`);
        // Re-enqueue this LIST once with higher priority for retry
        await addRequests([{
          url: request.url,
          userData: { label: 'LIST', start: request.userData.start, params: request.userData.params, searchContext: ctxInfo },
          priority: 10,
        }]);
        return;
      }

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

      // Continue pagination for this keyword
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
      if (!jobId || completedDetail.has(jobId)) return;

      // Always fetch with gotScraping for better control (even if crawler fetched)
      let html;
      try {
        html = await fetchPage(request.url, detailProxyUrl);
      } catch (e) {
        // Let failedRequestHandler manage retry; don't mark completed
        throw e;
      }
      if (isBlockedHtml(html)) {
        // Rotate proxy and re-enqueue detail
        failureStreakDetail++;
        if (failureStreakDetail % 2 === 0 && proxyConfig) {
          detailProxyUrl = await proxyConfig.newUrl();
          log.info('🔁 Rotated proxy after blocked DETAIL response.');
        }
        log.warning(`Blocked or truncated detail for job ${jobId}; re-enqueueing.`);
        await crawler.addRequests([{
          url: guestDetailUrl(jobId),
          userData: { label: 'DETAIL', jobId },
          priority: 6,
        }]);
        return;
      }
      let $html = cheerio.load(html);

      let record = extractJobData($html, request.url, ctxById[jobId] || {});
      if (!record.title && request.retryCount < 1) {
        // One light retry if truncated
        await sleep(rnd(100, 240));
        const html2 = await fetchPage(request.url, detailProxyUrl);
        const $2 = cheerio.load(html2);
        record = extractJobData($2, request.url, ctxById[jobId] || {});
      }

      await Dataset.pushData(record);
      completedDetail.add(jobId);

      if (completedDetail.size % 25 === 0 || completedDetail.size === maxJobs) {
        log.info(`✓ Completed ${completedDetail.size}/${maxJobs}`);
      }
      return;
    }
  },

  failedRequestHandler: async ({ request, error }) => {
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
      // Re-enqueue once if still under target
      const jobId = request.userData.jobId || getJobId(request.url);
      if (jobId && !completedDetail.has(jobId) && request.retryCount < 1) {
        await crawler.addRequests([{
          url: guestDetailUrl(jobId),
          userData: { label: 'DETAIL', jobId },
          priority: 6,
        }]);
      }
    }

    log.warning(`Request failed [${lbl}] ${request.url.slice(0, 140)} — ${error?.message || 'error'}`);
    await sleep(rnd(180, 500));
  },
});

// ------------------------ Seed LIST pages in parallel (fast start) ------------------------

const seeds = [];
for (const kw of keywordsArr) {
  const params = buildGuestListParams(kw, locationStr, timeRangeStr);
  const ctxInfo = { searchQuery: kw, searchLocation: locationStr, searchTimeRange: timeRangeStr };

  // Aggressively pre-enqueue N pages per keyword for fast warm-up.
  const pagesNeeded = Math.ceil(Math.min(maxJobs, 600) / 25); // up to first 600 items/keyword initially
  const pagesToKick = Math.min(12, pagesNeeded); // initial burst cap (tune if needed)

  for (let i = 0; i < pagesToKick; i++) {
    const start = i * 25;
    seeds.push({
      url: guestListUrl(params, start),
      userData: { label: 'LIST', start, params, searchContext: ctxInfo },
      priority: 9,
    });
  }
}

await crawler.addRequests(seeds);
await crawler.run();

// Mop-up pass to reach maxJobs if under due to transient failures
if (completedDetail.size < maxJobs) {
  const remaining = Array.from(collectedIds).filter((id) => !completedDetail.has(id));
  const take = Math.max(0, Math.min(maxJobs - completedDetail.size, remaining.length));
  const extra = remaining.slice(0, take).map((id) => ({
    url: guestDetailUrl(id),
    userData: { label: 'DETAIL', jobId: id },
    priority: 6,
  }));
  if (extra.length) {
    log.info(`Mop-up: re-enqueueing ${extra.length} details to hit target ${maxJobs}.`);
    await crawler.addRequests(extra);
    await crawler.run();
  }
}

log.info(`✅ Done. Jobs pushed: ${completedDetail.size} / ${maxJobs}`);
await Actor.exit();
