import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { Impit } from 'impit';
import * as cheerio from 'cheerio';

const TPR_MAP = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };
const GUEST_LIST_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const BUILD_MARKER = '2026-07-13-quality-fix';
const getJobId = (str) => str?.match(/\d{8,}/)?.[0] || null;
const pick = (str) => (str || '').trim() || null;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const buildParams = (query, location, timeRange = 'anytime') => {
    const p = new URLSearchParams();
    if (query) p.set('keywords', query);
    if (location) p.set('location', location);
    if (timeRange && timeRange !== 'anytime') p.set('f_TPR', TPR_MAP[timeRange]);
    p.set('sortBy', 'R');
    return p;
};

const buildGuestListUrl = (params, start) => {
    const p = new URLSearchParams(params);
    p.set('start', String(start));
    return `${GUEST_LIST_ENDPOINT}?${p.toString()}`;
};

function extractJobIds($) {
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
}

async function fetchText(client, url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await delay((attempt - 1) * 500);
            const response = await client.fetch(url, {
                headers: { referer: 'https://www.linkedin.com/jobs/search/' },
            });
            if (!response.ok) continue;
            const text = await response.text();
            if (text && text.length > 100) return text;
        } catch {
            if (attempt < retries) await delay(500 * attempt);
        }
    }
    return null;
}

function extractDetail($html) {
    const textOf = (sel) => pick($html(sel).first().text());
    const hrefOf = (sel) => {
        const h = $html(sel).first().attr('href');
        return h ? (h.startsWith('http') ? h : new URL(h, 'https://www.linkedin.com').toString()) : null;
    };

    const title = textOf('h2.top-card-layout__title, h1.top-card-layout__title, h2.topcard__title');
    const company = textOf('a.topcard__org-name-link, div.topcard__org-name-link');
    const companyUrl = hrefOf('a.topcard__org-name-link');
    const companyLogo = $html('img.artdeco-entity-image').attr('data-delayed-url') || null;
    const salary = textOf('div.salary, div.compensation__salary');
    const applicantsCount = textOf('figcaption.num-applicants__caption');

    let location = null;
    for (const s of ['span.topcard__flavor--bullet', 'span.job-result-card__location', 'div.topcard__flavor-row span:not(.topcard__org-name-link)', 'span.topcard__flavor:not(:first-child)']) {
        const raw = textOf(s);
        if (raw && raw.length > 1 && !raw.match(/\b(inc\.?|llc|corp)\b/i)) { location = raw; break; }
    }

    const postedAt = textOf('span.posted-time-ago__text, span.topcard__flavor--metadata');
    let seniority = null, workType = null, jobFunction = null, companyIndustry = null;
    $html('li.description__job-criteria-item').each((_, li) => {
        const h = $html(li).find('h3').text().toLowerCase();
        const val = pick($html(li).find('span.description__job-criteria-text').text());
        if (h.includes('seniority') || h.includes('level')) seniority = val;
        if (h.includes('employment') || h.includes('type')) workType = val;
        if (h.includes('function')) jobFunction = val;
        if (h.includes('industries')) companyIndustry = val;
    });

    let descriptionHtml = null, descriptionText = null;
    for (const sel of ['div.show-more-less-html__markup', 'div.description__text', 'section.show-more-less-html', 'div.jobs-description__content', 'article.jobs-description']) {
        const node = $html(sel).first();
        if (node && node.length) {
            const html = node.html();
            const text = pick(node.text());
            if (text && text.length > 30) { descriptionHtml = html; descriptionText = text; break; }
        }
    }

    return { title, company, companyUrl, companyLogo, location, salary, applicantsCount, postedAt, workType, seniority, jobFunction, companyIndustry, descriptionHtml, descriptionText };
}

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
// INPUT NORMALIZATION (same as pasted code)
// -----------------------------------------------------------------

const normalizeInput = (input) => {
    const { urls, keywords, query, location, timeRange, maxJobs, startUrl, keyword, posted_date, results_wanted } = input;
    const hasUrls = (urls && urls.length) || (startUrl && typeof startUrl === 'string' && startUrl.trim());
    const hasKeywords = (keywords && keywords.length) || (keyword && typeof keyword === 'string' && keyword.trim());
    const hasLegacyQuery = query && typeof query === 'string' && query.trim();

    if (!hasUrls && !hasKeywords && !hasLegacyQuery) {
        log.warning('No input provided. Using default keyword "software engineer".');
        return {
            mode: 'keyword', urls: [], keywords: ['software engineer'], location: '',
            timeRange: 'anytime', maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || Number(results_wanted) || 20)),
        };
    }

    if (hasUrls) {
        const processedUrls = startUrl ? [startUrl] : urls;
        for (const u of processedUrls) {
            if (typeof u !== 'string' || !u.includes('linkedin.com')) throw new Error(`Invalid LinkedIn URL: ${u}`);
        }
        return { mode: 'url', urls: processedUrls, keywords: [], location: location || '', timeRange: timeRange || posted_date || 'anytime', maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || Number(results_wanted) || 20)) };
    }

    const processedKeywords = keyword ? [keyword] : hasKeywords ? keywords : [query];
    return { mode: 'keyword', urls: [], keywords: processedKeywords, location: location || '', timeRange: timeRange || posted_date || 'anytime', maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || Number(results_wanted) || 20)) };
};

// -----------------------------------------------------------------
// DATASET BUFFER (from pasted code)
// -----------------------------------------------------------------

const datasetBuffer = [];
let totalItemsPushed = 0;

const flushDataset = async () => {
    if (!datasetBuffer.length) return;
    const items = datasetBuffer.splice(0, datasetBuffer.length);
    await Dataset.pushData(items);
    totalItemsPushed += items.length;
    log.info(`Flushed ${items.length} items to dataset (total=${totalItemsPushed})`);
};

const queueItem = async (item) => {
    datasetBuffer.push(item);
    if (datasetBuffer.length >= 25) await flushDataset();
};

// -----------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------

await Actor.init();
const input = (await Actor.getInput()) || {};
const {
    proxyConfiguration, collectOnly = false, maxConcurrency = 5,
} = input;

const parsed = normalizeInput(input);
const { mode, urls, keywords, location: searchLocation, timeRange, maxJobs: targetJobs } = parsed;

log.info(`Searching "${keywords[0] || urls[0]}" target=${targetJobs} mode=${mode}`);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
const hasProxy = proxyConfig && (Actor.isAtHome() || process.env.APIFY_PROXY_PASSWORD);

const MAX_LIST_PAGES = Math.ceil(targetJobs / 5) + 5;
const MAX_EMPTY_PAGES = 3;
const concurrency = Math.max(1, Math.min(10, Number(maxConcurrency) || 5));

// ---------- COLLECT JOB IDS (fixed pagination) ----------

const allJobIds = [];
let emptyPages = 0;

if (mode === 'url') {
    for (const url of urls) {
        const jobId = getJobId(url);
        if (jobId && !allJobIds.includes(jobId)) allJobIds.push(jobId);
    }
} else {
    const client = new Impit({ browser: 'chrome', ignoreTlsErrors: true });
    const params = buildParams(keywords[0], searchLocation, timeRange);
    let start = 0;

    for (let page = 0; page < MAX_LIST_PAGES && allJobIds.length < targetJobs; page++) {
        const url = buildGuestListUrl(params, start);
        const html = await fetchText(client, url);
        if (!html) { emptyPages++; if (emptyPages >= MAX_EMPTY_PAGES) break; continue; }
        emptyPages = 0;

        const $ = cheerio.load(html);
        const ids = extractJobIds($);
        if (!ids.length) break;

        let newCount = 0;
        for (const id of ids) {
            if (!allJobIds.includes(id) && allJobIds.length < targetJobs) { allJobIds.push(id); newCount++; }
        }
        const pageSize = ids.length;
        start += pageSize;
        log.debug(`List page ${page}: start=${start - pageSize}, ids=${ids.length}, new=${newCount}, total=${allJobIds.length}`);
    }
}

const selectedIds = allJobIds.slice(0, targetJobs);
if (selectedIds.length < targetJobs) log.warning(`Only found ${selectedIds.length} jobs (requested ${targetJobs})`);
if (!selectedIds.length) { log.warning('No jobs found'); await Actor.exit(); }

// ---------- COLLECT DETAILS ----------

if (collectOnly) {
    const now = new Date().toISOString();
    for (const id of selectedIds) {
        await queueItem({
            jobUrl: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
            jobId: id, collectedAt: now,
            searchQuery: keywords[0] || '', searchLocation, searchTimeRange: timeRange,
        });
    }
    await flushDataset();
    log.info(`Saved ${selectedIds.length} link-only items`);
    await Actor.exit();
}

let client = new Impit({ browser: 'chrome', ignoreTlsErrors: true });
for (let i = 0; i < selectedIds.length; i += concurrency) {
    const batch = selectedIds.slice(i, i + concurrency);
    if (hasProxy) {
        const proxyUrl = await proxyConfig.newUrl();
        client = new Impit({ browser: 'chrome', ignoreTlsErrors: true, proxyUrl });
    }

    const results = await Promise.all(batch.map(async (jobId) => {
        const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
        const html = await fetchText(client, url, 2);
        let detail = {};
        if (html) {
            const $ = cheerio.load(html);
            detail = extractDetail($);

            // Fallback: try a second endpoint if description is missing
            if (!detail.descriptionText || detail.descriptionText.length < 50) {
                const fallbackHtml = await fetchText(client, `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`, 1);
                if (fallbackHtml) {
                    const $2 = cheerio.load(fallbackHtml);
                    const fallbackDetail = extractDetail($2);
                    if (fallbackDetail.descriptionText && fallbackDetail.descriptionText.length > 50) {
                        detail = fallbackDetail;
                    }
                }
            }
        }
        return {
            jobUrl: url,
            jobId,
            title: detail.title || null,
            company: detail.company || null,
            companyUrl: detail.companyUrl || null,
            companyLogo: detail.companyLogo || null,
            location: validateLocation(detail.location, detail.company) || detail.location,
            salary: detail.salary || null,
            applicantsCount: detail.applicantsCount || null,
            postedAt: detail.postedAt || null,
            workType: detail.workType || null,
            seniority: detail.seniority || null,
            jobFunction: detail.jobFunction || null,
            companyIndustry: detail.companyIndustry || null,
            descriptionText: detail.descriptionText || null,
            descriptionHtml: detail.descriptionHtml || null,
            collectedAt: new Date().toISOString(),
            searchQuery: keywords[0] || '', searchLocation, searchTimeRange: timeRange,
        };
    }));

    for (const item of results) await queueItem(item);
}

await flushDataset();
log.info(`Completed ${selectedIds.length} jobs`);
await Actor.exit();
