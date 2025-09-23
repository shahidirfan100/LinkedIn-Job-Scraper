/**
 * LinkedIn Jobs Scraper (HTTP + Cheerio, v3)
 * - Fixes requestAsBrowser import: uses gotScraping from 'got-scraping'
 */
import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log } from 'crawlee';
import { gotScraping } from 'got-scraping';

const tprMap = { '24h': 'r86400', '7d': 'r604800', '30d': 'r2592000' };
const abs = (href) => href?.startsWith('http') ? href : new URL(href, 'https://www.linkedin.com').toString();

const buildParams = (query, location, timeRange = 'anytime') => {
  const p = new URLSearchParams();
  if (query) p.set('keywords', query);
  if (location) p.set('location', location);
  if (timeRange && timeRange !== 'anytime') p.set('f_TPR', tprMap[timeRange]);
  p.set('sortBy', 'R');
  return p;
};

const buildSearchUrl = (params) => `https://www.linkedin.com/jobs/search/?${params.toString()}`;
const buildGuestListUrl = (params, start) => {
  const p = new URLSearchParams(params);
  p.set('start', String(start));
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
};

const pick = (str) => (str || '').trim() || null;
const textOf = ($, sel) => pick($(sel).first().text());
const hrefOf = ($, sel) => { const h = $(sel).first().attr('href'); return h ? abs(h) : null; };
const getJobId = (url) => url.match(/\d+/)?.[0] || null;

const collected = new Set();          // all collected job URLs
const enqueuedDetails = new Set();    // detail URLs already enqueued

const DEFAULT_HEADERS = {
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'referer': 'https.linkedin.com/',
};

async function fetchGuestDetailHtml(jobId, proxyUrl) {
  const candidates = [
    `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
    `https://www.linkedin.com/jobs-guest/jobs/api/viewJob/${jobId}`,
  ];
  for (const url of candidates) {
    try {
      const res = await gotScraping({
        url,
        headers: DEFAULT_HEADERS,
        proxyUrl,
        timeout: { request: 20000 },
      });
      if (res.statusCode >= 200 && res.statusCode < 300 && res.body && res.body.length > 200) {
        return res.body;
      }
    } catch (e) {
      log.debug(`Guest detail fetch failed for ${url}: ${e.message}`);
    }
  }
  return null;
}

function extractDescription($) {
  const containers = [
    'div.show-more-less-html__markup',
    '#job-details',
    'div.jobs-description__container',
    'div.jobs-description-content__text',
    'section.jobs-description'
  ];
  for (const sel of containers) {
    const node = $(sel).first();
    if (node && node.length) {
      const html = node.html();
      const text = pick(node.text());
      if (html || text) return { html, text };
    }
  }
  return { html: null, text: null };
}

await Actor.init();
const input = await Actor.getInput() || {};
const {
  query = 'Software Engineer',
  location = 'United States',
  timeRange = 'anytime',
  maxJobs = 150,
  collectOnly = false,
  maxConcurrency = 5,
  proxyConfiguration
} = input;

if (!query?.trim()) throw new Error('Input "query" is required.');
const params = buildParams(query.trim(), location?.trim(), timeRange);
const searchUrl = buildSearchUrl(params);
log.info(`Search URL: ${searchUrl}`);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  maxRequestsPerCrawl: (maxJobs || 150) + 50,
  maxConcurrency: Math.max(1, Math.min(20, Number(maxConcurrency) || 5)),
  requestHandlerTimeoutSecs: 25,
  navigationTimeoutSecs: 25,
  requestHandler: async (ctx) => {
    const { request, $, addRequests, proxyInfo } = ctx;

    if (request.userData.label === 'LIST') {
      // Extract job links
      const links = [];
      $('a[href*="/jobs/view/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('/jobs/view/')) links.push(abs(href));
      });
      for (const u of links) collected.add(u);
      log.info(`LIST start=${request.userData.start}, found=${links.length}, total=${collected.size}`);

      // paginate
      if (links.length > 0 && collected.size < maxJobs) {
        const nextStart = (request.userData.start || 0) + 25;
        await addRequests([{ url: buildGuestListUrl(params, nextStart), userData: { label: 'LIST', start: nextStart } }]);
      }

      // enqueue details or push link-only
      const toProcess = Array.from(collected).slice(0, maxJobs);
      if (collectOnly) {
        const now = new Date().toISOString();
        const items = toProcess.map(u => ({ jobUrl: u, jobId: getJobId(u), collectedAt: now, searchQuery: query, searchLocation: location, searchTimeRange: timeRange }));
        await Dataset.pushData(items);
        log.info(`Pushed ${items.length} link-only items.`);
      } else {
        const newOnes = toProcess.filter(u => !enqueuedDetails.has(u));
        if (newOnes.length) {
          newOnes.forEach(u => enqueuedDetails.add(u));
          await addRequests(newOnes.map(u => ({ url: u, userData: { label: 'DETAIL' } })));
          log.info(`Enqueued ${newOnes.length} detail URLs.`);
        }
      }
      return;
    }

    // DETAIL handler
    let $html = $;
    let { html: descriptionHtml, text: descriptionText } = extractDescription($html);

    if (!descriptionHtml && !descriptionText) {
      // Try guest detail API as fallback
      const jobId = getJobId(request.url);
      if (jobId) {
        const proxyUrl = proxyInfo?.url;
        const detailHtml = await fetchGuestDetailHtml(jobId, proxyUrl);
        if (detailHtml) {
          const cheerio = await import('cheerio');
          const _$ = cheerio.load(detailHtml);
          const desc = extractDescription(_$);
          descriptionHtml = desc.html;
          descriptionText = desc.text;
        }
      }
    }

    const title = textOf($html, 'h1.top-card-layout__title, h1.jobs-unified-top-card__job-title, h1');
    const company = textOf($html, 'a.topcard__org-name-link, span.jobs-unified-top-card__company-name');
    const companyUrl = hrefOf($html, 'a.topcard__org-name-link, a.jobs-unified-top-card__company-name');
    const loc = textOf($html, 'span.jobs-unified-top-card__bullet, span.topcard__flavor--bullet');
    const postedAt = textOf($html, 'span.jobs-unified-top-card__posted-date, span.posted-time-ago__text');
    const workType = textOf($html, 'span.jobs-unified-top-card__workplace-type');

    let seniority = null;
    $html('li.job-criteria__item').each((_, li) => {
      const h = $html(li).find('h3').text().toLowerCase();
      if (h.includes('seniority')) {
        seniority = pick($html(li).find('span.job-criteria__text--body').first().text());
      }
    });

    let applyUrl = $html('a[data-tracking-control-name*="jobdetails_topcard_inapply"], a[href*="apply"]').first().attr('href') || null;
    applyUrl = applyUrl ? abs(applyUrl) : request.url;

    await Dataset.pushData({
      jobUrl: request.url,
      jobId: getJobId(request.url),
      title, company, companyUrl,
      location: loc, postedAt, workType, seniority,
      descriptionHtml, descriptionText,
      applyUrl,
      collectedAt: new Date().toISOString(),
      searchQuery: query, searchLocation: location, searchTimeRange: timeRange,
    });
    log.info(`Saved job: ${request.url}`);
  },
  preNavigationHooks: [
    async ({ request }) => {
      request.headers = { ...(request.headers || {}), ...DEFAULT_HEADERS };
    },
  ],
});

// Seed with first guest list page
await crawler.addRequests([{ url: buildGuestListUrl(params, 0), userData: { label: 'LIST', start: 0 } }]);
await crawler.run();
await Actor.exit();
