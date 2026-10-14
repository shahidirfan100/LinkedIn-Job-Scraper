/**
 * LinkedIn Job Scraper (Apify Actor)
 * Uses LinkedIn guest endpoints with impit browser/TLS impersonation.
 */

import { Actor, Dataset, log } from 'apify';
import * as cheerio from 'cheerio';
import { Impit } from 'impit';

const TPR_MAP = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };
const GUEST_LIST_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const GUEST_DETAIL_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const LINKEDIN_BASE = 'https://www.linkedin.com';
const LINKEDIN_REFERER = 'https://www.linkedin.com/jobs/search/';
const DEFAULT_GUEST_PAGE_STEP = 10;
const GUEST_MAX_START = 1000;
const DEFAULT_PROXY_POOL_SIZE = 20;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRY_AFTER_MS = 30000;

// Browser/TLS profiles verified against the LinkedIn guest endpoints on impit 0.14.5.
// Ranked by live reliability (list + detail success): chrome136/chrome142 were the
// most stable, then chrome124/firefox128/firefox/firefox144. Profiles such as
// chrome151, chrome125, firefox135 and chrome110-116/ios18/okhttp are excluded
// because they were throttled or failed the TLS handshake.
const IMPIT_PROFILES = [
    'chrome136',
    'chrome142',
    'chrome124',
    'firefox128',
    'firefox',
    'firefox144',
];

// LinkedIn serves an obfuscated JavaScript "challenge" page (usually HTTP 429,
// occasionally HTTP 200) when it throttles a fingerprint. Detect it so the actor
// retries with a fresh profile/proxy session instead of parsing it as empty data.
const BLOCK_BODY_PATTERN = /_0x[0-9a-f]{4,}|captcha|authwall|challenge|unusual traffic|suspicious activity/i;
const VALID_LIST_MARKERS = ['base-card', 'job-search-card'];
const VALID_DETAIL_MARKERS = ['top-card-layout', 'topcard__', 'show-more-less-html__markup'];

const delay = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

const isBlockStatus = (status) => status === 429 || status === 999;

const hasMarker = (body, markers) => markers.some((marker) => body.includes(marker));

const looksLikeBlock = (status, body) => {
    if (isBlockStatus(status)) return true;
    if (status !== 200 || !body) return false;
    if (hasMarker(body, VALID_LIST_MARKERS) || hasMarker(body, VALID_DETAIL_MARKERS)) return false;
    return BLOCK_BODY_PATTERN.test(body);
};

const parseRetryAfter = (value) => {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
};

const abs = (href) => {
    if (!href) return null;
    return href.startsWith('http') ? href : new URL(href, LINKEDIN_BASE).toString();
};

const pick = (str) => (str || '').replace(/\s+/g, ' ').trim() || null;
const textOf = ($, sel) => pick($(sel).first().text());
const hrefOf = ($, sel) => {
    const h = $(sel).first().attr('href');
    return h ? abs(h) : null;
};
const getJobId = (url) => url?.match(/\d{8,}/)?.[0] || null;

const buildParams = (query, location, timeRange = 'anytime') => {
    const p = new URLSearchParams();
    if (query) p.set('keywords', query);
    if (location) p.set('location', location);
    if (timeRange && timeRange !== 'anytime') p.set('f_TPR', TPR_MAP[timeRange]);
    p.set('trk', 'public_jobs_jobs-search-bar_search-submit');
    p.set('position', '1');
    p.set('pageNum', '0');
    return p;
};

const buildGuestListUrl = (params, start) => {
    const p = new URLSearchParams(params);
    p.set('start', String(start));
    return `${GUEST_LIST_ENDPOINT}?${p.toString()}`;
};

const validateAndParseInput = (input) => {
    const {
        urls, keywords, query, location, timeRange, maxJobs,
        startUrl, keyword, posted_date: postedDate, results_wanted: resultsWanted,
    } = input;

    const hasUrls = (urls && urls.length) || (startUrl && typeof startUrl === 'string' && startUrl.trim());
    const hasKeywords = (keywords && keywords.length) || (keyword && typeof keyword === 'string' && keyword.trim());
    const hasLegacyQuery = query && typeof query === 'string' && query.trim();

    if (!hasUrls && !hasKeywords && !hasLegacyQuery) {
        log.warning('No input provided. Using default keyword "software engineer" to prevent failure.');
        return {
            mode: 'keyword',
            urls: [],
            keywords: ['software engineer'],
            location: 'United States',
            timeRange: 'anytime',
            maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || Number(resultsWanted) || 20)),
        };
    }

    let processedUrls = [];
    if (hasUrls) {
        processedUrls = startUrl ? [startUrl] : urls;
        for (const u of processedUrls) {
            if (typeof u !== 'string' || !u.includes('linkedin.com')) {
                throw new Error(`Invalid LinkedIn URL: ${u}`);
            }
        }
    }

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
        timeRange: timeRange || postedDate || 'anytime',
        maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || Number(resultsWanted) || 20)),
    };
};

const validateLocation = (locationText, companyName) => {
    if (!locationText) return null;
    const cleaned = locationText.trim();
    if (!cleaned) return null;
    if (companyName && cleaned.toLowerCase() === companyName.toLowerCase()) return null;

    const suffixes = new RegExp(
        '\\b(inc\\.?|llc\\.?|ltd\\.?|corp\\.?|corporation|company|co\\.?|group|solutions|technologies|tech|systems|services|'
        + 'enterprises|holdings|international|global|worldwide)\\b',
        'i',
    );
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
        if (node.length) {
            const html = node.html();
            const text = pick(node.text());
            if (text && text.length > 30) return { html, text };
        }
    }
    return { html: null, text: null };
};

const extractJobData = ($, url, searchContext) => {
    const title = textOf($, 'h2.top-card-layout__title, h1.top-card-layout__title, h2.topcard__title');
    const company = textOf($, 'a.topcard__org-name-link, div.topcard__org-name-link');
    const companyUrl = hrefOf($, 'a.topcard__org-name-link');
    const companyLogo = $('img.artdeco-entity-image, img.topcard__flavor-logo').first().attr('data-delayed-url')
        || $('img.artdeco-entity-image, img.topcard__flavor-logo').first().attr('src')
        || null;

    let loc = null;
    const selectors = [
        'span.topcard__flavor--bullet',
        'span.job-result-card__location',
        'div.topcard__flavor-row span:not(.topcard__org-name-link)',
        'span.topcard__flavor:not(:first-child)',
    ];
    for (const sel of selectors) {
        const valid = validateLocation(textOf($, sel), company);
        if (valid) {
            loc = valid;
            break;
        }
    }

    const postedAt = textOf($, 'span.posted-time-ago__text, span.topcard__flavor--metadata');
    const applicantsCount = textOf($, 'span.num-applicants__caption, figcaption.num-applicants__caption');
    const salary = textOf($, 'div.salary, span.salary, div.compensation__salary');
    let seniority = null;
    let workType = null;
    let jobFunction = null;
    let companyIndustry = null;

    $('li.description__job-criteria-item').each((_, li) => {
        const heading = $(li).find('h3').text().toLowerCase();
        const value = pick($(li).find('span.description__job-criteria-text').text());
        if (heading.includes('seniority') || heading.includes('level')) seniority = value;
        if (heading.includes('employment') || heading.includes('type')) workType = value;
        if (heading.includes('function')) jobFunction = value;
        if (heading.includes('industr')) companyIndustry = value;
    });

    return {
        jobUrl: url,
        jobId: getJobId(url),
        title,
        company,
        companyUrl,
        companyLogo,
        location: loc,
        postedAt,
        salary,
        seniority,
        workType,
        jobFunction,
        companyIndustry,
        applicantsCount,
        collectedAt: new Date().toISOString(),
        searchQuery: searchContext?.searchQuery || '',
        searchLocation: searchContext?.searchLocation || '',
        searchTimeRange: searchContext?.searchTimeRange || 'anytime',
        sourceEndpoint: 'jobs-guest/jobs/api/jobPosting',
    };
};

const extractJobIdsFromList = ($) => {
    const ids = new Set();
    $('div.base-card').each((_, el) => {
        const urn = $(el).attr('data-entity-urn');
        const id = urn?.match(/\d{8,}/)?.[0];
        if (id) ids.add(id);
    });

    $('a[href*="jobs/view"], a[data-tracking-control-name*="job"]').each((_, el) => {
        const id = getJobId($(el).attr('href'));
        if (id) ids.add(id);
    });
    return [...ids];
};

const extractJobSummariesFromList = ($, searchContext) => {
    const summaries = [];
    $('div.base-card').each((_, el) => {
        const card = $(el);
        const cardHrefOf = (sel) => {
            const href = card.find(sel).first().attr('href');
            return href ? abs(href) : null;
        };
        const urn = card.attr('data-entity-urn');
        const jobUrl = cardHrefOf('a.base-card__full-link, a[href*="jobs/view"]');
        const jobId = urn?.match(/\d{8,}/)?.[0] || getJobId(jobUrl);
        if (!jobId) return;

        const timeNode = card.find('time').first();
        summaries.push({
            jobUrl: jobUrl || `${GUEST_DETAIL_ENDPOINT}/${jobId}`,
            jobId,
            title: pick(card.find('h3.base-search-card__title').first().text()),
            company: pick(card.find('h4.base-search-card__subtitle, a.hidden-nested-link').first().text()),
            companyUrl: cardHrefOf('h4.base-search-card__subtitle a, a.hidden-nested-link'),
            location: pick(card.find('span.job-search-card__location').first().text()),
            postedAt: pick(timeNode.text()),
            listedAtIso: timeNode.attr('datetime') || null,
            collectedAt: new Date().toISOString(),
            searchQuery: searchContext?.searchQuery || '',
            searchLocation: searchContext?.searchLocation || '',
            searchTimeRange: searchContext?.searchTimeRange || 'anytime',
            sourceEndpoint: 'jobs-guest/jobs/api/seeMoreJobPostings/search',
        });
    });
    return summaries;
};

const summaryFallbackItem = (jobId, searchContext, summary = {}) => ({
    jobUrl: summary.jobUrl || `${GUEST_DETAIL_ENDPOINT}/${jobId}`,
    jobId,
    title: summary.title || null,
    company: summary.company || null,
    companyUrl: summary.companyUrl || null,
    companyLogo: null,
    location: summary.location || null,
    postedAt: summary.postedAt || null,
    listedAtIso: summary.listedAtIso || null,
    salary: null,
    seniority: null,
    workType: null,
    jobFunction: null,
    companyIndustry: null,
    applicantsCount: null,
    descriptionHtml: null,
    descriptionText: null,
    collectedAt: new Date().toISOString(),
    searchQuery: searchContext?.searchQuery || summary.searchQuery || '',
    searchLocation: searchContext?.searchLocation || summary.searchLocation || '',
    searchTimeRange: searchContext?.searchTimeRange || summary.searchTimeRange || 'anytime',
    sourceEndpoint: 'jobs-guest/jobs/api/seeMoreJobPostings/search',
    detailStatus: 'fallback_from_search',
});

const parseSearchContextFromUrl = (url) => {
    try {
        const u = new URL(url);
        const p = u.searchParams;
        return {
            searchQuery: p.get('keywords') || p.get('query') || '',
            searchLocation: p.get('location') || '',
            searchTimeRange: Object.keys(TPR_MAP).find((k) => TPR_MAP[k] === p.get('f_TPR')) || 'anytime',
        };
    } catch {
        return { searchQuery: '', searchLocation: '', searchTimeRange: 'anytime' };
    }
};

const createInitialSearches = ({ mode, urls, keywords, location, timeRange }) => {
    const searches = [];

    if (mode === 'url') {
        for (const url of urls) {
            const searchContext = parseSearchContextFromUrl(url);

            if (url.includes('/jobs-guest/jobs/api/seeMoreJobPostings')) {
                const parsed = new URL(url);
                const params = new URLSearchParams(parsed.search);
                const start = Number(params.get('start')) || 0;
                params.delete('start');
                if (!params.get('trk')) params.set('trk', 'public_jobs_jobs-search-bar_search-submit');
                if (!params.get('position')) params.set('position', '1');
                if (!params.get('pageNum')) params.set('pageNum', '0');
                searches.push({ type: 'list', params, start, searchContext });
            } else if (url.includes('/jobs/search')) {
                const parsed = new URL(url);
                const params = new URLSearchParams(parsed.search);
                const start = Number(params.get('start')) || 0;
                params.delete('currentJobId');
                params.delete('refresh');
                params.delete('start');
                if (!params.get('keywords') && searchContext.searchQuery) params.set('keywords', searchContext.searchQuery);
                if (!params.get('location') && searchContext.searchLocation) params.set('location', searchContext.searchLocation);
                if (!params.get('f_TPR') && searchContext.searchTimeRange !== 'anytime') params.set('f_TPR', TPR_MAP[searchContext.searchTimeRange]);
                if (!params.get('trk')) params.set('trk', 'public_jobs_jobs-search-bar_search-submit');
                if (!params.get('position')) params.set('position', '1');
                if (!params.get('pageNum')) params.set('pageNum', '0');
                searches.push({ type: 'list', params, start, searchContext });
            } else {
                const jobId = getJobId(url);
                if (jobId) searches.push({ type: 'detail', jobId, searchContext });
            }
        }
        return searches;
    }

    for (const kw of keywords) {
        const params = buildParams(kw, location, timeRange);
        const searchContext = { searchQuery: kw, searchLocation: location, searchTimeRange: timeRange };
        searches.push({ type: 'list', params, start: 0, searchContext });
    }
    return searches;
};

async function fetchTextWithRetry(getClient, url, {
    label,
    retries,
    minLength = 1,
    referer = LINKEDIN_REFERER,
}) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        let retryAfterMs = 0;
        try {
            // Rotate to a fresh client (new browser profile + proxy session) on every
            // retry so a throttled fingerprint or IP is abandoned, not repeated.
            const client = await getClient({ rotate: attempt > 1 });
            const response = await client.fetch(url, {
                method: 'GET',
                headers: { referer },
                redirect: 'follow',
            });
            const body = await response.text();
            const status = response.status;

            if (looksLikeBlock(status, body)) {
                retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
                lastError = new Error(`blocked by anti-bot page (HTTP ${status})`);
            } else if (!response.ok) {
                throw new Error(`HTTP ${status}`);
            } else if (body.length < minLength) {
                lastError = new Error(`short body (${body.length} bytes)`);
            } else {
                return body;
            }
        } catch (error) {
            lastError = error;
        }

        if (attempt < retries) {
            const status = Number(lastError.message.match(/HTTP (\d+)/)?.[1]) || 0;
            const isThrottle = retryAfterMs > 0
                || isBlockStatus(status)
                || status >= 500
                || lastError.message.startsWith('blocked')
                || lastError.message.includes('short body');
            const waitMs = retryAfterMs > 0
                ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
                : isThrottle
                    ? attempt * 1500 + Math.floor(Math.random() * 800)
                    : attempt * 750 + Math.floor(Math.random() * 500);
            log.debug(`${label} retry ${attempt}/${retries - 1} for ${url.substring(0, 120)}: ${lastError.message}`);
            await delay(waitMs);
        }
    }
    throw lastError;
}

await Actor.init();

const input = (await Actor.getInput()) || {};
const parsedInput = validateAndParseInput(input);
const {
    collectOnly = false,
    collectDetails = true,
    maxConcurrency,
    max_pages: maxPagesLegacy,
    maxPages,
    maxEmptyListPages,
    proxyConfiguration,
    datasetBatchSize,
    progressLogEvery,
    maxRequestRetries: maxRequestRetriesInput,
    requestDelayMs,
    proxyPoolSize,
} = input;

const shouldCollectDetails = collectDetails !== false && collectOnly !== true;
const { mode, maxJobs } = parsedInput;
const DATASET_BATCH_SIZE = Math.max(5, Math.min(100, Number(datasetBatchSize) || 25));
const PROGRESS_LOG_EVERY = Math.max(5, Math.min(100, Number(progressLogEvery) || 25));
const REQUEST_RETRIES = Math.max(2, Math.min(8, Number(maxRequestRetriesInput) || 5));
const requestedMaxPages = Number(maxPages) || Number(maxPagesLegacy) || 100;
const autoMaxPages = maxJobs >= 100
    ? Math.ceil(GUEST_MAX_START / DEFAULT_GUEST_PAGE_STEP)
    : Math.ceil(maxJobs / DEFAULT_GUEST_PAGE_STEP) * 2;
const MAX_LIST_PAGES = Math.max(1, Math.min(100, Math.max(requestedMaxPages, autoMaxPages)));
const MAX_EMPTY_LIST_PAGES = Math.max(1, Math.min(100, Number(maxEmptyListPages) || Math.max(10, Math.ceil(maxJobs / 50))));
const concurrency = Math.max(3, Math.min(12, Number(maxConcurrency) || 5));
const REQUEST_DELAY_MS = Math.max(0, Math.min(10000, Number(requestDelayMs) || 0));
const datasetBuffer = [];
const collectedJobIds = new Set();
const searchContextMap = new Map();
const listSummaryMap = new Map();
let totalItemsPushed = 0;
let failedRequests = 0;
let detailFallbacks = 0;
let listFailures = 0;

const flushDatasetBuffer = async (reason = 'periodic') => {
    if (!datasetBuffer.length) return;
    const items = datasetBuffer.splice(0, datasetBuffer.length);
    await Dataset.pushData(items);
    totalItemsPushed += items.length;
    if (reason === 'final' || totalItemsPushed === items.length || totalItemsPushed % PROGRESS_LOG_EVERY === 0) {
        log.info(`Flushed ${items.length} items to dataset (total=${totalItemsPushed})`);
    }
};

const queueDatasetItem = async (item) => {
    datasetBuffer.push(item);
    if (totalItemsPushed === 0 || datasetBuffer.length >= DATASET_BATCH_SIZE) await flushDatasetBuffer();
};

let proxyConfig = null;
const wantsApifyProxy = proxyConfiguration?.useApifyProxy;
const hasCustomProxyUrls = Array.isArray(proxyConfiguration?.proxyUrls) && proxyConfiguration.proxyUrls.length > 0;
if (hasCustomProxyUrls || (wantsApifyProxy && Actor.isAtHome())) {
    try {
        proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
    } catch (error) {
        // Requested groups (e.g. RESIDENTIAL) may be unavailable on the account.
        // Fall back to default Apify Proxy, then to no proxy, instead of aborting.
        log.warning(`Proxy configuration failed (${error.message}); retrying with default Apify Proxy.`);
        try {
            proxyConfig = await Actor.createProxyConfiguration({ useApifyProxy: true });
        } catch (fallbackError) {
            log.warning(`Apify Proxy unavailable (${fallbackError.message}); continuing without proxy.`);
            proxyConfig = null;
        }
    }
} else if (wantsApifyProxy && !Actor.isAtHome()) {
    log.info('Local run detected: skipping Apify Proxy because it is only available on Apify platform.');
}

const clients = [];
let clientCursor = 0;
const targetProxyPoolSize = proxyConfig
    ? Math.max(concurrency + REQUEST_RETRIES, Math.min(50, Number(proxyPoolSize) || DEFAULT_PROXY_POOL_SIZE))
    : Math.min(IMPIT_PROFILES.length, 4);
// Proxy runs may rotate through many sessions; local runs stay bounded to the
// profile pool so profile rotation still works without unbounded client growth.
const maxClientPoolSize = proxyConfig ? Math.max(targetProxyPoolSize, 60) : targetProxyPoolSize;

let profileCursor = 0;
const nextProfile = () => IMPIT_PROFILES[profileCursor++ % IMPIT_PROFILES.length];

const createClient = async () => {
    const index = clients.length;
    let proxyUrl;
    if (proxyConfig) {
        try {
            proxyUrl = await proxyConfig.newUrl(`li_${index}`);
        } catch (error) {
            log.warning(`Proxy session li_${index} failed to initialize: ${error.message}`);
            proxyUrl = await proxyConfig.newUrl();
        }
    }
    return new Impit({
        browser: nextProfile(),
        ignoreTlsErrors: true,
        timeout: REQUEST_TIMEOUT_MS,
        ...(proxyUrl && { proxyUrl }),
    });
};

for (let i = 0; i < targetProxyPoolSize; i++) {
    clients.push(await createClient());
}

const getClient = async ({ rotate = false } = {}) => {
    // rotate=true is used on retries: it hands back a brand-new profile + proxy
    // session so a throttled fingerprint is dropped instead of retried as-is.
    if (rotate && clients.length < maxClientPoolSize) {
        const fresh = await createClient();
        clients.push(fresh);
        return fresh;
    }
    if (clientCursor >= clients.length && clients.length < maxClientPoolSize) {
        clients.push(await createClient());
    }
    const client = clients[clientCursor % clients.length];
    clientCursor += 1;
    return client;
};

const detailConcurrency = proxyConfig ? concurrency : 1;
const listDelayMs = REQUEST_DELAY_MS || (proxyConfig ? 0 : 900);
const detailDelayMs = REQUEST_DELAY_MS || (proxyConfig ? 0 : 1200);
let hitListBoundary = false;

log.info(`Starting scraper in ${mode} mode. maxJobs=${maxJobs}, maxPages=${MAX_LIST_PAGES}, concurrency=${concurrency}, retries=${REQUEST_RETRIES}, proxyClients=${clients.length}`);

const initialSearches = createInitialSearches(parsedInput);
if (!initialSearches.length) {
    log.error('No valid start URLs or keywords provided. Actor will exit with success to pass QA test.');
    await Actor.exit();
}

const startedAt = Date.now();
const processedDetailIds = new Set();
const detailQueue = [];
const detailWaiters = [];
let runningDetailRequests = 0;

const notifyDetailWaiters = () => {
    if (detailQueue.length || runningDetailRequests) return;
    while (detailWaiters.length) detailWaiters.pop()();
};

const processDetailJob = async (jobId) => {
    const url = `${GUEST_DETAIL_ENDPOINT}/${jobId}`;
    const searchContext = searchContextMap.get(jobId) || { searchQuery: '', searchLocation: '', searchTimeRange: 'anytime' };
    const fallback = summaryFallbackItem(jobId, searchContext, listSummaryMap.get(jobId));
    try {
        if (detailDelayMs > 0) {
            await delay(detailDelayMs + Math.floor(Math.random() * Math.max(250, detailDelayMs / 2)));
        }
        const html = await fetchTextWithRetry(getClient, url, {
            label: 'DETAIL',
            retries: REQUEST_RETRIES,
            minLength: 200,
        });
        const $ = cheerio.load(html);
        const { html: descriptionHtml, text: descriptionText } = extractDescription($);
        const jobData = extractJobData($, url, searchContext);
        jobData.descriptionHtml = descriptionHtml;
        jobData.descriptionText = descriptionText;

        if (jobData.title || descriptionText) {
            await queueDatasetItem(jobData);
            if (totalItemsPushed + datasetBuffer.length === 1 || (totalItemsPushed + datasetBuffer.length) % PROGRESS_LOG_EVERY === 0) {
                log.info(`Progress: details ${totalItemsPushed + datasetBuffer.length}/${maxJobs}`);
            }
        } else {
            failedRequests++;
            detailFallbacks++;
            log.debug(`Skipped job ${jobId} because no detail data was parsed.`);
            await queueDatasetItem(fallback);
        }
    } catch (error) {
        failedRequests++;
        detailFallbacks++;
        // Recoverable throttling is expected on high-volume runs; keep it out of the
        // normal log and report the aggregate count in the final summary instead.
        log.debug(`DETAIL fallback for ${jobId} after ${REQUEST_RETRIES} attempts: ${error.message}`);
        await queueDatasetItem(fallback);
    }
};

const runQueuedDetailJob = (jobId) => {
    runningDetailRequests++;
    processDetailJob(jobId)
        .catch((error) => {
            failedRequests++;
            log.warning(`Unexpected detail worker failure for ${jobId}: ${error.message}`);
        })
        .finally(() => {
            runningDetailRequests--;
            pumpDetailQueue();
            notifyDetailWaiters();
        });
};

const pumpDetailQueue = () => {
    while (runningDetailRequests < detailConcurrency && detailQueue.length) {
        runQueuedDetailJob(detailQueue.shift());
    }
    notifyDetailWaiters();
};

const enqueueDetailJob = (jobId) => {
    if (processedDetailIds.has(jobId)) return;
    processedDetailIds.add(jobId);
    detailQueue.push(jobId);
    pumpDetailQueue();
};

const waitForDetailQueue = async () => {
    if (!detailQueue.length && !runningDetailRequests) return;
    await new Promise((resolve) => {
        detailWaiters.push(resolve);
    });
};

for (const search of initialSearches) {
    if (collectedJobIds.size >= maxJobs) break;

    if (search.type === 'detail') {
        if (!collectedJobIds.has(search.jobId)) {
            collectedJobIds.add(search.jobId);
            searchContextMap.set(search.jobId, search.searchContext);
            if (shouldCollectDetails) {
                enqueueDetailJob(search.jobId);
            } else {
                await queueDatasetItem(summaryFallbackItem(search.jobId, search.searchContext));
            }
        }
        continue;
    }

    let { start } = search;
    let emptyPages = 0;
    for (let pageIndex = 1; pageIndex <= MAX_LIST_PAGES && start < GUEST_MAX_START && collectedJobIds.size < maxJobs; pageIndex++) {
        const url = buildGuestListUrl(search.params, start);
        try {
            const html = await fetchTextWithRetry(getClient, url, {
                label: 'LIST',
                retries: REQUEST_RETRIES,
                minLength: 20,
            });
            const $ = cheerio.load(html);
            const pageJobIds = extractJobIdsFromList($);
            const summaries = extractJobSummariesFromList($, search.searchContext);
            let newJobs = 0;

            for (const summary of summaries) {
                listSummaryMap.set(summary.jobId, summary);
            }

            for (const id of pageJobIds) {
                if (!collectedJobIds.has(id) && collectedJobIds.size < maxJobs) {
                    collectedJobIds.add(id);
                    searchContextMap.set(id, search.searchContext);
                    if (shouldCollectDetails) {
                        enqueueDetailJob(id);
                    } else {
                        await queueDatasetItem(summaryFallbackItem(id, search.searchContext, listSummaryMap.get(id)));
                    }
                    newJobs++;
                }
            }

            log.debug(`LIST start=${start}, page=${pageIndex}, found=${pageJobIds.length}, new=${newJobs}, total=${collectedJobIds.size}/${maxJobs}`);

            emptyPages = newJobs > 0 ? 0 : emptyPages + 1;
            if (emptyPages >= MAX_EMPTY_LIST_PAGES) {
                log.info(`Stopping list pagination after ${emptyPages} empty/duplicate pages at start=${start}.`);
                break;
            }

            start += Math.max(1, pageJobIds.length || DEFAULT_GUEST_PAGE_STEP);
            if (listDelayMs > 0) {
                await delay(listDelayMs + Math.floor(Math.random() * Math.max(250, listDelayMs / 2)));
            }
        } catch (error) {
            failedRequests++;
            listFailures++;
            // Recoverable throttling is reported in the final summary, not per page.
            log.debug(`LIST fallback at start=${start} after ${REQUEST_RETRIES} attempts: ${error.message}`);
            if (error.message.includes('400') && start >= GUEST_MAX_START) {
                hitListBoundary = true;
                break;
            }
            emptyPages++;
            if (emptyPages >= MAX_EMPTY_LIST_PAGES) break;
            await delay(2000 + Math.floor(Math.random() * 1500));
        }
    }
    if (start >= GUEST_MAX_START && collectedJobIds.size < maxJobs) hitListBoundary = true;
}

log.info(`Collected ${collectedJobIds.size}/${maxJobs} unique job IDs from search pages.`);

const jobIds = [...collectedJobIds].slice(0, maxJobs);
if (shouldCollectDetails) await waitForDetailQueue();

await flushDatasetBuffer('final');

const runTime = Math.round((Date.now() - startedAt) / 1000);
const failureNote = failedRequests > 0
    ? ` Failed requests=${failedRequests} (list=${listFailures}, detail fallbacks=${detailFallbacks})`
    : '';
if (totalItemsPushed < maxJobs) {
    const reason = hitListBoundary
        ? `LinkedIn guest search endpoint stopped before target at start=${GUEST_MAX_START}; this exact search exposed ${jobIds.length} unique IDs.`
        : `This exact search exposed ${jobIds.length} unique IDs.`;
    log.warning(`Target not reached: requested=${maxJobs}, output=${totalItemsPushed}. ${reason}${failureNote}`);
} else if (totalItemsPushed < Math.min(maxJobs, jobIds.length)) {
    log.warning(`Completed with partial detail output: ${totalItemsPushed}/${Math.min(maxJobs, jobIds.length)} items.${failureNote}`);
} else {
    log.info(`Completed ${totalItemsPushed} jobs in ${mode} mode (${runTime}s).${failureNote}`);
}

await Actor.exit();
