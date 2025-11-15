# LinkedIn Jobs Scraper

[![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)](https://apify.com)
[![Run on Apify](https://img.shields.io/badge/Run%20on-Apify-green)](https://apify.com/shahidirfan100/linkedin-jobs-scraper)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Extract comprehensive job listings from LinkedIn with ease. This powerful scraper retrieves detailed job information including titles, companies, locations, salaries, and full descriptions to help you analyze job markets, discover opportunities, and gather valuable employment data.

## Table of Contents

- [Description](#description)
- [Features](#features)
- [Input](#input)
- [Output](#output)
- [Usage](#usage)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Changelog](#changelog)
- [License](#license)

## Description

The LinkedIn Jobs Scraper is a robust tool designed to extract job postings from LinkedIn's job search platform. Whether you're conducting market research, tracking industry trends, or building job databases, this scraper provides reliable access to current job opportunities across various industries and locations.

Perfect for recruiters, researchers, analysts, and anyone needing structured job data from LinkedIn's extensive job board.

## Features

- **Comprehensive Data Extraction**: Captures essential job details including position titles, employer information, geographic locations, compensation details, employment types, and complete job descriptions.
- **Flexible Search Capabilities**: Customize searches with specific keywords, target locations, and time-based filters to focus on relevant job markets.
- **Advanced Scraping Techniques**: Utilizes sophisticated methods to navigate LinkedIn's platform and ensure high success rates in data collection.
- **Proxy Integration**: Leverages Apify Proxy services with residential IP addresses to maintain anonymity and prevent detection during scraping operations.
- **Customizable Parameters**: Control scraping depth, concurrency levels, and result limits to optimize performance and resource usage.
- **Structured JSON Results**: Outputs clean, machine-readable data perfect for integration with databases, analytics tools, and automated workflows.

## Input

Configure your job scraping parameters using the following JSON schema:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search terms for job titles or skills (e.g., "software engineer", "marketing manager") |
| `location` | string | No | "Worldwide" | Geographic area for job search (e.g., "New York", "London", "Remote") |
| `timeRange` | string | No | "24h" | Time frame for job postings: "24h", "7d", "30d", or "any" |
| `maxJobs` | number | No | 50 | Maximum number of job listings to extract (range: 1-1000) |
| `collectOnly` | boolean | No | false | When enabled, gathers only job URLs for faster processing with minimal data |
| `maxConcurrency` | number | No | 5 | Number of simultaneous scraping requests (range: 1-10) |
| `proxyConfiguration` | object | No | - | Proxy settings for enhanced anonymity and performance |

### Input Example

```json
{
  "query": "artificial intelligence specialist",
  "location": "Silicon Valley",
  "timeRange": "7d",
  "maxJobs": 200,
  "collectOnly": false,
  "maxConcurrency": 4,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "groups": ["RESIDENTIAL"]
  }
}
```

## Output

Results are delivered as a JSON array containing detailed job objects with the following structure:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Job position title |
| `company` | string | Organization offering the position |
| `location` | string | Geographic location of the job |
| `salary` | string | Compensation information when disclosed |
| `jobType` | string | Employment classification (Full-time, Part-time, etc.) |
| `description` | string | Complete job posting content |
| `url` | string | Direct hyperlink to the original LinkedIn job listing |
| `postedDate` | string | Publication date of the job posting |
| `scrapedAt` | string | Timestamp of data extraction |

### Output Example

```json
[
  {
    "title": "Senior AI Engineer",
    "company": "Innovative Tech Solutions",
    "location": "San Francisco, CA",
    "salary": "$140,000 - $180,000 annually",
    "jobType": "Full-time",
    "description": "Join our cutting-edge team developing next-generation AI applications...",
    "url": "https://www.linkedin.com/jobs/view/senior-ai-engineer-at-innovative-tech-solutions-987654",
    "postedDate": "2023-11-10",
    "scrapedAt": "2023-11-15T14:20:00Z"
  }
]
```

## Usage

### Running via Apify Console

1. Navigate to the [LinkedIn Jobs Scraper](https://apify.com/shahidirfan100/linkedin-jobs-scraper) page on Apify.
2. Select **Run** to initiate the actor.
3. Input your desired parameters in the provided JSON editor.
4. Track execution progress and retrieve results upon completion.

### Running via Apify API

Execute the scraper programmatically using Apify's REST API:

```bash
curl -X POST "https://api.apify.com/v2/acts/shahidirfan100~linkedin-jobs-scraper/runs?token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "product manager",
    "location": "Remote",
    "maxJobs": 75
  }'
```

Replace `YOUR_API_TOKEN` with your personal Apify API token.

### Retrieving Results

Once execution finishes, download your dataset:

```bash
curl "https://api.apify.com/v2/acts/shahidirfan100~linkedin-jobs-scraper/runs/LAST_RUN_ID/dataset/items?token=YOUR_API_TOKEN"
```

## Configuration

### Proxy Configuration

Enhance scraping reliability and avoid IP restrictions with residential proxy setup:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "groups": ["RESIDENTIAL"]
  }
}
```

### Performance Tuning

- **Concurrency**: Increase `maxConcurrency` for faster processing, but monitor proxy availability.
- **Result Limits**: Use `maxJobs` to control dataset size and associated costs.
- **Quick Mode**: Enable `collectOnly` for rapid URL harvesting when full details aren't needed.

### Error Management

The scraper automatically manages common issues like rate limiting and temporary access blocks. For persistent problems, consider:
- Reducing concurrent connections
- Switching proxy groups
- Adjusting search parameters

### Troubleshooting & Debugging

- Check the actor logs in the Apify Console — look for recurring 4xx/5xx codes (rate limits or blocks) and response lengths that are zero or very short.
- If you see repeated list failures, reduce `maxConcurrency` or narrow the search query to fewer results.
- When detail fetches fail, set `collectOnly: true` to confirm the list pipeline still finds job URLs and to isolate the problem to detail scraping.
- Use proxy group rotation (switch residential vs. datacenter) and check `failureStreak*` log messages that indicate automated proxy rotation.

### Stealth & Speed Best Practices ⚡️🛡️

- Use randomized request headers and user agents to emulate a variety of browsers and platforms; enable the default proxy configuration to maintain session anonymity.
- Keep a small random delay between requests (jitter) and scale `maxConcurrency` to match your proxy capacity — a higher concurrency may be faster but increases the risk of throttling.
- Prefer smaller, repeated runs instead of a single massive scrape to reduce guest endpoint noise and to maintain data freshness.
- For highest stealth, run the actor with residential proxies and lower concurrency, then gradually increase until you find a reliable sweet spot.

### Dataset Schema & Tips for Discovery

The actor produces a dataset with structured fields that make it easy to analyze or import into downstream systems. Key fields include `jobId`, `jobUrl`, `title`, `company`, `companyUrl`, `location`, `jobType`, `salary`, `postedAt`, `descriptionText`, `descriptionHtml`, and `collectedAt`.

To increase discoverability on Apify, ensure you keep the `title`, `description`, and `tags` on the actor's Apify page updated with relevant keywords such as "LinkedIn jobs scraper", "job listings extraction", "employment data", and similar terms.

## API Reference

- **Actor Identifier**: `shahidirfan100/linkedin-jobs-scraper`
- **Input Specification**: Refer to the Input section above
- **Output Specification**: Refer to the Output section above

For comprehensive documentation, visit the [Apify platform docs](https://docs.apify.com/actors).

## Changelog

### v1.0.0
- Initial release featuring core LinkedIn job scraping capabilities.

## License

This project is distributed under the Apache License 2.0. Review [LICENSE](LICENSE) for complete terms.

---

*Powered by Apify - Reliable web scraping infrastructure.*
