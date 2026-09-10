---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Update the OpenAI-compatible adapter

Update the OpenAI-compatible adapter to 3.0.44 across all workspaces, preserving structured output and streamed tool inputs while reporting abruptly closed streams without retrying or executing incomplete arguments.
