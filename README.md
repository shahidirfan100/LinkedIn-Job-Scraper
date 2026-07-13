# LinkedIn Jobs Scraper

Extract comprehensive job listings from LinkedIn with detailed information including titles, companies, locations, salaries, and full descriptions. This tool is perfect for job market analysis, recruitment research, competitive intelligence, and employment data gathering at scale.

## Features

- **Complete Job Data** - Captures job titles, employer details, locations, salary ranges, applicant counts, employment types, seniority levels, and full job descriptions
- **Flexible Search** - Search by keywords, locations, and time filters (24 hours, 7 days, 30 days, or any time)
- **High Reliability** - Built-in error handling, retry mechanisms, and session management ensure consistent data collection
- **Proxy Support** - Works with residential proxies for stable access and reduced blocking
- **Customizable Output** - Control result limits and concurrency levels to match your needs
- **Structured Results** - Clean JSON output ready for databases, analytics, and reporting tools

## Use Cases

### Job Market Research
Analyze current hiring trends, salary ranges, and in-demand skills across industries and locations. Track how job requirements evolve over time.

### Recruitment Analytics
Discover where competitors are hiring, what roles they prioritize, and how they position job opportunities. Understand talent acquisition patterns in your industry.

### Data Analysis and Reporting
Build comprehensive employment datasets for business intelligence. Create reports on geographic job distribution, industry growth, and skill demand.

### Career Planning
Research salary expectations, job requirements, and career opportunities in specific fields. Identify high-demand roles and emerging job categories.

### Automated Monitoring
Schedule regular runs to track new job postings, monitor specific companies, or watch for opportunities matching your criteria.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | String | Yes | - | Job title or keywords to search (e.g., "software engineer") |
| `location` | String | No | `"United States"` | Geographic area for the job search |
| `timeRange` | String | No | `"anytime"` | Posting time filter: `"24h"`, `"7d"`, `"30d"`, or `"anytime"` |
| `maxJobs` | Integer | No | `20` | Maximum number of job listings to collect (1-1000) |
| `collectOnly` | Boolean | No | `false` | When enabled, collects only job URLs for faster processing |
| `maxConcurrency` | Integer | No | `5` | Number of simultaneous requests (1-20) |
| `proxyConfiguration` | Object | No | - | Proxy settings for enhanced reliability |

---

## Output Data

Each item in the dataset contains the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | String | Unique identifier for the job posting |
| `jobUrl` | String | Direct URL to the LinkedIn job listing |
| `title` | String | Job position title |
| `company` | String | Name of the hiring organization |
| `companyUrl` | String | Link to the company's LinkedIn page |
| `companyLogo` | String | URL of the company logo image |
| `location` | String | Geographic location of the position |
| `salary` | String | Salary information (when provided by employer) |
| `applicantsCount` | String | Number of applicants |
| `workType` | String | Employment type (Full-time, Part-time, etc.) |
| `seniority` | String | Experience level required |
| `jobFunction` | String | Job function category |
| `companyIndustry` | String | Industry sector |
| `postedAt` | String | When the job was posted |
| `descriptionText` | String | Plain-text version of the job description |
| `descriptionHtml` | String | HTML version of the job description |
| `collectedAt` | String | Timestamp of data extraction |
| `searchQuery` | String | The search keyword used |
| `searchLocation` | String | The location filter applied |
| `searchTimeRange` | String | The time range filter used |

---

## Usage Examples

### Basic Job Search

Search for software engineering positions:

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

Gather extensive data for market analysis:

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

---

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

---

## Tips for Best Results

### Optimize Search Terms
Use specific keywords that match actual job titles. Combine related terms for broader coverage. Test different variations to find the most relevant results.

### Manage Collection Size
Start with smaller batches (20-50 jobs) for testing and validation. Increase limits gradually based on your data needs and proxy capacity.

### Use Time Filters
Apply time range filters to focus on recent postings. The "24h" filter is ideal for daily monitoring while "7d" works well for weekly updates.

### Configure Proxies
Enable proxy configuration for better success rates, especially for larger collections. Residential proxies provide the best reliability.

### Monitor Performance
Review sample outputs to verify data quality. Adjust concurrency settings to balance speed and stability.

---

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

---

## Integrations

Connect your data with:

- **Google Sheets** - Export for analysis and reporting
- **Airtable** - Build searchable job databases
- **Slack** - Get notifications for new opportunities
- **Webhooks** - Send data to custom endpoints
- **Make** - Create automated job monitoring workflows
- **Zapier** - Trigger actions based on job postings

### Export Formats

Download data in multiple formats:

- **JSON** - For developers and APIs
- **CSV** - For spreadsheet analysis
- **Excel** - For business reporting
- **XML** - For system integrations

---

## Frequently Asked Questions

### How many jobs can I collect?
You can collect up to 1000 jobs per run. The practical limit depends on your search criteria and available results from LinkedIn.

### Can I search for jobs in multiple locations?
Yes, use broader location terms like "United States" or "Europe", or set location to "Worldwide" for global results.

### What if some job details are missing?
Some fields may be empty if the source does not provide that information. Salary data, for example, is only included when employers choose to list it.

### How often should I run the scraper?
Run frequency depends on your needs. For current opportunities, daily or weekly runs are common. Use the "24h" time filter for daily monitoring.

### Can I filter by company or industry?
Use specific keywords in your search query to target particular companies or roles. The output includes company name and industry for each job.

### Does this work without a proxy?
The tool works without a proxy, but using residential proxies significantly improves reliability, especially for larger collections.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with website terms of service and applicable laws. Use data responsibly and respect rate limits.
