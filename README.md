# LinkedIn Jobs Scraper

Extract comprehensive job listings from LinkedIn with ease. Collect detailed job information including titles, companies, locations, and descriptions at scale. Perfect for job market analysis, opportunity discovery, and employment data gathering.

## Features

- **Comprehensive Data Extraction** — Captures essential job details including position titles, employer information, geographic locations, and complete job descriptions
- **Flexible Search Capabilities** — Customize searches with specific keywords, target locations, and time-based filters to focus on relevant job markets
- **High Success Rates** — Reliable data collection with built-in error handling and retry mechanisms
- **Proxy Integration** — Leverages residential IP addresses to maintain anonymity and prevent detection
- **Customizable Parameters** — Control result limits and concurrency levels to optimize performance
- **Structured JSON Results** — Outputs clean, machine-readable data perfect for integration with databases and analytics tools

## Use Cases

### Job Market Research
Analyze current job trends and market demands across industries. Understand salary ranges, required skills, and geographic distribution of opportunities.

### Recruitment and Talent Acquisition
Discover qualified candidates by monitoring job postings from target companies. Track hiring patterns and identify emerging skill requirements.

### Competitive Intelligence
Monitor competitor hiring activities and organizational changes. Gain insights into industry movements and strategic workforce planning.

### Data Analysis and Reporting
Build comprehensive datasets for business intelligence and decision making. Create reports on employment trends, geographic job distribution, and industry growth areas.

### Career Planning and Job Search
Research salary expectations, job requirements, and career opportunities in specific fields. Identify high-demand skills and emerging job categories.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | String | Yes | — | Search terms for job titles or skills (e.g., "software engineer") |
| `location` | String | No | "Worldwide" | Geographic area for job search (e.g., "New York", "London") |
| `timeRange` | String | No | "anytime" | Time frame for job postings: "24h", "7d", "30d", or "anytime" |
| `maxJobs` | Integer | No | `20` | Maximum number of job listings to extract (1-1000) |
| `collectOnly` | Boolean | No | `false` | When enabled, gathers only job URLs for faster processing |
| `maxConcurrency` | Integer | No | `5` | Number of simultaneous requests (1-10) |
| `proxyConfiguration` | Object | No | — | Proxy settings for enhanced anonymity |

## Output Data

Each item in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `jobUrl` | String | Direct hyperlink to the LinkedIn job listing |
| `jobId` | String | Unique identifier for the job posting |
| `title` | String | Job position title |
| `company` | String | Organization offering the position |
| `companyUrl` | String | Link to the company's LinkedIn page |
| `location` | String | Geographic location of the job |
| `postedAt` | String | Publication date of the job posting |
| `workType` | String | Employment classification (Full-time, Part-time, etc.) |
| `seniority` | String | Experience level required |
| `collectedAt` | String | Timestamp of data extraction |
| `searchQuery` | String | The search keyword used |
| `searchLocation` | String | The location filter applied |
| `searchTimeRange` | String | The time range filter applied |
| `descriptionHtml` | String | HTML content of the job description |
| `descriptionText` | String | Plain-text job posting content |

## Usage Examples

### Basic Job Search

Extract recent software engineering positions:

```json
{
    "query": "software engineer",
    "location": "United States",
    "maxJobs": 50
}
```

### Advanced Filtering

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

### High-Volume Collection

Gather extensive job data for market analysis:

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

## Sample Output

```json
{
    "jobUrl": "https://www.linkedin.com/jobs/view/senior-software-engineer",
    "jobId": "4334367155",
    "title": "Senior Software Engineer",
    "company": "Tech Innovations Inc",
    "companyUrl": "https://www.linkedin.com/company/tech-innovations",
    "location": "San Francisco, CA",
    "postedAt": "2 days ago",
    "workType": "Full-time",
    "seniority": "Mid-Senior level",
    "collectedAt": "2024-01-15T10:30:00Z",
    "searchQuery": "software engineer",
    "searchLocation": "United States",
    "searchTimeRange": "anytime",
    "descriptionHtml": "<p>Join our team to build cutting-edge solutions...</p>",
    "descriptionText": "Join our team to build cutting-edge solutions..."
}
```

## Tips for Best Results

### Optimize Search Parameters
- Use specific keywords that match actual job titles
- Combine multiple related terms for broader results
- Target specific locations for more relevant data

### Manage Result Volume
- Start with smaller batches (20-50 jobs) for testing
- Increase limits gradually based on your needs
- Use time filters to focus on recent postings

### Enhance Reliability
- Enable proxy configuration for better success rates
- Adjust concurrency based on your proxy capacity
- Monitor for any rate limiting and adjust accordingly

### Data Quality Checks
- Review sample outputs before full runs
- Verify location and time filters are working as expected
- Check for complete job descriptions in results

## Proxy Configuration

For reliable results, residential proxies are recommended:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

## Integrations

Connect your data with:

- **Google Sheets** — Export for analysis and reporting
- **Airtable** — Build searchable job databases
- **Slack** — Get notifications for new opportunities
- **Webhooks** — Send data to custom endpoints
- **Make** — Create automated job monitoring workflows
- **Zapier** — Trigger actions based on job postings

### Export Formats

Download data in multiple formats:

- **JSON** — For developers and APIs
- **CSV** — For spreadsheet analysis
- **Excel** — For business reporting
- **XML** — For system integrations

## Frequently Asked Questions

### How many jobs can I collect?
You can collect up to 1000 jobs per run. The practical limit depends on your search criteria and available results.

### Can I search for jobs in multiple locations?
Yes, use broader location terms like "United States" or "Europe", or set location to "Worldwide" for global results.

### What if some job details are missing?
Some fields may be empty if the source doesn't provide that information. This is normal and doesn't indicate an error.

### How often should I run the scraper?
Run frequency depends on your needs. For current opportunities, daily or weekly runs are common.

### Can I filter by salary information?
Salary data is included when provided by employers. Use the description field to search for compensation details.

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with website terms of service and applicable laws. Use data responsibly and respect rate limits.
