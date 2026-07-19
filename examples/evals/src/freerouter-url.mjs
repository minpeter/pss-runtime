const TRAILING_SLASHES_PATTERN = /\/+$/u;

/** Validate the credential-bearing Freerouter OpenAI-compatible API root. */
export function validatedFreerouterBaseUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("FREEROUTER_BASE_URL is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("FREEROUTER_BASE_URL must be a valid URL", {
      cause: error,
    });
  }
  if (url.protocol !== "https:") {
    throw new Error("FREEROUTER_BASE_URL must use HTTPS");
  }
  if (
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      "FREEROUTER_BASE_URL must not contain credentials, query data, or a fragment"
    );
  }
  const pathname = url.pathname.replace(TRAILING_SLASHES_PATTERN, "");
  if (pathname !== "/v1") {
    throw new Error("FREEROUTER_BASE_URL must end at the /v1 API root");
  }
  return `${url.origin}/v1`;
}
