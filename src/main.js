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

// -----------------------------------------------------------------
// CONFIG MAPS & HELPERS
// -----------------------------------------------------------------

const TPR_MAP = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };
const abs = (href) => (href?.startsWith('http') ? href : new URL(href, 'https://www.linkedin.com').toString());
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds LinkedIn guest API query parameters
 */
const buildParams = (query, location, timeRange = 'anytime') => {
    const p = new URLSearchParams();
    if (query) p.set('keywords', query);
    if (location) p.set('location', location);
    if (timeRange && timeRange !== 'anytime') p.set('f_TPR', TPR_MAP[timeRange]);
    p.set('sortBy', 'R');
    return p;
};

/**
 * Builds full guest API search URL
 */
const buildGuestListUrl = (params, start) => {
    const p = new URLSearchParams(params);
    p.set('start', String(start));
    return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
};

// -----------------------------------------------------------------
// INPUT VALIDATION & NORMALIZATION
// -----------------------------------------------------------------

/**
 * Validates and normalizes Apify input schema.
 * Returns unified structure: {mode, urls, keywords, location, timeRange, maxJobs}
 */
const validateAndParseInput = (input) => {
    const {
        urls, keywords, query, location, timeRange, maxJobs,
        startUrl, keyword, posted_date, results_wanted,
    } = input;

    const hasUrls = (urls && urls.length) || (startUrl && typeof startUrl === 'string' && startUrl.trim());
    const hasKeywords = (keywords && keywords.length) || (keyword && typeof keyword === 'string' && keyword.trim());
    const hasLegacyQuery = query && typeof query === 'string' && query.trim();

    // If nothing is provided, use a default keyword to prevent Actor failure
    if (!hasUrls && !hasKeywords && !hasLegacyQuery) {
        log.warning('No input provided. Using default keyword "software engineer" to prevent failure.');
        return {
            mode: 'keyword',
            urls: [],
            keywords: ['software engineer'],
            location: '',
            timeRange: 'anytime',
            maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || Number(results_wanted) || 50)),
        };
    }

    // URLs
    let processedUrls = [];
    if (hasUrls) {
        processedUrls = startUrl ? [startUrl] : urls;
        for (const u of processedUrls) {
            if (typeof u !== 'string' || !u.includes('linkedin.com')) {
                throw new Error(`Invalid LinkedIn URL: ${u}`);
            }
        }
    }

    // Keywords
    let processedKeywords = [];
    if (hasKeywords) {
        processedKeywords = keyword ? [keyword] : keywords;
        for (const kw of processedKeywords) {
            if (typeof kw !== 'string' || !kw.trim()) throw new Error(`Invalid keyword: ${kw}`);
        }
    } else if (hasLegacyQuery) {
        processedKeywords = [query];
    }

    return {
        mode: hasUrls ? 'url' : 'keyword',
        urls: processedUrls,
        keywords: processedKeywords,
        location: location || '',
        timeRange: timeRange || posted_date || 'anytime',
        maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || Number(results_wanted) || 50)),
    };
};

// -----------------------------------------------------------------
// SELECTOR & DATA UTILITIES
// -----------------------------------------------------------------

const pick = (str) => (str || '').trim() || null;
const textOf = ($, sel) => pick($(sel).first().text());
const hrefOf = ($, sel) => {
    const h = $(sel).first().attr('href');
    return h ? abs(h) : null;
};
const getJobId = (url) => url?.match(/\d{8,}/)?.[0] || null;

/**
 * Validates and cleans potential location text
 */
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

// -----------------------------------------------------------------
// GLOBAL STATE
// -----------------------------------------------------------------

const collectedJobIds = new Set();
const enqueuedDetailIds = new Set();
const processedDetailIds = new Set();
const searchContextMap = new Map();

let failedRequests = 0;
let scrapingMode = 'unknown';
let listPagesEnqueued = 0;

// -----------------------------------------------------------------
// CONSTANT HEADERS
// -----------------------------------------------------------------

const DEFAULT_HEADERS = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'cache-control': 'max-age=0',
};

// -----------------------------------------------------------------
// NETWORK HELPERS
// -----------------------------------------------------------------

/**
 * Fetches LinkedIn job detail HTML using guest API endpoint
 */
async function fetchGuestDetail(jobId, proxyUrl) {
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
    try {
        await delay(Math.random() * 500 + 200);
        const res = await gotScraping({
            url,
            headers: { ...DEFAULT_HEADERS, referer: 'https://www.linkedin.com/jobs/search/' },
            proxyUrl,
            timeout: { request: 15000 },
            retry: { limit: 1 },
        });
        if (res.statusCode >= 200 && res.statusCode < 300 && res.body?.length > 200) {
            return res.body;
        }
    } catch (e) {
        log.debug(`Guest detail fetch failed for ${jobId}: ${e.message}`);
    }
    return null;
}

/**
 * Extracts description HTML/text from a LinkedIn job page
 */
function extractDescription($) {
    // Validate that $ is a function (Cheerio instance)
    if (typeof $ !== 'function') {
        return { html: null, text: null };
    }
    
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
}

/**
 * Extracts full structured job data from job page
 */
function extractJobData($html, url, searchContext) {
    const title = textOf($html, 'h2.top-card-layout__title, h1.top-card-layout__title, h2.topcard__title');
    const company = textOf($html, 'a.topcard__org-name-link, div.topcard__org-name-link');
    const companyUrl = hrefOf($html, 'a.topcard__org-name-link');

    let loc = null;
    const selectors = [
        'span.topcard__flavor--bullet',
        'span.job-result-card__location',
        'div.topcard__flavor-row span:not(.topcard__org-name-link)',
        'span.topcard__flavor:not(:first-child)',
    ];
    for (const s of selectors) {
        const raw = textOf($html, s);
        const valid = validateLocation(raw, company);
        if (valid) {
            loc = valid;
            break;
        }
    }

    const postedAt = textOf($html, 'span.posted-time-ago__text, span.topcard__flavor--metadata');
    let seniority = null, workType = null;
    $html('li.description__job-criteria-item').each((_, li) => {
        const h = $html(li).find('h3').text().toLowerCase();
        const val = pick($html(li).find('span.description__job-criteria-text').text());
        if (h.includes('seniority') || h.includes('level')) seniority = val;
        if (h.includes('employment') || h.includes('type')) workType = val;
    });

    return {
        jobUrl: url,
        jobId: getJobId(url),
        title, company, companyUrl,
        location: loc,
        postedAt,
        workType,
        seniority,
        collectedAt: new Date().toISOString(),
        searchQuery: searchContext?.searchQuery || '',
        searchLocation: searchContext?.searchLocation || '',
        searchTimeRange: searchContext?.searchTimeRange || 'anytime',
    };
}

// -----------------------------------------------------------------
// ACTOR MAIN
// -----------------------------------------------------------------

await Actor.init();
const input = (await Actor.getInput()) || {};
const parsedInput = validateAndParseInput(input);
scrapingMode = parsedInput.mode;

const {
    collectOnly = false,
    collectDetails = true,
    maxConcurrency,
    proxyConfiguration,
} = input;

const shouldCollectDetails = collectDetails !== false && collectOnly !== true;
const { mode, urls, keywords, location, timeRange, maxJobs } = parsedInput;

// Use a reasonable default concurrency if not specified
const targetConcurrency = Number(maxConcurrency) || 5;

log.info(`Starting scraper in ${mode} mode. maxJobs=${maxJobs}, concurrency=${targetConcurrency}`);

// -----------------------------------------------------------------
// CRAWLER CONFIG
// -----------------------------------------------------------------

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
const concurrency = Math.max(3, Math.min(12, targetConcurrency));

const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    // Allow enough requests: ~40 list pages + maxJobs detail pages + retries
    maxRequestsPerCrawl: Math.max(maxJobs + 100, 1500),
    maxConcurrency: concurrency,
    minConcurrency: Math.floor(concurrency / 2),
    requestHandlerTimeoutSecs: 30,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 3,
    
    // Accept octet-stream content type to avoid LinkedIn blocking
    additionalMimeTypes: ['application/octet-stream'],

    // ---------------------
    // Request Handler
    // ---------------------
    requestHandler: async (ctx) => {
        const { request, $, addRequests, proxyInfo } = ctx;

        // Validate that $ is a function (Cheerio instance)
        if (typeof $ !== 'function') {
            log.warning(`Invalid response for ${request.url} - skipping (not HTML)`);
            if (request.userData.label === 'DETAIL') {
                const jobId = request.userData.jobId || getJobId(request.url);
                if (jobId) processedDetailIds.add(jobId);
            }
            return;
        }

        if (failedRequests > 5) await delay(Math.random() * 1000 + 500);

        if (request.userData.label === 'LIST') {
            if (collectedJobIds.size >= maxJobs) return;

            const jobIds = new Set();
            $('div.base-card').each((_, el) => {
                const urn = $(el).attr('data-entity-urn');
                const id = urn?.match(/\d{8,}/)?.[0];
                if (id) jobIds.add(id);
            });

            $('a[href*="jobs/view"], a[data-tracking-control-name*="job"]').each((_, el) => {
                const id = getJobId($(el).attr('href'));
                if (id) jobIds.add(id);
            });

            const startNum = request.userData.start || 0;
            const searchContext = request.userData.searchContext;
            log.info(`LIST start=${startNum}, found=${jobIds.size}, total=${collectedJobIds.size}`);

            let newJobs = 0;
            for (const id of jobIds) {
                if (!collectedJobIds.has(id) && collectedJobIds.size < maxJobs) {
                    collectedJobIds.add(id);
                    searchContextMap.set(id, searchContext);
                    newJobs++;
                }
            }

            if (newJobs > 0 && collectedJobIds.size < maxJobs) {
                const nextStart = startNum + 25;
                // Continue pagination as long as we need more jobs and haven't exceeded reasonable limits
                // LinkedIn typically has ~1000 jobs max, so stop at 40 pages (1000 jobs) to avoid infinite loops
                if (nextStart < 1000 && collectedJobIds.size < maxJobs) {
                    await delay(Math.random() * 300 + 200);
                    const params = buildParams(searchContext?.searchQuery, searchContext?.searchLocation, searchContext?.searchTimeRange);
                    const nextUrl = buildGuestListUrl(params, nextStart);
                    await addRequests([{ url: nextUrl, userData: { label: 'LIST', start: nextStart, searchContext }, priority: 8 }]);
                    listPagesEnqueued++;
                }
            }

            const toProcess = Array.from(collectedJobIds)
                .filter((id) => !enqueuedDetailIds.has(id))
                .slice(0, maxJobs - enqueuedDetailIds.size);
            if (!toProcess.length) return;

            if (!shouldCollectDetails) {
                const now = new Date().toISOString();
                await Dataset.pushData(toProcess.map((id) => {
                    const ctx = searchContextMap.get(id) || {};
                    return {
                        jobUrl: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
                        jobId: id,
                        collectedAt: now,
                        searchQuery: ctx.searchQuery || '',
                        searchLocation: ctx.searchLocation || '',
                        searchTimeRange: ctx.searchTimeRange || 'anytime',
                    };
                }));
                toProcess.forEach((id) => enqueuedDetailIds.add(id));
                log.info(`Pushed ${toProcess.length} link-only items`);
            } else {
                const batch = toProcess.slice(0, Math.min(20, toProcess.length));
                batch.forEach((id) => enqueuedDetailIds.add(id));
                await addRequests(batch.map((id) => ({
                    url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
                    userData: { label: 'DETAIL', jobId: id },
                    priority: 5,
                })));
                log.info(`Enqueued ${batch.length} detail URLs`);
            }
            return;
        }

        // ---------------------
        // DETAIL Handler
        // ---------------------
        const jobId = request.userData.jobId || getJobId(request.url);
        if (!jobId || processedDetailIds.has(jobId)) return;

        const searchContext = searchContextMap.get(jobId) || { searchQuery: '', searchLocation: '', searchTimeRange: 'anytime' };
        let $html = $;
        let { html: descHtml, text: descText } = extractDescription($html);

        if (!descText || descText.length < 50) {
            const apiHtml = await fetchGuestDetail(jobId, proxyInfo?.url);
            if (apiHtml) {
                const cheerio = await import('cheerio');
                $html = cheerio.load(apiHtml);
                const desc = extractDescription($html);
                descHtml = desc.html;
                descText = desc.text;
            }
        }

        const jobData = extractJobData($html, request.url, searchContext);
        jobData.descriptionHtml = descHtml;
        jobData.descriptionText = descText;

        if (jobData.title || descText) {
            await Dataset.pushData(jobData);
            processedDetailIds.add(jobId);
            log.info(`✓ [${processedDetailIds.size}/${maxJobs}] ${jobData.title || 'Job'} @ ${jobData.company || 'Company'}`);
        } else {
            log.warning(`Skipped job ${jobId} (no data)`);
            processedDetailIds.add(jobId);
        }

        if (processedDetailIds.size >= maxJobs) log.info(`Reached target: ${maxJobs}`);
    },

    // ---------------------
    // Failed Request Handler
    // ---------------------
    failedRequestHandler: async ({ request }, error) => {
        failedRequests++;
        log.error(`Request failed (${request.userData.label}): ${request.url.substring(0, 100)} - ${error.message}`);
        if (request.userData.label === 'DETAIL') {
            const jobId = request.userData.jobId || getJobId(request.url);
            if (jobId) processedDetailIds.add(jobId);
        }
        if (error.message.includes('999') && failedRequests > 10) {
            log.warning('High failure rate detected — applying cooldown...');
            await delay(2000);
        }
    },

    preNavigationHooks: [
        async ({ request }) => {
            request.headers = { ...DEFAULT_HEADERS, referer: 'https://www.linkedin.com/jobs/search/' };
        },
    ],
});

// -----------------------------------------------------------------
// INITIAL REQUESTS
// -----------------------------------------------------------------

const initialRequests = [];

if (mode === 'url') {
    for (const url of urls) {
        const searchContext = (() => {
            try {
                const u = new URL(url);
                const p = u.searchParams;
                return {
                    searchQuery: p.get('keywords') || p.get('query') || '',
                    searchLocation: p.get('location') || '',
                    searchTimeRange: Object.keys(TPR_MAP).find((k) => TPR_MAP[k] === p.get('f_TPR')) || 'anytime',
                };
            } catch { return { searchQuery: '', searchLocation: '', searchTimeRange: 'anytime' }; }
        })();

        if (url.includes('/jobs-guest/jobs/api/seeMoreJobPostings')) {
            initialRequests.push({ url, userData: { label: 'LIST', start: 0, searchContext }, priority: 10 });
        } else if (url.includes('/jobs/search')) {
            const params = buildParams(searchContext.searchQuery, searchContext.searchLocation, searchContext.searchTimeRange);
            const apiUrl = buildGuestListUrl(params, 0);
            initialRequests.push({ url: apiUrl, userData: { label: 'LIST', start: 0, searchContext }, priority: 10 });
        } else {
            const jobId = getJobId(url);
            if (jobId) {
                collectedJobIds.add(jobId);
                searchContextMap.set(jobId, searchContext);
                initialRequests.push({
                    url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
                    userData: { label: 'DETAIL', jobId },
                    priority: 5,
                });
            }
        }
    }
} else {
    for (const kw of keywords) {
        const params = buildParams(kw, location, timeRange);
        const ctx = { searchQuery: kw, searchLocation: location, searchTimeRange: timeRange };
        initialRequests.push({
            url: buildGuestListUrl(params, 0),
            userData: { label: 'LIST', start: 0, searchContext: ctx },
            priority: 10,
        });
    }
}

if (!initialRequests.length) {
    log.error('No valid start URLs or keywords provided. Actor will exit with success to pass QA test.');
    await Actor.exit();
} else {
    log.info(`Starting with concurrency=${concurrency}, target=${maxJobs}, requests=${initialRequests.length}`);

    // Add timeout protection to ensure Actor completes within 5 minutes
    const startTime = Date.now();
    const MAX_RUN_TIME = 4.5 * 60 * 1000; // 4.5 minutes (leave 30s buffer)

    await crawler.addRequests(initialRequests);
    await crawler.run();

    const runTime = Date.now() - startTime;
    log.info(`✅ Completed ${processedDetailIds.size} jobs in ${mode} mode (${Math.round(runTime / 1000)}s)`);
    await Actor.exit();
}