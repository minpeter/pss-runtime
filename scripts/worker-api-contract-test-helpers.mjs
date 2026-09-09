import { readFileSync } from "node:fs";
import {
  CONTRACT_DOC_PATH,
  OBSERVATIONS_PATH,
  parseContractDocument,
  parseObservations,
} from "./worker-api-contract.mjs";

export const CLI = "scripts/check-worker-api-contract.mjs";
export const TMP_DIR = ".omo/tmp/worker-api-contract";

export const OPENAPI_MAJOR_PATTERN = /^3\./u;
export const OPENAPI_VERSION_ERROR = /OpenAPI 3/u;
export const INFO_ERROR = /info/u;
export const HEALTH_503_UNREPRODUCED =
  /documented-but-unreproduced: GET \/healthz status 503/u;
export const BOGUS_PROBE_OMITTED = /observed-but-omitted: bogus-probe/u;
export const UNREPRODUCED_PROBLEM = /documented-but-unreproduced/u;
export const HEALTH_SECURITY_PROBLEM = /\/healthz.*must not declare/iu;
export const DEV_EXCEPTION_PROBLEM = /development exception/iu;
export const SSE_BEARER_PROBE_PROBLEM =
  /\/session\/events lacks an observed token\/bearer-missing probe/u;
export const CATCH_ALL_SCHEME_PROBLEM = /catch-all must declare only/iu;
export const HEALTH_POST_NOT_EXERCISED = /health-post was not exercised/u;
export const HEALTH_GET_201_PROBLEM = /health-get answered 201/u;
export const UNCOMMITTED_LIVE_PROBLEM = /uncommitted-live-probe/u;
export const HEALTHZ_SECURITY_MUTATION =
  /( {6}summary: Unauthenticated liveness probe[\s\S]*?) {6}security: \[\]/u;

export function docText() {
  return readFileSync(CONTRACT_DOC_PATH, "utf8");
}

export function committed() {
  return parseObservations(readFileSync(OBSERVATIONS_PATH, "utf8"));
}

export function paths() {
  return parseContractDocument(docText()).paths;
}
