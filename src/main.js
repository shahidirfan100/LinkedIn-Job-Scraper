/**
 * ================================================================
 *  LinkedIn Job Scraper — Keyword Mode (Guest API, Ultra Fast)
 *  Focus: Speed + Stealth (avoid 403/999), keyword-first workflow
 * ================================================================
 *  - Input supports:
 *      { keywords: ["react developer", "python"], location: "Berlin", timeRange: "24h|7d|30d|anytime",
 *        maxJobs: 200, maxConcurrency: 16, proxyConfiguration: {...} }
 *    Back-compat keys: { keyword, query, results_wanted, posted_date }
 *  - Uses only guest endpoints (no login, fast HTML slices)
 *  - Parallel detail fetch with controlled concurrency (PQueue)
 *  - Preserves resilient selectors used in main.js/main_new.js families
 * ================================================================
 */

import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { gotScraping } from 'got-scraping';
import PQueue from 'p-queue';
import * as cheerio from 'cheerio';

// ---------------------- Config & Helpers ------------------------

const TPR_MAP = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };

const UA_POOL = [
    // Modern, realistic desktop & mobile mix; rotated per request
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
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

// ---------------------- Input Normalization ---------------------

const normalizeInput = (input) => {
    const {
        keywords, keyword, query,
        location, timeRange, posted_date,
        maxJobs, results_wanted,
        maxConcurrency,
        proxyConfiguration,
    } = input || {};

    const kws = (keywords && Array.isArray(keywords) && keywords.length)
        ? keywords
        : (keyword ? [keyword] : (query ? [query] : []));

    if (!kws.length) {
        throw new Error('Provide at least one keyword via "keywords" (array) or "keyword"/"query" (string).');
    }

    return {
        keywords: kws.filter(Boolean).map((s) => s.trim()).filter(Boolean),
        location: (location || '').trim(),
        timeRange: (timeRange || posted_date || 'anytime').toLowerCase(),
        maxJobs: Math.max(1, Math.min(5000, Number(maxJobs) || Number(results_wanted) || 300)),
        maxConcurrency: Math.max(4, Math.min(32, Number(maxConcurrency) || 16)),
        proxyConfiguration,
    };
};

// --------------------- Networking (Guest API) -------------------

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
    return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
};

const fetchPage = async (url, proxyUrl) => {
    const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
    await sleep(rnd(80, 220)); // tiny jitter
    const res = await gotScraping({
        url,
        headers: { ...DEFAULT_HEADERS, referer: 'https://www.linkedin.com/jobs/search/', 'user-agent': ua },
        proxyUrl,
        timeout: { request: 15000 },
        retry: { limit: 1 },
    });
    if (res.statusCode >= 200 && res.statusCode < 300) return res.body || '';
    throw new Error(`Bad status: ${res.statusCode}`);
};

const extractJobIdsFromListHtml = (html) => {
    const $ = cheerio.load(html);
    const ids = new Set();

    // Primary: base card urn
    $('div.base-card').each((_, el) => {
        const urn = $(el).attr('data-entity-urn');
        const id = urn?.match(/\d{8,}/)?.[0];
        if (id) ids.add(id);
    });

    // Backup: any link containing jobs/view
    $('a[href*="jobs/view"]').each((_, el) => {
        const id = getJobId($(el).attr('href'));
        if (id) ids.add(id);
    });

    // Fallback: raw regex (covers edge/min HTML)
    const m = html.match(/\bjobs\/view\/(\d{8,})/g) || [];
    for (const t of m) {
        const id = getJobId(t);
        if (id) ids.add(id);
    }

    return Array.from(ids);
};

const fetchJobDetailHtml = async (jobId, proxyUrl) => {
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
    return fetchPage(url, proxyUrl);
};

// --------------------- Main Runner (Keywords) -------------------

await Actor.init();
const rawInput = (await Actor.getInput()) || {};
const {
    keywords, location, timeRange, maxJobs,
    maxConcurrency, proxyConfiguration,
} = normalizeInput(rawInput);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

log.info(`🔎 Keywords: ${keywords.join(' | ')} | Location: "${location}" | Time: ${timeRange}`);
log.info(`🎯 Target jobs: ${maxJobs} | Concurrency: ${maxConcurrency}`);

const allJobIds = new Set();
let pagesFetched = 0;

for (const kw of keywords) {
    if (allJobIds.size >= maxJobs) break;

    const params = buildGuestListParams(kw, location, timeRange);
    let start = 0;
    let pageStreakWithoutNew = 0;

    while (allJobIds.size < maxJobs) {
        const url = guestListUrl(params, start);
        let html = '';
        try {
            html = await fetchPage(url, proxyUrl);
            pagesFetched++;
        } catch (e) {
            log.warning(`List fetch error @ start=${start}: ${e.message}`);
            // mild cooldown to reduce soft blocks
            await sleep(rnd(400, 900));
            // on repeated issues, break out of this keyword loop
            if (pageStreakWithoutNew >= 2) break;
        }

        const ids = extractJobIdsFromListHtml(html);
        let newlyAdded = 0;
        for (const id of ids) {
            if (!allJobIds.has(id)) {
                allJobIds.add(id);
                newlyAdded++;
                if (allJobIds.size >= maxJobs) break;
            }
        }

        log.info(`[${kw}] start=${start} → found on page=${ids.length}, new=${newlyAdded}, total=${allJobIds.size}/${maxJobs}`);

        if (newlyAdded === 0) pageStreakWithoutNew++;
        else pageStreakWithoutNew = 0;

        // stop if no new items for 2 pages or no content
        if (ids.length === 0 || pageStreakWithoutNew >= 2) break;

        start += 25; // LinkedIn increments by ~25 items
        // small jitter between list pages
        await sleep(rnd(150, 350));
    }
}

// --------------------- Detail Fetch (Parallel) ------------------

log.info(`📄 Pages fetched: ${pagesFetched} | Unique job IDs: ${allJobIds.size}`);

const queue = new PQueue({
    concurrency: maxConcurrency,
    interval: 1000,       // per-window throttle (1s)
    intervalCap: Math.max(8, Math.floor(maxConcurrency * 1.5)), // burst cap per second
    carryoverConcurrencyCount: true,
});

let processed = 0;
let failures = 0;

const ctxMap = {}; // search context per id (best-effort: first keyword used)
const idsList = Array.from(allJobIds);
idsList.forEach((id, i) => {
    const kwIndex = i % Math.max(1, keywords.length);
    ctxMap[id] = { searchQuery: keywords[kwIndex], searchLocation: location, searchTimeRange: timeRange };
});

const runDetail = async (jobId) => {
    try {
        const html = await fetchJobDetailHtml(jobId, proxyUrl);
        const $ = cheerio.load(html);
        const detailUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
        const data = extractJobData($, detailUrl, ctxMap[jobId]);
        // if title missing (rare), do a one-time light refetch with jitter
        if (!data.title) {
            await sleep(rnd(120, 300));
            const html2 = await fetchJobDetailHtml(jobId, proxyUrl);
            const $2 = cheerio.load(html2);
            const data2 = extractJobData($2, detailUrl, ctxMap[jobId]);
            Object.assign(data, data2);
        }
        await Dataset.pushData(data);
        processed++;
        if (processed % 25 === 0) log.info(`✓ Processed ${processed}/${idsList.length}`);
    } catch (e) {
        failures++;
        log.debug(`Detail error ${jobId}: ${e.message}`);
        // backoff on frequent failures
        if (failures % 10 === 0) await sleep(rnd(800, 1600));
    }
};

for (const id of idsList) {
    if (processed >= maxJobs) break;
    queue.add(() => runDetail(id));
}

// wait for all tasks (or until we reached maxJobs pushed)
await queue.onIdle();

log.info(`✅ Done. Jobs pushed: ${processed} (failures: ${failures})`);
await Actor.exit();
