import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

const paper = tegami({
  ignore: [
    "pss-next",
    "@minpeter/pss-worker-agent",
    "@minpeter/pss-runtime-edge-image-qa",
    /^@minpeter\/pss-example-/,
  ],
  npm: {
    client: "pnpm",
    trustedPublish: {
      provider: "github",
      workflow: "release.yml",
    },
  },
  plugins: [
    github({
      repo: "minpeter/pss-runtime",
      versionPr: {
        base: "main",
      },
    }),
  ],
});

await runCli(paper);
