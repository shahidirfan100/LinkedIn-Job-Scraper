/**
 * LinkedIn Jobs Scraper (Optimized for Speed, v4)
 * - Parallel list fetching with aggressive pagination
 * - Immediate detail processing without waiting for all lists
 * - Higher concurrency with smart request prioritization
 * - Faster fallback strategies
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

const collected = new Set();
const enqueuedDetails = new Set();
const processedDetails = new Set();
let listPagesEnqueued = 0;
let maxJobsReached = false;

const DEFAULT_HEADERS = {
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'sec-fetch-user': '?1', // This was likely intended to be 'sec-fetch-user'
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'referer': 'https://www.linkedin.com/',
};

async function fetchGuestDetailHtml(jobId, proxyUrl) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  try {
    const res = await gotScraping({
      url,
      headers: DEFAULT_HEADERS,
      proxyUrl,
      timeout: { request: 15000 },
      retry: { limit: 0 },
    });
    if (res.statusCode >= 200 && res.statusCode < 300 && res.body && res.body.length > 200) {
      return res.body;
    }
  } catch (e) {
    log.debug(`Guest detail fetch failed: ${e.message}`);
  }
  return null;
}

function extractDescription($) {
  const containers = [
    'div.show-more-less-html__markup',
    'div.description__text',
    '#job-details',
    'div.jobs-description__container',
    'div.jobs-description-content__text',
    'section.jobs-description',
    'div.jobs-box__html-content'
  ];
  for (const sel of containers) {
    const node = $(sel).first();
    if (node && node.length) {
      const html = node.html();
      const text = pick(node.text());
      if (text && text.length > 50) return { html, text };
    }
  }
  return { html: null, text: null };
}

function extractJobData($html, url, query, location, timeRange) {
  const title = textOf($html, 'h1.top-card-layout__title, h1.jobs-unified-top-card__job-title, h2.top-card-layout__title, h1');
  const company = textOf($html, 'a.topcard__org-name-link, span.jobs-unified-top-card__company-name, a.sub-nav-cta__optional-url');
  const companyUrl = hrefOf($html, 'a.topcard__org-name-link, a.jobs-unified-top-card__company-name, a.sub-nav-cta__optional-url');
  const loc = textOf($html, 'span.jobs-unified-top-card__bullet, span.topcard__flavor--bullet, span.jobs-unified-top-card__bullet');
  const postedAt = textOf($html, 'span.jobs-unified-top-card__posted-date, span.posted-time-ago__text, span.jobs-unified-top-card__subtitle-primary-grouping');
  const workType = textOf($html, 'span.jobs-unified-top-card__workplace-type, span.jobs-unified-top-card__job-insight');

  let seniority = null;
  $html('li.job-criteria__item, li.jobs-unified-top-card__job-insight').each((_, li) => {
    const h = $html(li).find('h3').text().toLowerCase();
    if (h.includes('seniority') || h.includes('level')) {
      seniority = pick($html(li).find('span.job-criteria__text--body, span').first().text());
    }
  });

  let applyUrl = $html('a[data-tracking-control-name*="jobdetails_topcard_inapply"], a[href*="apply"], a.jobs-apply-button').first().attr('href') || null;
  applyUrl = applyUrl ? abs(applyUrl) : url;

  return {
    jobUrl: url,
    jobId: getJobId(url),
    title, company, companyUrl,
    location: loc, postedAt, workType, seniority,
    applyUrl,
    collectedAt: new Date().toISOString(),
    searchQuery: query,
    searchLocation: location,
    searchTimeRange: timeRange,
  };
}

await Actor.init();
const input = await Actor.getInput() || {};
const {
  query = 'Software Engineer',
  location = 'United States',
  timeRange = 'anytime',
  maxJobs = 150,
  collectOnly = false,
  maxConcurrency = 15,
  proxyConfiguration,
  aggressivePagination = true,
} = input;

if (!query?.trim()) throw new Error('Input "query" is required.');
const params = buildParams(query.trim(), location?.trim(), timeRange);
const searchUrl = buildSearchUrl(params);
log.info(`Search URL: ${searchUrl}`);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
const concurrency = Math.max(5, Math.min(30, Number(maxConcurrency) || 15));

const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  maxRequestsPerCrawl: (maxJobs || 150) * 2 + 100,
  maxConcurrency: concurrency,
  requestHandlerTimeoutSecs: 20,
  navigationTimeoutSecs: 20,
  maxRequestRetries: 2,
  requestHandler: async (ctx) => {
    const { request, $, addRequests, proxyInfo } = ctx;

    if (request.userData.label === 'LIST') {
      if (maxJobsReached) {
        log.info(`Max jobs reached, skipping list page at start=${request.userData.start}`);
        return;
      }

      // Extract job links
      const links = [];
      $('a[href*="/jobs/view/"], a[href*="/jobs-guest/jobs/api/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('/jobs/view/') || href.includes('/jobs-guest/'))) {
          const fullUrl = abs(href);
          if (fullUrl.includes('/jobs/view/') || fullUrl.includes('/jobs-guest/')) {
            links.push(fullUrl);
          }
        }
      });

      // Also extract from base-card links
      $('div.base-card, li.jobs-search-results__list-item').each((_, card) => {
        const link = $(card).find('a.base-card__full-link, a[href*="/jobs/view/"]').first();
        const href = link.attr('href');
        if (href) links.push(abs(href));
      });

      const uniqueLinks = [...new Set(links)];
      for (const u of uniqueLinks) {
        if (!collected.has(u)) collected.add(u);
      }

      const startNum = request.userData.start || 0;
      log.info(`LIST start=${startNum}, found=${uniqueLinks.length}, total collected=${collected.size}`);

      // Aggressive pagination: enqueue next 3-5 pages immediately
      if (aggressivePagination && uniqueLinks.length > 0 && collected.size < maxJobs && listPagesEnqueued < 15) {
        const pagesToEnqueue = collected.size < maxJobs / 2 ? 5 : 3;
        const nextPages = [];
        for (let i = 1; i <= pagesToEnqueue; i++) {
          const nextStart = startNum + (25 * i);
          if (nextStart < maxJobs * 2) {
            nextPages.push({ 
              url: buildGuestListUrl(params, nextStart), 
              userData: { label: 'LIST', start: nextStart },
              priority: 10
            });
            listPagesEnqueued++;
          }
        }
        if (nextPages.length > 0) {
          await addRequests(nextPages);
          log.info(`Aggressively enqueued ${nextPages.length} list pages`);
        }
      } else if (uniqueLinks.length > 0 && collected.size < maxJobs) {
        const nextStart = startNum + 25;
        if (nextStart < maxJobs * 2) {
          await addRequests([{ 
            url: buildGuestListUrl(params, nextStart), 
            userData: { label: 'LIST', start: nextStart },
            priority: 10
          }]);
          listPagesEnqueued++;
        }
      }

      // Immediately enqueue details without waiting for all lists
      const toProcess = Array.from(collected).filter(u => !enqueuedDetails.has(u)).slice(0, maxJobs);
      
      if (toProcess.length === 0) {
        return;
      }

      if (collected.size >= maxJobs) {
        maxJobsReached = true;
      }

      if (collectOnly) {
        const now = new Date().toISOString();
        const items = toProcess.map(u => ({ 
          jobUrl: u, 
          jobId: getJobId(u), 
          collectedAt: now, 
          searchQuery: query, 
          searchLocation: location, 
          searchTimeRange: timeRange 
        }));
        await Dataset.pushData(items);
        log.info(`Pushed ${items.length} link-only items.`);
        toProcess.forEach(u => enqueuedDetails.add(u));
      } else {
        toProcess.forEach(u => enqueuedDetails.add(u));
        await addRequests(toProcess.map(u => ({ 
          url: u, 
          userData: { label: 'DETAIL' },
          priority: 5
        })));
        log.info(`Enqueued ${toProcess.length} detail URLs (immediate processing)`);
      }
      return;
    }

    // DETAIL handler
    if (processedDetails.has(request.url)) {
      log.debug(`Already processed: ${request.url}`);
      return;
    }
    processedDetails.add(request.url);

    let $html = $;
    let { html: descriptionHtml, text: descriptionText } = extractDescription($html);

    // Only use fallback if description is completely missing and we have job ID
    if (!descriptionText && request.url.includes('/jobs/view/')) {
      const jobId = getJobId(request.url);
      if (jobId) {
        const proxyUrl = proxyInfo?.url;
        const detailHtml = await fetchGuestDetailHtml(jobId, proxyUrl);
        if (detailHtml) {
          const cheerio = await import('cheerio');
          const _$ = cheerio.load(detailHtml);
          const desc = extractDescription(_$);
          if (desc.text && desc.text.length > 50) {
            descriptionHtml = desc.html;
            descriptionText = desc.text;
            $html = _$;
          }
        }
      }
    }

    const jobData = extractJobData($html, request.url, query, location, timeRange);
    jobData.descriptionHtml = descriptionHtml;
    jobData.descriptionText = descriptionText;

    await Dataset.pushData(jobData);
    log.info(`✓ Saved [${processedDetails.size}/${maxJobs}]: ${jobData.title || 'No title'} at ${jobData.company || 'Unknown'}`);

    if (processedDetails.size >= maxJobs) {
      maxJobsReached = true;
      log.info(`Reached maxJobs limit: ${maxJobs}`);
    }
  },
  failedRequestHandler: async ({ request }, error) => {
    log.error(`Request failed (${request.userData.label}): ${request.url} - ${error.message}`);
    if (request.userData.label === 'DETAIL') {
      processedDetails.add(request.url);
    }
  },
  preNavigationHooks: [
    async ({ request }) => {
      request.headers = { ...(request.headers || {}), ...DEFAULT_HEADERS };
    },
  ],
});

// Seed with first 3 list pages immediately for faster start
const initialPages = [
  { url: buildGuestListUrl(params, 0), userData: { label: 'LIST', start: 0 }, priority: 10 },
];

if (aggressivePagination !== false) {
  initialPages.push(
    { url: buildGuestListUrl(params, 25), userData: { label: 'LIST', start: 25 }, priority: 10 },
    { url: buildGuestListUrl(params, 50), userData: { label: 'LIST', start: 50 }, priority: 10 }
  );
  listPagesEnqueued = 3;
}

await crawler.addRequests(initialPages);
log.info(`Starting with ${initialPages.length} initial list pages, concurrency=${concurrency}`);

await crawler.run();

log.info(`Scraping completed: ${processedDetails.size} jobs processed, ${collected.size} total collected`);
await Actor.exit();