# API Discovery — LinkedIn Jobs Guest API

## Overview

The actor is already built on LinkedIn's official **guest API endpoints** (not HTML-scraped). These are publicly accessible endpoints that LinkedIn serves to unauthenticated users browsing job listings. This document catalogs the discovered APIs, their capabilities, and the extraction strategy.

---

## Selected APIs

### 1. Job Search Listing API

- **Endpoint:** `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`
- **Method:** GET
- **Auth:** None (guest session via standard browser headers)
- **Content type returned:** HTML (Cheerio-parsed listing cards)
- **Pagination:** `start` query param (increments of 25)

#### Query parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `keywords` | Search query / job title | `software engineer` |
| `location` | Geographic filter | `United States` |
| `f_TPR` | Time range filter | `r86400` (24h), `r604800` (7d), `r2592000` (30d) |
| `sortBy` | Sort order | `R` (recent) |
| `start` | Pagination offset | `0`, `25`, `50`, ... |

#### Data extracted (per listing card)

| Field | How it's extracted |
|-------|-------------------|
| `jobId` | `data-entity-urn` attribute or `href` regex match `\d{8,}` |
| `jobUrl` | Constructed from jobId |

#### Limitation
The listing endpoint only yields job IDs. Full details require a second request per job.

---

### 2. Job Detail Posting API

- **Endpoint:** `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}`
- **Method:** GET
- **Auth:** None (guest session)
- **Content type returned:** HTML (full job posting page HTML)
- **Pagination:** N/A (single job per request)

#### Data extracted (from HTML)

| Field | Cheerio selector / source |
|-------|--------------------------|
| `title` | `h2.top-card-layout__title, h1.top-card-layout__title` |
| `company` | `a.topcard__org-name-link, div.topcard__org-name-link` |
| `companyUrl` | `href` of company link |
| `companyLogo` | `img.artdeco-entity-image` → `data-delayed-url` |
| `location` | `span.topcard__flavor--bullet` (validated) |
| `salary` | `div.salary, div.compensation__salary` |
| `applicantsCount` | `figcaption.num-applicants__caption` |
| `postedAt` | `span.posted-time-ago__text` |
| `workType` | `li.description__job-criteria-item` → Employment type |
| `seniority` | `li.description__job-criteria-item` → Seniority level |
| `jobFunction` | `li.description__job-criteria-item` → Job function |
| `companyIndustry` | `li.description__job-criteria-item` → Industry |
| `descriptionHtml` | `div.show-more-less-html__markup` |
| `descriptionText` | Same element, plain text |

---

## Architecture

```
                        ┌─────────────────────────────────┐
                        │   INPUT: keywords + location    │
                        │   timeRange + maxJobs           │
                        └──────────┬──────────────────────┘
                                   │
                                   ▼
               ┌───────────────────────────────────────┐
               │  CheerioCrawler (session pool, proxy) │
               │  - HTTP client: got-scraping → impit  │
               └──────────┬────────────────────────────┘
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   ┌─────────────────┐       ┌──────────────────────┐
   │ LIST Handler    │       │ DETAIL Handler       │
   │ Parse job cards │       │ Parse job posting    │
   │ Collect jobIds  │       │ Extract all fields   │
   │ Paginate (25)   │       │ Fallback: direct GET │
   │ Enqueue DETAILs │       │ Batch push (10)      │
   └────────┬────────┘       └──────────┬───────────┘
            │                           │
            └──────────┬────────────────┘
                       ▼
              ┌─────────────────┐
              │  Dataset.push   │
              │  (JSON output)  │
              └─────────────────┘
```

---

## Stealth Strategy

| Technique | Implementation |
|-----------|---------------|
| **TLS fingerprinting** | `impit` with `browser: 'chrome'` bypasses JA3/JA4 detection |
| **Dynamic headers** | `impit` generates matching Chrome headers automatically |
| **Session pooling** | CheerioCrawler rotates sessions & persists cookies |
| **Proxy** | Apify Proxy with residential groups available |
| **Rate limiting avoidance** | Random delays (200–500ms), session retirement on 999/429 |
| **Content-type acceptance** | `additionalMimeTypes: ['application/octet-stream']` to handle LinkedIn's MIME shenanigans |

---

## Field Count

| Category | Count |
|----------|-------|
| Fields extracted | **21** (jobId, jobUrl, title, company, companyUrl, companyLogo, location, salary, applicantsCount, workType, seniority, jobFunction, companyIndustry, postedAt, descriptionText, descriptionHtml, collectedAt, searchQuery, searchLocation, searchTimeRange) |
| LinkedIn API provides | More fields via JSON endpoints if available in future |
| Gap | LinkedIn does not expose a JSON API for guests; HTML parsing from `/jobs-guest/*` endpoints is the richest available approach |

---

## Rejected Candidates

| Candidate | Reason for rejection |
|-----------|---------------------|
| `https://www.linkedin.com/jobs/search` (browser page) | Requires JavaScript rendering, heavier payload, no additional data |
| LinkedIn GraphQL endpoints | Requires authenticated session, not accessible as guest |
| `https://www.linkedin.com/voyager/api/*` | Authenticated-only; returns 401 for guest requests |
| LinkedIn mobile API (`/m/jobs`) | Redirects to desktop; no richer data |

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Avg time per detail request | ~300–700ms (with proxy) |
| Avg time per list request | ~200–400ms |
| Time for 20 jobs | ~10–30s (depending on concurrency) |
| Max concurrency | 12 (configurable) |
| Failure handling | 3 retries per request, session retirement on block |
