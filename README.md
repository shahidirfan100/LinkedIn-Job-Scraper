# LinkedIn Jobs Scraper

[![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)](https://apify.com)

This Apify actor scrapes job listings from LinkedIn based on your specified search criteria. It retrieves comprehensive job details to help you analyze job markets, track opportunities, or gather data for research purposes.

## Features

- **Comprehensive Job Data**: Extracts key job information including title, company name, location, salary range (when available), job type, and full job descriptions.
- **Flexible Search Parameters**: Supports custom search queries, locations, and time ranges to target specific job markets.
- **High Success Rate**: Employs advanced techniques to bypass common scraping restrictions and ensure reliable data collection.
- **Proxy Support**: Integrates with Apify Proxy for residential IPs to avoid detection and improve scraping performance.
- **Configurable Limits**: Allows setting maximum number of jobs to scrape and concurrency levels for efficient processing.
- **JSON Output**: Delivers results in structured JSON format for easy integration with other tools and workflows.

## Input

The actor accepts input parameters in JSON format. Below is the schema with descriptions:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | Yes | - | The search query for job titles or keywords (e.g., "software engineer", "data analyst"). |
| `location` | string | No | "Worldwide" | The location to search for jobs (e.g., "New York", "London", "Remote"). |
| `timeRange` | string | No | "24h" | Time range for job postings: "24h", "7d", "30d", or "any". |
| `maxJobs` | number | No | 50 | Maximum number of jobs to scrape (1-1000). |
| `collectOnly` | boolean | No | false | If true, only collects job URLs without scraping full details (faster but less data). |
| `maxConcurrency` | number | No | 5 | Number of concurrent requests (1-10). Higher values may increase speed but risk blocking. |
| `proxyConfiguration` | object | No | - | Proxy settings. See [Apify Proxy documentation](https://docs.apify.com/proxy) for details. |

### Example Input

```json
{
  "query": "machine learning engineer",
  "location": "San Francisco",
  "timeRange": "7d",
  "maxJobs": 100,
  "collectOnly": false,
  "maxConcurrency": 3,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "groups": ["RESIDENTIAL"]
  }
}
```

## Output

The actor outputs a JSON array of job objects. Each job object contains the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | The job title. |
| `company` | string | The company name. |
| `location` | string | The job location. |
| `salary` | string | Salary range or information (if available). |
| `jobType` | string | Type of employment (e.g., Full-time, Part-time). |
| `description` | string | Full job description text. |
| `url` | string | Direct link to the job posting on LinkedIn. |
| `postedDate` | string | Date when the job was posted. |
| `scrapedAt` | string | Timestamp when the data was scraped. |

### Example Output

```json
[
  {
    "title": "Machine Learning Engineer",
    "company": "TechCorp Inc.",
    "location": "San Francisco, CA",
    "salary": "$120,000 - $160,000 per year",
    "jobType": "Full-time",
    "description": "We are looking for a skilled Machine Learning Engineer to join our team...",
    "url": "https://www.linkedin.com/jobs/view/machine-learning-engineer-at-techcorp-123456",
    "postedDate": "2023-10-25",
    "scrapedAt": "2023-10-28T10:30:00Z"
  }
]
```

## Usage

### Via Apify Console

1. Go to the [LinkedIn Jobs Scraper](https://apify.com/shahidirfan100/linkedin-jobs-scraper) page on Apify.
2. Click **Run** to start the actor.
3. Provide your input parameters in the JSON editor.
4. Monitor the run progress and download results when complete.

### Via Apify API

You can also run the actor programmatically using the Apify API:

```bash
curl -X POST "https://api.apify.com/v2/acts/shahidirfan100~linkedin-jobs-scraper/runs?token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "data scientist",
    "location": "Remote",
    "maxJobs": 50
  }'
```

Replace `YOUR_API_TOKEN` with your actual Apify API token.

### Retrieving Results

After the run completes, fetch the results:

```bash
curl "https://api.apify.com/v2/acts/shahidirfan100~linkedin-jobs-scraper/runs/LAST_RUN_ID/dataset/items?token=YOUR_API_TOKEN"
```

## Configuration

### Proxy Settings

For optimal performance and to avoid IP blocking, configure residential proxies:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "groups": ["RESIDENTIAL"]
  }
}
```

### Concurrency and Limits

- Adjust `maxConcurrency` based on your proxy plan (higher concurrency requires more proxies).
- Set `maxJobs` to limit the number of results and control costs.
- Use `collectOnly: true` for quick URL collection without full scraping.

### Error Handling

The actor handles common errors like rate limiting and temporary blocks automatically. If persistent issues occur, try reducing concurrency or using different proxy groups.

## API Reference

- **Actor ID**: `shahidirfan100/linkedin-jobs-scraper`
- **Input Schema**: See Input section above
- **Output Schema**: See Output section above

For more details, visit the [Apify documentation](https://docs.apify.com/actors).

## Changelog

### v1.0.0
- Initial release with basic LinkedIn job scraping functionality.

## License

This actor is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.

---

*Built with ❤️ on the Apify platform.*
