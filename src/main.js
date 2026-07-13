import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { Impit } from 'impit';
import * as cheerio from 'cheerio';

const TPR_MAP = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };
const getJobId = (str) => str?.match(/\d{8,}/)?.[0] || null;
const pick = (str) => (str || '').trim() || null;

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
    return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
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
            const response = await client.fetch(url, {
                headers: { referer: 'https://www.linkedin.com/jobs/search/' },
            });
            if (!response.ok) {
                if (attempt < retries) await new Promise(r => setTimeout(r, 500 * attempt));
                continue;
            }
            const text = await response.text();
            if (text && text.length > 100) return text;
        } catch {
            if (attempt < retries) await new Promise(r => setTimeout(r, 500 * attempt));
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

await Actor.init();
const input = (await Actor.getInput()) || {};
const {
    query, location, timeRange, maxJobs, results_wanted,
    keyword, keywords, posted_date,
    proxyConfiguration, collectOnly = false,
    maxConcurrency = 10,
} = input;

const searchQuery = keyword || query || (Array.isArray(keywords) ? keywords[0] : null) || 'software engineer';
const searchLocation = location || '';
const searchTimeRange = timeRange || posted_date || 'anytime';
const targetJobs = Math.max(1, Math.min(1000, Number(maxJobs) || Number(results_wanted) || 20));

log.info(`Searching "${searchQuery}" target=${targetJobs}`);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
const hasProxy = proxyConfig && (Actor.isAtHome() || process.env.APIFY_PROXY_PASSWORD);

const client = new Impit({ browser: 'chrome', ignoreTlsErrors: true });

const PAGE_SIZE = 30;
const MAX_LIST_PAGES = 40;
const params = buildParams(searchQuery, searchLocation, searchTimeRange);

log.info(`Fetching list pages...`);
const allJobIds = [];
for (let i = 0; i < MAX_LIST_PAGES && allJobIds.length < targetJobs * 2; i++) {
    const url = buildGuestListUrl(params, i * PAGE_SIZE);
    const html = await fetchText(client, url);
    if (!html) continue;
    const $ = cheerio.load(html);
    const ids = extractJobIds($);
    for (const id of ids) {
        if (!allJobIds.includes(id)) allJobIds.push(id);
    }
}

const selectedIds = allJobIds.slice(0, targetJobs);
log.info(`Collected ${selectedIds.length} job IDs`);

if (selectedIds.length === 0) {
    log.warning('No jobs found');
    await Actor.exit();
}

if (collectOnly) {
    const now = new Date().toISOString();
    await Dataset.pushData(selectedIds.map(id => ({
        jobUrl: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
        jobId: id, collectedAt: now,
        searchQuery, searchLocation, searchTimeRange,
    })));
    log.info(`Saved ${selectedIds.length} link-only items`);
    await Actor.exit();
}

const concurrency = maxConcurrency;
const output = [];
let detailClient = client;

for (let i = 0; i < selectedIds.length; i += concurrency) {
    const batch = selectedIds.slice(i, i + concurrency);
    if (hasProxy) {
        const proxyUrl = await proxyConfig.newUrl();
        detailClient = new Impit({ browser: 'chrome', ignoreTlsErrors: true, proxyUrl });
    }
    const results = await Promise.all(batch.map(async (jobId) => {
        const html = await fetchText(detailClient, `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`);
        let detail = {};
        if (html) {
            const $ = cheerio.load(html);
            detail = extractDetail($);
        }
        return {
            jobUrl: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
            jobId,
            title: detail.title || null,
            company: detail.company || null,
            companyUrl: detail.companyUrl || null,
            companyLogo: detail.companyLogo || null,
            location: detail.location || null,
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
            searchQuery, searchLocation, searchTimeRange,
        };
    }));
    output.push(...results);
    if (output.length >= 25) {
        await Dataset.pushData(output.splice(0, 25));
    }
}

if (output.length > 0) {
    await Dataset.pushData(output);
}
log.info(`Completed ${selectedIds.length} jobs`);
await Actor.exit();
