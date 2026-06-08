#!/usr/bin/env node
import { isMainModule, main } from "./verify-release-artifacts/core.mjs";

if (isMainModule(import.meta.url)) {
  main();
}
