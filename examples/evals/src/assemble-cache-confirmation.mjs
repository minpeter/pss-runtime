import {
  atomicWrite,
  buildCombinedConfirmation,
  confirmationJsonPath,
  confirmationMarkdown,
  confirmationMarkdownPath,
  readCampaignFile,
  verifyCombinedConfirmation,
} from "./cache-confirmation-evidence.mjs";

const inputPaths = process.argv
  .slice(2)
  .filter((argument) => argument !== "--");
if (inputPaths.length !== 2) {
  throw new Error(
    "usage: node assemble-cache-confirmation.mjs <file-search-campaign.json> <conversation-campaign.json>"
  );
}

const campaignEntries = inputPaths.map((path) => readCampaignFile(path));
const combined = buildCombinedConfirmation(campaignEntries);
verifyCombinedConfirmation(combined);

const json = `${JSON.stringify(combined, null, 2)}\n`;
const markdown = confirmationMarkdown(combined);
atomicWrite(confirmationJsonPath, json);
atomicWrite(confirmationMarkdownPath, markdown);

process.stdout.write(
  `${JSON.stringify({
    campaigns: Object.keys(combined.campaigns).sort(),
    json: confirmationJsonPath,
    markdown: confirmationMarkdownPath,
    turns: Object.values(combined.summary).reduce(
      (total, arm) => total + arm.logicalTurns,
      0
    ),
  })}\n`
);
