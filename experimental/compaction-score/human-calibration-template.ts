export const HUMAN_CALIBRATION_QUESTION_ORDER_SEED =
  "human-calib-v2-question-order";

export const HUMAN_CALIBRATION_LABEL_HEADER =
  "packet_id,content_digest,qid,annotator_id,annotator_role,session_id,labeled_at_utc,viewed_arm,human_answer,candidate_match,confidence,difficulty,notes,seconds_spent,protocol_version";

export const HUMAN_CALIBRATION_INSTRUCTIONS = `# Human calibration annotation

Use only \`packets.blinded.jsonl\`, \`labels-template.csv\`, and this file while labeling. The coordinator must keep \`packets.keys.jsonl\` and \`arm-mapping.hmac.jsonl\` sealed until all labels are final.

For every prefilled CSV row:

1. Find the matching \`packet_id\` and \`qid\` in the blinded packet.
2. Read the conversation and question in the packet's randomized presentation order.
3. Inspect only the candidate named by \`viewed_arm\`; do not compare A and B while judging a row.
4. Enter your own answer in \`human_answer\`.
5. Set \`candidate_match\` by comparing the viewed candidate with your own answer: \`exact\`, \`equiv\`, \`wrong\`, or \`unknown\`.
6. Fill a stable human \`annotator_id\`, role, session, UTC timestamp, confidence 1-5, difficulty, notes, and seconds spent.

Do not use an LLM, automated grader, search tool, or the sealed key file. Preserve every prefilled identity and protocol field. Save the completed CSV separately from the packet directory.

## Korean Language Instructions

This evaluation must be performed by a real person. \`packets.blinded.jsonl\`Applicable in the \`packet_id\`Wa \`qid\`Find and, CSV Rows \`viewed_arm\`Please read only one candidate assigned to. For the same question AWa BDo not compare with each other.

The correct answer you judged \`human_answer\`Write down your relationship with the candidate in the \`candidate_match\`on \`exact\`, \`equiv\`, \`wrong\`, \`unknown\` Make a note of it as one of. \`confidence\` is  1-5, \`seconds_spent\`enters the actual time spent in quantities of seconds. Reliable, human-identifiable \`annotator_id\` is  \`human:<id>\` using formats, roles and sessions·UTC Fill in time, difficulty, and notes.

LLM, Auto-scoring, search tools, sealed key File should not be used. Prefilled ID, digest, arm, protocol Do not modify the value, CSV is  packet Save it outside the directory.
`;
