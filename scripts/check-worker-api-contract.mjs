#!/usr/bin/env node
// check:worker-api-contract — Worker OpenAPI contract gate
// (VAL-WORKER-029/030). Compares the committed contract document against the
// committed observed-behavior records bidirectionally, verifies the auth
// matrix truthfulness, and optionally compares against a live-probe records
// file. Core logic lives in scripts/worker-api-contract.mjs.
//
// Modes:
//   (no args) / --help       print usage and exit 0
//   --check                  GATE: doc vs committed observations (default)
//   --check --live <file>    also compare against live-probe records

import { readFileSync } from "node:fs";
import {
  CONTRACT_DOC_PATH,
  OBSERVATIONS_PATH,
  parseContractDocument,
  parseObservations,
} from "./worker-api-contract.mjs";
import {
  authMatrixProblems,
  diffContract,
  diffLiveRecords,
} from "./worker-api-contract-diff.mjs";

const USAGE = `Usage: node scripts/check-worker-api-contract.mjs [options]

Options:
  (no args) / --help    print this usage and exit 0
  --check               GATE: compare the contract document against the
                        committed observations (default mode)
  --live <path>         additionally compare against a live-probe records
                        JSON file ("records" array with id/status entries)
  --doc <path>          contract document (default: ${CONTRACT_DOC_PATH})
  --observations <path> observations file (default: ${OBSERVATIONS_PATH})

Exit 0 when the document and the observed behavior match exactly; exit 1
with one problem per line otherwise (documented-but-unreproduced or
observed-but-omitted behavior, auth-matrix violations).`;

function parseArgs(argv) {
  const args = {
    doc: CONTRACT_DOC_PATH,
    help: false,
    live: null,
    observations: OBSERVATIONS_PATH,
  };
  const takesValue = new Set(["--doc", "--live", "--observations"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--check") {
      // default mode; accepted for explicitness
    } else if (takesValue.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: `option ${token} requires a value` };
      }
      args[token.slice(2)] = value;
      index += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return args;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  let paths;
  let records;
  let rawText;
  try {
    rawText = readText(args.doc);
    paths = parseContractDocument(rawText).paths;
    records = parseObservations(readText(args.observations));
  } catch (error) {
    console.error(`check:worker-api-contract error: ${error.message}`);
    return 1;
  }
  const problems = [
    ...diffContract(paths, records),
    ...authMatrixProblems(paths, records, rawText),
  ];
  if (args.live) {
    try {
      const live = parseObservations(readText(args.live));
      problems.push(...diffLiveRecords(paths, records, live));
    } catch (error) {
      console.error(`check:worker-api-contract error: ${error.message}`);
      return 1;
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error(
      `check:worker-api-contract GATE failed: ${problems.length} mismatch(es) between the document and the observed behavior`
    );
    return 1;
  }
  console.log(
    `check:worker-api-contract OK: ${paths.length} documented paths, ${records.length} observed records, zero mismatches${args.live ? " (live probes reproduced)" : ""}`
  );
  return 0;
}

process.exit(main());
