/**
 * LinkedIn Jobs Scraper (Balanced Speed + Stealth, v5)
 * - Uses guest API endpoints exclusively (more reliable)
 * - Smart request delays to avoid 999 errors
 * - Session warmup for better success rate
 * - Optimized concurrency and pagination
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

const buildGuestListUrl = (params, start) => {
  const p = new URLSearchParams(params);
  p.set('start', String(start));
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p.toString()}`;
};

const pick = (str) => (str || '').trim() || null;
const textOf = ($, sel) => pick($(sel).first().text());
const hrefOf = ($, sel) => { const h = $(sel).first().attr('href'); return h ? abs(h) : null; };
const getJobId = (url) => url?.match(/\d{8,}/)?.[0] || null;

const collected = new Set();
const enqueuedDetails = new Set();
const processedDetails = new Set();
let listPagesEnqueued = 0;
let failedRequests = 0;

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

// Simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchGuestDetail(jobId, proxyUrl) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  try {
    await delay(Math.random() * 500 + 200); // Random delay 200-700ms
    const res = await gotScraping({
      url,
      headers: {
        ...DEFAULT_HEADERS,
        'referer': 'https://www.linkedin.com/jobs/search/',
      },
      proxyUrl,
      timeout: { request: 15000 },
      retry: { limit: 1 },
    });
    if (res.statusCode >= 200 && res.statusCode < 300 && res.body && res.body.length > 200) {
      return res.body;
    }
  } catch (e) {
    log.debug(`Guest detail fetch failed for ${jobId}: ${e.message}`);
  }
  return null;
}

function extractDescription($) {
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

function extractJobData($html, url, query, location, timeRange) {
  const title = textOf($html, 'h2.top-card-layout__title, h1.top-card-layout__title, h2.topcard__title');
  const company = textOf($html, 'a.topcard__org-name-link, div.topcard__org-name-link, span.topcard__flavor');
  const companyUrl = hrefOf($html, 'a.topcard__org-name-link');
  const loc = textOf($html, 'span.topcard__flavor--bullet, span.topcard__flavor');
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
  maxConcurrency = 8,
  proxyConfiguration,
} = input;

if (!query?.trim()) throw new Error('Input "query" is required.');
const params = buildParams(query.trim(), location?.trim(), timeRange);

log.info(`Starting scraper for: "${query}" in "${location}"`);

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
const concurrency = Math.max(3, Math.min(12, Number(maxConcurrency) || 8));

const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  maxRequestsPerCrawl: (maxJobs || 150) * 3,
  maxConcurrency: concurrency,
  requestHandlerTimeoutSecs: 30,
  navigationTimeoutSecs: 30,
  maxRequestRetries: 3,
  minConcurrency: Math.max(1, Math.floor(concurrency / 2)),
  
  requestHandler: async (ctx) => {
    const { request, $, addRequests, proxyInfo } = ctx;

    // Adaptive delay based on failure rate
    if (failedRequests > 5) {
      await delay(Math.random() * 1000 + 500);
    }

    if (request.userData.label === 'LIST') {
      if (collected.size >= maxJobs) {
        log.debug(`Max jobs reached, skipping list page`);
        return;
      }

      // Extract job IDs from list
      const jobIds = new Set();
      $('div.base-card').each((_, card) => {
        const $card = $(card);
        const entityUrn = $card.attr('data-entity-urn');
        if (entityUrn) {
          const match = entityUrn.match(/\d{8,}/);
          if (match) jobIds.add(match[0]);
        }
      });

      // Also extract from links as backup
      $('a[href*="jobs/view"], a[data-tracking-control-name*="job"]').each((_, el) => {
        const href = $(el).attr('href');
        const id = getJobId(href);
        if (id) jobIds.add(id);
      });

      const startNum = request.userData.start || 0;
      log.info(`LIST start=${startNum}, found=${jobIds.size} job IDs, total collected=${collected.size}`);

      // Build clean job URLs
      for (const id of jobIds) {
        const cleanUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;
        if (!collected.has(cleanUrl)) {
          collected.add(cleanUrl);
        }
      }

      // Conservative pagination - only enqueue next page if we found jobs
      if (jobIds.size > 0 && collected.size < maxJobs * 1.5) {
        const nextStart = startNum + 25;
        if (nextStart < maxJobs * 3) {
          await delay(Math.random() * 300 + 200); // Small delay between list pages
          await addRequests([{ 
            url: buildGuestListUrl(params, nextStart), 
            userData: { label: 'LIST', start: nextStart },
            priority: 8
          }]);
          listPagesEnqueued++;
        }
      }

      // Enqueue detail pages in batches
      const toProcess = Array.from(collected)
        .filter(u => !enqueuedDetails.has(u))
        .slice(0, maxJobs);
      
      if (toProcess.length === 0) return;

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
        log.info(`Pushed ${items.length} link-only items`);
        toProcess.forEach(u => enqueuedDetails.add(u));
      } else {
        // Process in smaller batches to avoid overwhelming
        const batchSize = Math.min(20, toProcess.length);
        const batch = toProcess.slice(0, batchSize);
        batch.forEach(u => enqueuedDetails.add(u));
        
        await addRequests(batch.map(u => ({ 
          url: u, 
          userData: { label: 'DETAIL', jobId: getJobId(u) },
          priority: 5
        })));
        log.info(`Enqueued ${batch.length} detail URLs (batch)`);
      }
      return;
    }

    // DETAIL handler - using guest API response directly
    if (processedDetails.has(request.url)) {
      log.debug(`Already processed: ${request.url}`);
      return;
    }

    const jobId = request.userData.jobId || getJobId(request.url);
    if (!jobId) {
      log.warning(`No job ID found for: ${request.url}`);
      return;
    }

    // The response IS the job detail HTML
    let $html = $;
    let { html: descriptionHtml, text: descriptionText } = extractDescription($html);

    // If we didn't get good data, the page might be a redirect - fetch the API directly
    if (!descriptionText || descriptionText.length < 50) {
      const apiHtml = await fetchGuestDetail(jobId, proxyInfo?.url);
      if (apiHtml) {
        const cheerio = await import('cheerio');
        $html = cheerio.load(apiHtml);
        const desc = extractDescription($html);
        descriptionHtml = desc.html;
        descriptionText = desc.text;
      }
    }

    const jobData = extractJobData($html, request.url, query, location, timeRange);
    jobData.descriptionHtml = descriptionHtml;
    jobData.descriptionText = descriptionText;

    // Only save if we got meaningful data
    if (jobData.title || descriptionText) {
      await Dataset.pushData(jobData);
      processedDetails.add(request.url);
      log.info(`✓ [${processedDetails.size}/${maxJobs}] ${jobData.title || 'Job'} at ${jobData.company || 'Company'}`);
    } else {
      log.warning(`Skipped job ${jobId} - no meaningful data extracted`);
    }

    if (processedDetails.size >= maxJobs) {
      log.info(`Reached target: ${maxJobs} jobs`);
    }
  },
  
  failedRequestHandler: async ({ request }, error) => {
    failedRequests++;
    log.error(`Request failed (${request.userData.label}): ${request.url.substring(0, 100)} - ${error.message}`);
    
    // Mark as processed to avoid retry loops
    if (request.userData.label === 'DETAIL') {
      processedDetails.add(request.url);
    }
    
    // If too many 999 errors, slow down dramatically
    if (error.message.includes('999') && failedRequests > 10) {
      log.warning(`High failure rate detected, reducing speed...`);
      await delay(2000);
    }
  },
  
  preNavigationHooks: [
    async ({ request }) => {
      request.headers = { 
        ...DEFAULT_HEADERS,
        'referer': 'https://www.linkedin.com/jobs/search/',
      };
    },
  ],
});

// Start with just 1 list page
log.info(`Starting with concurrency=${concurrency}, target=${maxJobs} jobs`);
await crawler.addRequests([
  { url: buildGuestListUrl(params, 0), userData: { label: 'LIST', start: 0 }, priority: 10 }
]);

await crawler.run();

log.info(`Scraping completed: ${processedDetails.size} jobs scraped, ${collected.size} total found`);
await Actor.exit();