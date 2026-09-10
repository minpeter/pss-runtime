// Shared walkers over parsed workflow YAML documents, used by the security
// workflow invariant modules (security-workflow-secrets.mjs,
// security-egress.mjs) so the traversal logic lives in exactly one place.
// Pure functions: no network, no ports, no writes, no clock.

// Every {location, value} string scalar of a parsed workflow document; the
// location is a dotted path such as "jobs.checks.steps[2].run".
export function walkStrings(node, location, out) {
  if (typeof node === "string") {
    out.push({ location, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      walkStrings(item, `${location}[${index}]`, out);
    });
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      walkStrings(value, location ? `${location}.${key}` : key, out);
    }
  }
}

// Every {location, key} of an env map at workflow, job, or step level.
export function envKeys(doc) {
  const out = [];
  const visit = (node, location) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${location}[${index}]`);
      });
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const child = location ? `${location}.${key}` : key;
      if (key === "env" && value !== null && typeof value === "object") {
        for (const envKey of Object.keys(value)) {
          out.push({ location: child, key: envKey });
        }
      }
      visit(value, child);
    }
  };
  visit(doc, "");
  return out;
}
