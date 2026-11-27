# n8n LinkedIn Sales Navigator CSV ICP Dedupe Sanitizer

Cleans exported LinkedIn Sales Navigator prospect CSV lists before you upload them to a sequencer such as Smartlead or Instantly.

It strips emoji and headline noise from titles, normalizes company domains, applies your ICP rules, removes existing HubSpot customers, accounts with open deals, and suppression domains, deduplicates contacts, and caps the number of contacts per account. Every row that is removed goes to a quarantine file with a clear reason code, so nothing disappears without an explanation.

It ships as a zero-dependency Node.js library with a CLI, and as an n8n workflow generated from the same code.

## Safe by default

| Setting | Default | Effect |
|---|---|---|
| `SANDBOX_MODE` | `true` | HubSpot checks read a synthetic fixture file. No network access. |
| `DRY_RUN` | `true` | The local CLI prints a preview and writes no files. |

HubSpot access is read-only in every mode. The code only calls company search, association read, and deal batch-read endpoints, and it never creates, updates, or deletes CRM records.

The fixtures, tests, and docs use only `.example` domains and emails, documentation-range IP addresses, and `zzz_TEST_` prefixed IDs. A hygiene test fails the build if real-looking data or a credential pattern slips in.

## Architecture

```
                 +--------------------+
 Sales Navigator | First Name, Title, |
 CSV export ---->| Company, Website,  |
                 | LinkedIn URL, ...  |
                 +---------+----------+
                           |
                           v
                 +--------------------+      drop codes:
                 | 1. Parse CSV       |      CSV errors stop the run
                 +---------+----------+
                           v
                 +--------------------+      missing_name, missing_domain,
                 | 2. Normalize       |----> invalid_domain,
                 |    emoji, titles,  |      freemail_or_social_domain,
                 |    company, domain |      missing_email
                 +---------+----------+
                           v
                 +--------------------+      missing_title, title_excluded,
                 | 3. ICP filter      |----> title_not_icp, geography_missing,
                 |    title + region  |      geography_not_allowed
                 +---------+----------+
                           v
                 +--------------------+      static_suppression_list,
                 | 4. Suppression     |----> hubspot_customer, hubspot_open_deal,
                 |    static list +   |      hubspot_dnc_flag,
                 |    HubSpot (read)  |      hubspot_lookup_failed
                 +---------+----------+
                           v
                 +--------------------+      duplicate_linkedin_url,
                 | 5. Dedupe          |----> duplicate_email,
                 +---------+----------+      duplicate_name_domain
                           v
                 +--------------------+
                 | 6. Per-account cap |----> account_cap_exceeded
                 |    seniority rank  |
                 +---------+----------+
                           v
        +------------------+-------------------+
        |                  |                   |
        v                  v                   v
 sequencer_ready.csv  quarantine_dropped.csv  run_summary.json
```

The n8n workflow has the same stages as nodes:

```
Manual Trigger ----+
                   +--> Load Config & Defaults --> Parse CSV --> Normalize & Strip Noise --> ICP Filter --> Sandbox Mode?
Webhook Trigger ---+                                                                                          |
                                                                                   true (fixture) <-----------+----------> false (live API)
                                                                                         |                                      |
                                                                                         +---------> Dedupe & Per-Account Cap <-+
                                                                                                                |
                                                                                                          Split Outputs
```

## Repository layout

```
.
├── lib/core.js                    config loader, redact(), logger, CSV parser and serializer
├── lib/sanitizer.js               emoji and title stripping, domains, ICP filter, dedupe, cap
├── lib/hubspot.js                 HubSpot suppression client (fixture or live, with backoff)
├── scripts/build-workflow.js      deterministic generator for workflow.json
├── scripts/run-local.js           CLI runner
├── workflow.json                  import-ready n8n workflow (generated)
├── config/icp-rules.example.json
├── config/suppression-domains.example.json
├── fixtures/sales_nav_export.sample.csv
├── fixtures/hubspot_crm_snapshot.sample.json
├── test/sanitizer.test.js
├── .env.example
├── DISCLAIMER.md
├── LICENSE
└── package.json
```

Requires Node.js 20 or newer. There are no runtime or development dependencies.

## Quick start (local)

```bash
git clone <your-fork-url>
cd n8n-linkedin-sales-navigator-csv-icp-dedupe-sanitizer
npm test
cp .env.example .env
npm run sanitize
```

`npm run sanitize` runs the bundled synthetic export in sandbox mode and prints a summary. Nothing is written because `DRY_RUN=true`. To write the three output files into `output/`, set `DRY_RUN=false` in `.env`.

Use your own export:

```bash
npm run sanitize -- --input path/to/export.csv --rules config/my-rules.local.json
```

Files named `config/*.local.json` are ignored by git, so your real rules and suppression list stay out of the repository.

## Install in n8n

1. On your self-hosted n8n instance set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, because the Code nodes read settings from environment variables.
2. Set the variables from `.env.example` on the n8n host. Keep `SANDBOX_MODE=true` and `DRY_RUN=true` for the first runs.
3. Import `workflow.json` with **Import from File**.
4. Run **Manual Trigger**. It processes the bundled synthetic sample, so you can inspect every node's output.
5. For real files, activate the workflow and POST JSON to the webhook:

```bash
curl -X POST "$N8N_BASE/webhook/linkedin-sales-nav-csv-sanitizer" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SHARED_SECRET" \
  --data-binary @payload.json
```

where `payload.json` is `{"csv": "<the CSV text>"}`. The webhook is disabled unless `WEBHOOK_SHARED_SECRET` is set on the host, and calls without the matching `x-webhook-secret` header are rejected.

The workflow contains no credential blocks, no webhook IDs, and no instance IDs. The HubSpot token is read from `$env` inside the live lookup node only, and is never copied into node output or execution data.

**Outputs.** Split Outputs emits three items with binary files: `sequencer_ready.csv`, `quarantine_dropped.csv`, and `run_summary.json`. The workflow does not write to disk. Attach a Write Binary File, Google Drive, S3, or sequencer upload node after it. The webhook response lists the file names, row counts, and the run summary.

**Regenerating the workflow.** `workflow.json` is generated. Edit `lib/*.js`, then run `npm run build:workflow`. The test suite fails if the committed file is out of date. See [n8n docs](https://docs.n8n.io/) for importing and activating workflows.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DRY_RUN` | `true` | CLI writes no files while true. |
| `SANDBOX_MODE` | `true` | Use the HubSpot fixture snapshot instead of the API. |
| `MAX_CONTACTS_PER_ACCOUNT` | `3` | Contacts kept per root domain (1 to 100). |
| `REQUIRE_EMAIL` | `false` | Drop rows without a valid email (`missing_email`). |
| `CAMPAIGN_TAG` | empty | Adds a `campaign_tag` column to the ready file. |
| `HUBSPOT_ACCESS_TOKEN` | placeholder | Private app token, only used when `SANDBOX_MODE=false`. |
| `HUBSPOT_DNC_PROPERTY` | `do_not_contact` | Company property that marks do-not-contact. Empty disables the check. |
| `HUBSPOT_CLOSED_LOST_STAGES` | `closedlost` | Deal stage IDs that do not suppress an account. |
| `HUBSPOT_MAX_RETRIES` | `4` | Retries for 429 and 5xx responses. |
| `HUBSPOT_MIN_INTERVAL_MS` | `220` | Minimum gap between API calls (search is limited to about 5 per second). |
| `ICP_RULES_PATH` | `config/icp-rules.example.json` | CLI rules file. |
| `SUPPRESSION_DOMAINS_PATH` | `config/suppression-domains.example.json` | CLI static suppression list. |
| `HUBSPOT_SNAPSHOT_PATH` | `fixtures/hubspot_crm_snapshot.sample.json` | CLI fixture used in sandbox mode. |
| `INPUT_CSV_PATH` | `fixtures/sales_nav_export.sample.csv` | CLI input. |
| `OUTPUT_DIR` | `output` | CLI output folder. |
| `WEBHOOK_SHARED_SECRET` | none | n8n only. Required for the webhook trigger. |
| `ICP_RULES_JSON`, `SUPPRESSION_DOMAINS`, `HUBSPOT_SNAPSHOT_JSON` | bundled defaults | n8n only. Override the bundled rules, static list, and fixture. |

### HubSpot token

Create a private app with the scopes `crm.objects.companies.read` and `crm.objects.deals.read`, and put its token in `HUBSPOT_ACCESS_TOKEN`. Keep it in `.env` or the n8n host environment, never in a file you commit.

### ICP rules

`config/icp-rules.example.json` holds:

- `titleInclude` and `titleExclude`: case-insensitive regular expressions tested against the cleaned title. Exclusion wins over inclusion.
- `seniorityWeights` and `seniorityPatterns`: how titles map to C-level (100), VP (80), Director (60), Manager (40), and IC (20). The weights decide who survives the per-account cap.
- `allowedRegions`: matched against the comma-separated parts of the `Geography` column, with aliases such as `USA`, `UK`, and `England`, and region suffixes such as `Greater Boston Area`. An empty list disables the geography check.
- `freemailBlocklist` and `socialBlocklist`: domains that can never be a company domain.

Invalid regular expressions stop the run with a clear error instead of silently matching nothing.

### Static suppression list

`config/suppression-domains.example.json` lists root domains that are never exported and never sent to HubSpot. Use it for do-not-contact accounts, partners, and competitors.

## Input schema

Sales Navigator tools name columns differently, so headers are matched loosely (case, spaces, and punctuation are ignored).

| Canonical field | Accepted headers (examples) |
|---|---|
| `first_name`, `last_name` | `First Name`, `Last Name`, or a single `Full Name` / `Name` column |
| `title` | `Title`, `Job Title`, `Position` |
| `company` | `Company`, `Company Name`, `Account Name` |
| `website` | `Company Website`, `Website`, `Company Domain` |
| `linkedin_url` | `LinkedIn URL`, `Profile URL`, `LinkedIn Profile URL` |
| `email` | `Email`, `Email Address`, `Work Email` |
| `geography` | `Geography`, `Location`, `Region`, `Country` |
| `industry` | `Industry` |
| `record_id` | `Record ID`, `ID` (optional, defaults to `row_001`, `row_002`, ...) |

A file needs a name column and at least one of company, website, or email. Comma, semicolon, and tab delimiters are detected automatically, quoted multi-line cells and a UTF-8 BOM are handled.

## Cleaning rules

**Emoji and noise.** Unicode emoji, flags, keycaps, variation selectors, zero-width characters, and styled "bold" letters are normalized. Titles are cut at pipes, bullets, and dots, and also at slashes, commas, and spaced dashes when what follows is a credential or accolade.

```
VP of Sales | Helping B2B Scale 🚀              ->  VP of Sales
Director, Demand Generation, MBA, PMP            ->  Director, Demand Generation
Director of Marketing / Advisor / Speaker        ->  Director of Marketing
VP Sales at Acme Robotics                        ->  VP Sales
```

Commas and slashes that are part of the title are kept, so `Director, Demand Generation` and `Head of Sales / Marketing` survive.

**Company names.** Emoji, parentheticals, and legal suffixes (`Inc.`, `LLC`, `Ltd.`, `GmbH`, `Corp.`, `PLC`, `S.A.`, and similar) are removed.

**Domains.** Lowercase, protocol, `www.`, ports, paths, queries, and fragments are removed, emails are reduced to their domain, and subdomains are reduced to the root domain (`eu.acme-robotics.example` becomes `acme-robotics.example`). A short built-in list handles two-part suffixes such as `co.uk` and `com.au`. If the website is missing or rejected, the email domain is used. Freemail and social domains are rejected.

**Dedupe.** Rows that share a LinkedIn profile, an email, or the same first name, last name, and root domain are grouped, including transitively. The most complete row survives (email, then LinkedIn URL, then title), and ties go to the earliest row.

**Cap.** Within each root domain, contacts are ranked by seniority score, then by having an email, then by original row order. The top `MAX_CONTACTS_PER_ACCOUNT` are kept with an `account_rank`, and the rest are quarantined as `account_cap_exceeded`.

**Spreadsheet safety.** Cells that begin with `=`, `+`, `-`, or `@` get a leading apostrophe in the output CSV so spreadsheet tools do not run them as formulas.

## Output schemas

`sequencer_ready.csv`

| Column | Description |
|---|---|
| `record_id` | From the input or `row_NNN` |
| `first_name`, `last_name` | Cleaned names |
| `email` | Lowercased, or empty |
| `title` | Cleaned title |
| `company` | Company name without legal suffix |
| `domain` | Root domain |
| `linkedin_url` | Canonical profile URL |
| `geography`, `industry` | Emoji-free text |
| `seniority` | `c_level`, `vp`, `director`, `manager`, or `ic` |
| `account_rank` | Rank within the account (1 is the most senior) |
| `campaign_tag` | Only when `CAMPAIGN_TAG` is set |

`quarantine_dropped.csv` has `source_row`, `record_id`, `drop_stage`, `drop_reason`, `drop_detail`, the cleaned fields, and the raw `title_raw`, `company_raw`, and `website_raw` values so you can see what changed.

`run_summary.json`

```json
{
  "generated_at": "2026-01-01T00:00:00.000Z",
  "mode": { "dry_run": true, "sandbox": true, "hubspot_source": "fixture" },
  "settings": { "max_contacts_per_account": 3, "require_email": false },
  "counts": {
    "input_rows": 15,
    "sequencer_ready": 6,
    "quarantined": 9,
    "unique_accounts_ready": 3,
    "hubspot_domains_checked": 5,
    "hubspot_lookup_failures": 0,
    "invalid_emails_cleared": 0
  },
  "dropped_by_reason": { "account_cap_exceeded": 2, "duplicate_email": 1 },
  "dropped_by_stage": { "cap": 2, "dedupe": 2 }
}
```

## Drop reason reference

| Code | Stage | Meaning |
|---|---|---|
| `missing_name` | normalize | First or last name is empty after cleaning. |
| `missing_domain` | normalize | No website and no usable email domain. |
| `invalid_domain` | normalize | The website or email domain is not a valid hostname. |
| `freemail_or_social_domain` | normalize | Only a freemail or social domain was available. |
| `missing_email` | normalize | `REQUIRE_EMAIL=true` and the row has no valid email. |
| `missing_title` | icp | Title is empty after cleaning. |
| `title_excluded` | icp | Title matched a `titleExclude` rule. `drop_detail` names the rule number. |
| `title_not_icp` | icp | Title matched no `titleInclude` rule. |
| `geography_missing` | icp | `allowedRegions` is set and the row has no geography. |
| `geography_not_allowed` | icp | Geography is outside `allowedRegions`. |
| `static_suppression_list` | suppression | Domain is in the static suppression list. |
| `hubspot_dnc_flag` | suppression | The HubSpot company has the do-not-contact property set. |
| `hubspot_customer` | suppression | Lifecycle stage is `customer` or `evangelist`. |
| `hubspot_open_deal` | suppression | The company has a deal in any stage other than closed lost. Closed-won deals count. |
| `hubspot_lookup_failed` | suppression | The live HubSpot lookup failed after retries. The row is quarantined, not passed through. |
| `duplicate_linkedin_url` | dedupe | Same LinkedIn profile as a kept row. |
| `duplicate_email` | dedupe | Same email as a kept row. |
| `duplicate_name_domain` | dedupe | Same first name, last name, and root domain as a kept row. |
| `account_cap_exceeded` | cap | More than `MAX_CONTACTS_PER_ACCOUNT` contacts at the account. |

When several suppression reasons apply, `drop_reason` holds the highest priority one (static list, do-not-contact, customer, open deal, lookup failure) and `drop_detail` lists all of them.

## How HubSpot checks work

1. Unique root domains that survived the ICP filter and are not on the static list are collected.
2. In sandbox mode they are matched against `fixtures/hubspot_crm_snapshot.sample.json`.
3. In live mode they are searched in batches of 50 with `POST /crm/v3/objects/companies/search` on `https://api.hubapi.com`, then deals are read through the v4 company to deal associations and `POST /crm/v3/objects/deals/batch/read`.
4. 429 responses honor `Retry-After`, 5xx and network errors back off exponentially, and calls are spaced to respect the search rate limit.
5. If a batch still fails, its domains are reported as `hubspot_lookup_failed`. The sanitizer fails closed, so an outage never lets unchecked prospects through.

Custom deal pipelines use stage IDs rather than `closedlost`. Add yours to `HUBSPOT_CLOSED_LOST_STAGES`, otherwise those accounts are treated as having an open deal.

## Logging and secrets

`redact()` in `lib/core.js` masks bearer tokens, `pat-` private app keys, `sk-` keys, and email addresses, plus any literal secret you pass to it. The logger and every HubSpot error message go through it. The token is read from `HUBSPOT_ACCESS_TOKEN` (`process.env` in Node, `$env` in n8n) and nothing in the repository contains a credential.

## Testing

```bash
npm test                   # all tests
npm run check:workflow     # verify workflow.json matches the generator
npm run build:workflow     # regenerate workflow.json
```

The suite uses Node's built-in `node:test` and `node:assert` and covers:

- emoji and title stripping, company and name cleaning
- domain normalization and freemail or social rejection
- ICP title and geography filtering, seniority ranking
- HubSpot customer, evangelist, open-deal, closed-lost, and do-not-contact handling, plus the live client against a fake API (retry, rate limit, fail closed, token redaction)
- deduplication by LinkedIn URL, email, and name plus domain, and the per-account cap
- an end-to-end run of the sample export
- workflow parity: `workflow.json` equals the generator output, and the workflow's Code nodes produce the same files as the library in both the sandbox and live branches
- a repository hygiene scan that fails if any file contains a non-`.example` email, an unexpected URL host, a non-documentation IP address, a real-looking token (HubSpot private app key, `sk-` key, long bearer token, JWT), n8n instance metadata, or an em-dash

## Limitations

- Public suffix handling is a short built-in list, not the full public suffix database. Add entries to `MULTI_PART_TLDS` in `lib/sanitizer.js` if you need more.
- Domains hosted on shared platforms (for example site builders) are only caught if they are in the blocklists.
- Geography matching is text based. Sales Navigator's own location labels work best.
- The cap ranks by title, so unusual titles can land in the wrong seniority level. Adjust `seniorityPatterns` for your data.
- Contact data remains subject to your own sourcing and consent obligations. See the disclaimer below.

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (n8n-linkedin-sales-navigator-csv-icp-dedupe-sanitizer) are for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts and workflows.

**Prospect Data, CRM Suppression & Outbound Risks:** Prospect list processing carries inherent risks. Misconfigured ICP rules, wrong domain normalization, incomplete suppression lists, stale or incorrect HubSpot data, closed-lost stage mismatches, bad API calls, or an outage during a lookup can remove good prospects, keep prospects you meant to exclude, leave existing customers or accounts with open deals in an outbound list, exceed contact caps, exhaust API rate limits, or cause sequences to contact the wrong people. Scraped or exported LinkedIn data may be restricted by LinkedIn's terms and by the terms under which your data tools collected it. The HubSpot code in this repository only reads from HubSpot; it never creates, updates, or deletes CRM records.

**User Responsibility:** You are solely responsible for compliance with applicable laws, regulations, and contracts, including data-protection and privacy rules (such as GDPR, CCPA, and CASL), email and outreach rules (such as CAN-SPAM and PECR), do-not-contact and opt-out obligations, API rate limits, and the terms of service of LinkedIn, HubSpot, n8n, Smartlead, Instantly, and any other provider you connect. You are also solely responsible for proper testing (`SANDBOX_MODE=true` and `DRY_RUN=true`) before connecting any scripts to production environments, live CRM data, or live sequencing tools, and for reviewing every output file before upload.

Full text: [DISCLAIMER.md](DISCLAIMER.md) · Licensed under the [MIT License](LICENSE).

## License

MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
