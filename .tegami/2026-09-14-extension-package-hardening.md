---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-extension-latex:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-latex)
  npm:@minpeter/pss-extension-mermaid:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-mermaid)
  npm:@minpeter/pss-extension-web:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-web)
---

## Harden extension packages

Ship explicit license, public-access, and provenance metadata, validate packed ESM types, and enforce package-specific test coverage floors.
