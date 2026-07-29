## What does LinkedIn Jobs Scraper do?

LinkedIn Jobs Scraper collects job listings from LinkedIn based on your search keywords, location, and posting date. Enter a search term such as "software engineer" or "product manager", choose where to look, and the Actor returns structured job data including titles, companies, salaries, descriptions, and application details. It is designed for job market analysis, recruitment research, lead generation, and competitive hiring intelligence.

## Why use LinkedIn Jobs Scraper?

- **Structured job data at scale** - Collect hundreds of LinkedIn job listings in minutes with consistent output fields suitable for databases, analytics, and reporting.
- **Flexible search and filtering** - Search by keyword, geographic area, and posting time window (24 hours, 7 days, 30 days, or any time). Adjust result limits to match your workflow.
- **Automation-ready** - Run on demand or schedule repeat collections. Export datasets to JSON, CSV, Excel, or XML. Connect results to Google Sheets, webhooks, or no-code platforms.
- **Market and hiring intelligence** - Track hiring trends, salary ranges, employer activity, and in-demand skills across industries and locations.

## What data can you extract from LinkedIn Jobs?

| Field | Description |
|-------|-------------|
| `title` | Job position title |
| `company` | Name of the hiring organization |
| `location` | Geographic location of the position |
| `salary` | Salary information when provided by the employer |
| `workType` | Employment type (Full-time, Part-time, Contract, etc.) |
| `seniority` | Experience level required |
| `jobFunction` | Job function category |
| `companyIndustry` | Industry sector of the hiring company |
| `postedAt` | Relative posting time |
| `applicantsCount` | Number of applicants |
| `descriptionText` | Full job description in plain text |
| `jobUrl` | Direct URL to the LinkedIn job listing |

## How to use LinkedIn Jobs Scraper

1. Open the Actor on Apify Store.
2. Enter a job title or keywords in the search query field.
3. Optionally set a location filter and posting time range.
4. Set the maximum number of jobs to collect.
5. Run the Actor.
6. Download the dataset or connect it to your workflow.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | String | Yes | - | Job title or keywords to search on LinkedIn Jobs |
| `location` | String | No | `"United States"` | Geographic area for the job search |
| `timeRange` | String | No | `"anytime"` | Posting time filter: `"24h"`, `"7d"`, `"30d"`, or `"anytime"` |
| `maxJobs` | Integer | No | `20` | Maximum number of job listings to collect (1-1000) |
| `collectOnly` | Boolean | No | `false` | When enabled, collects job URLs only without detail pages for faster runs |
| `maxConcurrency` | Integer | No | `5` | Number of parallel detail requests (1-20) |
| `proxyConfiguration` | Object | No | Apify Proxy | Proxy settings for enhanced reliability |

## Output Data

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | String | Unique identifier for the job posting |
| `jobUrl` | String | Direct URL to the LinkedIn job listing |
| `title` | String | Job position title |
| `company` | String | Name of the hiring organization |
| `companyUrl` | String | Link to the company's LinkedIn page |
| `companyLogo` | String | URL of the company logo image |
| `location` | String | Geographic location of the position |
| `salary` | String | Salary information when provided by employer |
| `applicantsCount` | String | Number of applicants |
| `workType` | String | Employment type (Full-time, Part-time, etc.) |
| `seniority` | String | Experience level required |
| `jobFunction` | String | Job function category |
| `companyIndustry` | String | Industry sector |
| `postedAt` | String | When the job was posted |
| `descriptionText` | String | Plain-text version of the job description |
| `descriptionHtml` | String | HTML version of the job description |
| `collectedAt` | String | ISO timestamp of data extraction |
| `searchQuery` | String | The search keyword used |
| `searchLocation` | String | The location filter applied |
| `searchTimeRange` | String | The time range filter used |

## Usage Examples

### Basic Job Search

Collect software engineering jobs in the United States:

```json
{
  "query": "software engineer",
  "location": "United States",
  "maxJobs": 50
}
```

### Filtered Collection by Time and Location

Search for remote marketing jobs posted in the last week:

```json
{
  "query": "marketing manager",
  "location": "Remote",
  "timeRange": "7d",
  "maxJobs": 100,
  "maxConcurrency": 3
}
```

### High-Volume Collection with Proxies

Gather data scientist postings from the last 30 days:

```json
{
  "query": "data scientist",
  "location": "Worldwide",
  "timeRange": "30d",
  "maxJobs": 500,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Fast URL-Only Collection

Collect only job URLs without detail pages for quick scanning:

```json
{
  "query": "backend developer",
  "location": "Germany",
  "maxJobs": 200,
  "collectOnly": true
}
```

## Sample Output

```json
{
  "jobId": "4334367155",
  "jobUrl": "https://www.linkedin.com/jobs/view/4334367155",
  "title": "Senior Software Engineer",
  "company": "Tech Innovations Inc",
  "companyUrl": "https://www.linkedin.com/company/tech-innovations",
  "companyLogo": "https://media.licdn.com/demo/logo.png",
  "location": "San Francisco, CA",
  "salary": "$150,000 - $200,000",
  "applicantsCount": "Over 100 applicants",
  "workType": "Full-time",
  "seniority": "Mid-Senior level",
  "jobFunction": "Engineering and Information Technology",
  "companyIndustry": "Software Development",
  "postedAt": "1 week ago",
  "descriptionText": "Join our team to build cutting-edge solutions...",
  "descriptionHtml": "<p>Join our team to build cutting-edge solutions...</p>",
  "collectedAt": "2026-07-13T10:30:00Z",
  "searchQuery": "software engineer",
  "searchLocation": "United States",
  "searchTimeRange": "anytime"
}
```

## Tips for Best Results

- Use specific keywords that match actual job titles. Test different variations to find the most relevant results for your analysis.
- Start with a smaller result limit (20-50 jobs) for testing before scaling up to larger collections.
- Apply time range filters to focus on recent postings. Use `"24h"` for daily monitoring and `"7d"` for weekly updates.
- Enable proxy configuration with residential proxies for better success rates on larger collections.
- Some fields such as salary or applicants count may be empty if the employer did not publish that information on the listing.

## Integrations

- **Google Sheets** - Export job data to spreadsheets for analysis and reporting.
- **Webhooks** - Send run results to downstream systems after each collection.
- **Make or Zapier** - Connect job data to no-code automations and workflows.
- **API** - Access datasets programmatically from your own applications.
- **CSV, Excel, JSON, XML** - Download data in your preferred format from Apify Console.

## Frequently Asked Questions

### How many jobs can I collect per run?

Up to 1000 jobs per run. The actual number depends on how many results match your search criteria on LinkedIn.

### Can I search for jobs in multiple locations?

Yes. Use broader terms such as "United States" or "Europe", or set location to "Worldwide" for global coverage in a single run.

### What if some job details are missing from the output?

Some fields are empty when the employer chooses not to publish that information. Salary, applicants count, and seniority level are common examples. Always check multiple results before assuming the Actor missed data.

### How often should I run the scraper?

Run frequency depends on your use case. For daily monitoring of new opportunities, use the `"24h"` time filter and schedule a daily run. For broader market analysis, weekly or monthly runs are sufficient.

### Can I filter by company or industry?

Use specific company names or role keywords in your search query. The output includes company name and industry on every result, so you can filter after collection as well.

### Does this Actor require a proxy?

The Actor works without a proxy, but using Apify Proxy with residential groups improves reliability, especially for larger collections.

### Can I export the data to CSV or Excel?

Yes. Apify datasets can be downloaded in CSV, Excel, JSON, XML, and other formats from the Apify Console.

### Is it legal to scrape LinkedIn jobs?

Scraping publicly available job listing data may be legal, but you are responsible for complying with applicable laws, LinkedIn's terms of service, and data privacy regulations.

## Related Actors

- [Bayt Jobs Scraper](https://apify.com/shahidirfan/bayt-jobs-scraper) - Collect job listings from Bayt.com for Middle East and North Africa markets.
- [SimplyHired Job Scraper](https://apify.com/shahidirfan/simplyhired-job-scraper) - Extract job postings from SimplyHired across multiple countries.
- [Internshala Scraper](https://apify.com/shahidirfan/internshala-scrapper) - Gather internships and training opportunities from Internshala.

## Support

For issues, feature requests, or custom scraping projects, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor is designed for legitimate data collection from publicly available LinkedIn job listings. Users are responsible for using the data responsibly and complying with LinkedIn's terms of service, applicable laws, and data privacy regulations.
