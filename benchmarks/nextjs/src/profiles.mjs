export const BENCHMARK_PROFILES = Object.freeze({
  official: Object.freeze({ earlyExit: true, runs: 4 }),
  internal: Object.freeze({ earlyExit: false, runs: 4 }),
});

export function resolveBenchmarkProfile(name) {
  const profile = BENCHMARK_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown benchmark profile: ${name}`);
  }
  return profile;
}
