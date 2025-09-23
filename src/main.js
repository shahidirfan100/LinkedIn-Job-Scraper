import { Actor } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

const timeRangeMap = { '24h': '1', '3d': '3', '7d': '7', '14d': '14' };

const buildSearchUrl = (query, location, timeRange = 'anytime', start = 0) => {
    const p = new URLSearchParams();
    p.set('q', query);
    if (location) p.set('l', location);
    if (timeRange && timeRange !== 'anytime') p.set('fromage', timeRangeMap[timeRange]);
    p.set('start', String(start));
    return `https://www.indeed.com/jobs?${p.toString()}`;
};

const pick = (str) => (str || '').trim() || null;
const textOf = ($, sel) => pick($(sel).first().text());
const hrefOf = ($, sel, base) => {
    const h = $(sel).first().attr('href');
    return h ? new URL(h, base).toString() : null;
};

const getJobId = (el) => el.attr('data-jk');

async function main() {
    await Actor.init();
    const input = await Actor.getInput() || {};
    const {
        query = 'Software Engineer',
        location = 'United States',
        timeRange = 'anytime',
        maxJobs = 150,
        proxyConfiguration,
    } = input;

    if (!query?.trim()) throw new Error('Input "query" is required.');

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

    let jobsToScrape = [];
    let start = 0;
    while (jobsToScrape.length < maxJobs) {
        const searchUrl = buildSearchUrl(query.trim(), location?.trim(), timeRange, start);
        console.log(`Scraping ${searchUrl}`);

        const proxyUrl = proxyConfig ? proxyConfig.newUrl() : undefined;

        const response = await gotScraping({ url: searchUrl, proxyUrl });
        const $ = cheerio.load(response.body);

        const jobLinks = $('a.jcs-JobTitle[href^="/rc/clk"]');
        if (jobLinks.length === 0) {
            console.log('No more job links found.');
            break;
        }

        jobLinks.each((_, el) => {
            const href = $(el).attr('href');
            if (href) {
                const jobUrl = new URL(href, 'https://www.indeed.com').toString();
                if (jobsToScrape.length < maxJobs) {
                    jobsToScrape.push(jobUrl);
                }
            }
        });

        start += 10;
    }

    for (const jobUrl of jobsToScrape) {
        console.log(`Scraping job detail: ${jobUrl}`);
        const proxyUrl = proxyConfig ? proxyConfig.newUrl() : undefined;
        const response = await gotScraping({ url: jobUrl, proxyUrl });
        const $ = cheerio.load(response.body);

        const title = textOf($, 'h1.jobsearch-JobInfoHeader-title');
        const company = textOf($, 'div[data-company-name="true"] a');
        const companyUrl = hrefOf($, 'div[data-company-name="true"] a', jobUrl);
        const loc = textOf($, 'div[data-location="true"]');
        const descriptionNode = $('#jobDescriptionText').first();
        const descriptionHtml = descriptionNode.html();
        const descriptionText = pick(descriptionNode.text());

        await Dataset.pushData({
            jobUrl,
            title,
            company,
            companyUrl,
            location: loc,
            descriptionHtml,
            descriptionText,
            collectedAt: new Date().toISOString(),
            searchQuery: query,
            searchLocation: location,
            searchTimeRange: timeRange,
        });
    }

    await Actor.exit();
}

main();
