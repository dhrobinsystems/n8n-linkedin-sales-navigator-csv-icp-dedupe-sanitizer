#!/usr/bin/env node
'use strict';

/*
 * Runs the sanitizer locally.
 *
 *   node scripts/run-local.js                       sample CSV, sandbox, preview only
 *   node scripts/run-local.js --input my.csv        your own export
 *
 * Safe defaults: SANDBOX_MODE=true reads HubSpot data from the fixture snapshot, and
 * DRY_RUN=true prints a preview and writes no files. Set DRY_RUN=false to write the three
 * output files, and SANDBOX_MODE=false (with HUBSPOT_ACCESS_TOKEN) to use live HubSpot reads.
 */

const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/core');
const sanitizer = require('../lib/sanitizer');
const hubspot = require('../lib/hubspot');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0 && i + 1 < argv.length) args[a.slice(2)] = argv[++i];
    else if (a === '--help') args.help = true;
  }
  return args;
}

function loadStaticList(p) {
  const data = core.readJsonFile(p, ROOT);
  return Array.isArray(data) ? data : data.domains || [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/run-local.js [--input file.csv] [--out-dir dir] [--rules file] [--suppression file]');
    return;
  }
  const env = core.loadEnv({ cwd: ROOT });
  const config = core.buildConfig(env);
  if (args.input) config.paths.input = args.input;
  if (args['out-dir']) config.paths.outputDir = args['out-dir'];
  if (args.rules) config.paths.icpRules = args.rules;
  if (args.suppression) config.paths.suppression = args.suppression;

  const logger = core.createLogger({ secrets: [config.hubspot.token] });
  if (config.errors.length) {
    logger.error('Configuration error: ' + config.errors.join('; '));
    process.exitCode = 2;
    return;
  }

  const rules = core.readJsonFile(config.paths.icpRules, ROOT);
  const staticSuppression = loadStaticList(config.paths.suppression);
  const snapshot = config.sandbox ? core.readJsonFile(config.paths.snapshot, ROOT) : null;
  const csvText = fs.readFileSync(core.resolveFromRoot(config.paths.input, ROOT), 'utf8');
  const request = config.sandbox ? null : hubspot.createFetchRequest();

  const result = await sanitizer.runPipeline(csvText, {
    config: core.publicConfig(config),
    rules: rules,
    staticSuppression: staticSuppression,
    nowIso: new Date().toISOString(),
    lookup: (domains) =>
      hubspot.lookupSuppression({ config: config, domains: domains, snapshot: snapshot, request: request, logger: logger })
  });

  const s = result.summary;
  console.log('Mode: DRY_RUN=' + s.mode.dry_run + ' SANDBOX_MODE=' + s.mode.sandbox + ' (HubSpot source: ' + s.mode.hubspot_source + ')');
  console.log('Input rows: ' + s.counts.input_rows + ', sequencer ready: ' + s.counts.sequencer_ready + ', quarantined: ' + s.counts.quarantined);
  console.log('Dropped by reason: ' + JSON.stringify(s.dropped_by_reason));
  if (s.counts.hubspot_lookup_failures) logger.warn(s.counts.hubspot_lookup_failures + ' domains failed the HubSpot lookup and were quarantined');

  if (config.dryRun) {
    console.log('DRY_RUN=true: no files written. Set DRY_RUN=false to write ' + config.paths.outputDir + '/.');
  } else {
    core.writeOutputs(result.files, config.paths.outputDir, ROOT).forEach((f) => console.log('Wrote ' + f));
  }
}

main().catch((e) => {
  console.error(core.redact(e));
  process.exitCode = 1;
});
