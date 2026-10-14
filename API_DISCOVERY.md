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
               │  impit client pool (profile + proxy)  │
               │  - rotates browser profile per retry  │
               │  - HTML parsed with Cheerio           │
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
| **TLS fingerprinting** | `impit` (v0.14.5) with a rotated browser profile bypasses JA3/JA4 fingerprint detection |
| **Profile rotation** | A reliability-ranked pool of impit profiles (`chrome136`, `chrome142`, `chrome124`, `firefox128`, `firefox`, `firefox144`) is round-robined per request; retries get a **fresh profile** |
| **Dynamic headers** | `impit` generates matching browser headers automatically (no manual `user-agent`/`sec-ch-ua` overrides) |
| **Endpoint headers** | Only the endpoint-required `referer: https://www.linkedin.com/jobs/search/` is set, kept consistent with the impersonated profile |
| **Session pooling by profile+proxy** | Every `Impit` instance pins one profile and one proxy session; a block rotates both |
| **Proxy** | Apify **Residential** proxy by default; each client gets a sticky `li_{n}` session, retries open a new session |
| **Anti-bot page detection** | HTTP `429`/`999` **and** `200` responses carrying the obfuscated `_0x…` JS challenge are detected and retried instead of parsed as empty |
| **Rate limiting avoidance** | Up to 8 bounded retries with jittered backoff, `Retry-After` honored (capped at 30s), per-request timeout 30s, fresh session+profile on every block |

### Verified impit profiles (impat 0.14.5 reliability test)

Each profile was probed with repeated list + detail requests. Ranked by smoothness:

| Rank | Profile | Success | Verdict |
|------|---------|---------|---------|
| 1 | `chrome136` | 5/5 | Best — first in pool |
| 2 | `chrome142` | 5/5 | Best |
| 3 | `chrome124` | 4/5 | Good |
| 4 | `firefox128` | 4/5 | Good |
| 5 | `firefox` | 4/5 | Good |
| 6 | `firefox144` | 2/5 | Usable (rotation) |
| — | `chrome151`, `chrome125` | 1/5 | Excluded (throttled) |
| — | `firefox135` | 0/5 | Excluded (throttled) |
| — | `chrome110`–`chrome116`, `ios18` | TLS error | Excluded (handshake fails) |
| — | `okhttp*` | 429 | Excluded (rejected) |

Blocking is per **profile + IP**. Datacenter proxy IPs are heavily throttled by LinkedIn, so the
Actor defaults to **residential** proxies; the code falls back to datacenter, then no proxy, if
residential is unavailable on the account. Profile rotation + fresh sessions recover transient
`429`s without surfacing a hard error.

### Request pattern

- Method: `GET`
- Required header: `referer: https://www.linkedin.com/jobs/search/`
- All other browser fingerprint headers are generated by the impit profile and are not overridden
- `redirect: 'follow'`, bounded 30s timeout, `ignoreTlsErrors: true` for proxy/TLS impersonation
- Retry only temporary failures (block page, `429`, `999`, `5xx`, timeout, short body); permanent
  `4xx` failures fall through to the search-summary fallback item instead of crashing the run


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
