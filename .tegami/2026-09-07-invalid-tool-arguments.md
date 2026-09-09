---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Report rejected tool arguments without executing them

Replace the SDK's source dump for tool calls rejected during input validation with a bounded `INVALID_TOOL_ARGUMENTS` result that states the tool was not executed and asks for smaller writes or edits, distinguishing malformed JSON from schema violations. In pretty mode the card keeps the streamed argument preview instead of the placeholder `{}` and is marked as not executed.
