# Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (n8n-linkedin-sales-navigator-csv-icp-dedupe-sanitizer) are provided for educational and architectural demonstration purposes.

## Provided "as is"

This software is provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, accuracy, completeness, availability, and non-infringement.

## No liability

The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, special, or consequential damages, including lost revenue, lost or mis-targeted prospects, contact of excluded people or accounts, damaged sender reputation, regulatory penalties, or business interruption, resulting from the use, misuse, modification, or deployment of this software.

## Data and automation risks

- Cleaning, filtering, deduplication, and capping rules are heuristics. Titles, company names, domains, and locations in exported data can be wrong, incomplete, or ambiguous. Good prospects can be removed and unwanted prospects can be kept.
- Suppression depends on the quality and freshness of your suppression list and your HubSpot data. A missing domain, a stale lifecycle stage, an unmapped deal stage, or a failed lookup can allow existing customers, accounts with open deals, or do-not-contact accounts to remain in an output file.
- Third-party services and data can change or fail. HubSpot, n8n, LinkedIn, Smartlead, Instantly, and any data tool you use may change APIs, limits, terms, or availability without notice.
- The HubSpot code in this repository only reads data. If you extend it to write data, you take on the risk of changing or overwriting CRM records.
- Output files can contain personal data. Handle, store, and delete them according to your obligations.

## Your responsibilities

You, the user or operator, are solely responsible for:

- Testing with `SANDBOX_MODE=true` and `DRY_RUN=true` before connecting this software to live CRM data, live exports, or live sequencing tools.
- Reviewing the rules, suppression lists, configuration, and every output file before uploading anything to a sequencer.
- Having a lawful basis for collecting, exporting, storing, and using prospect data, and complying with the terms under which that data was collected, including the LinkedIn User Agreement and the terms of any tool used to export it.
- Complying with all applicable laws, regulations, and contracts, including data-protection and privacy rules (such as GDPR, CCPA, and CASL), email and outreach rules (such as CAN-SPAM and PECR), and do-not-contact and opt-out obligations.
- Securing credentials, rotating tokens, and keeping secrets out of version control.
- Assuming all risk arising from your use or modification of this software.

If you do not agree with these terms, do not use this software.

Licensed under the MIT License. See [LICENSE](LICENSE).
