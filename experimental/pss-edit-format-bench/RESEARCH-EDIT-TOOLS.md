# LLM Code editing tools and formatting prior research — pss-edit-format-bench For fairness evaluation

> ULW-Research Synthesis report (Korean version). Original text: `.omo/ulw-research/20260802-193039/SYNTHESIS.md`
> Created: 2026-08-02 · Team/Lane: 4 Librarian Lane + skeptic(ultrabrain) + Execution verification 5 cases · Notation of citation: [S#] = Source table, [V#] = Verification artifacts

---

## 0. Summary

Preliminary research in editorial format is divided into three pieces of evidence: (1) **Editorial Benchmarks**(CanItEdit, Aider Leaderboard, Diff-XYZ, SWE-bench series) — measure whether the model accurately expresses editing in a specific format; (2) **Formatted scientific papers**(AdaEdit, Diff-XYZ cross-format study) — measure which format is most accurate and token efficient by model size; (3) **Production Agent Mechanism**(Aider Default per model, Claude Code str_replace, omp/pss hashline, Grok ChunkFingerprint) — Examples where the same design choices were implemented as actual engineering decisions.

The conclusions that all previous studies jointly confirm **"Which format is best is the function in the form of model ability and task"**is that [S1][S4][S6]. Large models have a concise format (search-substitution, structured diff)rather advantageous, and the small model performs only in the most redundant format (full rewrite). Aider's production settings encode it as is: default is `whole`, By Model `diff`/`udiff`/`diff-fenced`Low Override [S3][S5].

**pss-edit-format-bench Fairness perspective**This synthesis in was not controlled by previous studies. **3 Structural Asymmetries**surfaces (with code execution verification): (a) grok-jsonof `write` all-rewrite opis a token-low cost exit that solves 24/24 tasks without anchors and is not available in other formats [V3]; (b) Anchor Format(pss/grok)Silver Line Shift *repulsed*and format the line number(omp)Silver *Quietly misedit*should -But pss Bench does not test this attribute [V2]; (c) 2 basic bench models(deepseek-v4-flash, minimax-m3)is outside of post-training on all four formats, which is symmetrical, but means that the bench weighs "the ability to learn formats with only prompts," not a native format advantage.

---

## 1. Axis A — Editorial Benchmark Battlefield

### CanItEdit [S2][S12] (arxiv 2312.12450, 2023-12→2024-09)
- **Measurement**: Edit Command-Based Code("updating a program given a natural language instruction"). 105dog handcrafted Python Programs; `before`/`after` Code + Natural Language Commands(descriptive/lazy both styles) + Hidden test.
- **Apply edit · Scoring**: Run product as hidden test. Main indicator **pass@k**, Auxiliary **ExcessCode**(Percentage of changed lines that the test did not cover).
- **Change Type Classification**: adaptive / corrective / perfective (Nickname evolve→adaptive, revise→perfective). — **Alert**: pss of the bench `suite.test.ts`A "CanItEditof change-kind slicingfollow, "but the kind you actually use(replace-line/insert/delete/replace-range/multi-hunk/rename/move/trap)will only borrow the concept [V4].
- **Key results**: "even GPT-3.5-Turbo is 8.8% better than the best open model" — **Table verified**: GPT-3.5-Turbo 58.98/46.48 vs DeepSeek-Coder-Instruct-33b 53.06/43.89 (descriptive/lazy pass@1), GPT-4 61.85/54.72 [V1].
- **limit, frontier**: Python Relying on limited, hidden tests, ExcessCodeis a line-based approximation.

### Aider Edit Code Leaderboard [S3][S4]
- **Measurement**: Exercism Python 133Dog Exercise — Replace natural language requests with actionable code edits and score them as having passed the unit test.
- **Apply edit**: Run test after auto-apply model output (parsing required).
- **Station**: 2023-07 "Plain text edit formats worked best... Function calls performed worse" → GPT-3.5 is  `whole`, GPT-4 is  `diff`; 2023-12 GPT-4 Turboon `udiff` Essential, "raised the score to 61%"; 2024-08 JSON As a result of the wrapping output lowering the code quality.
- **limit, frontier**: Editorial-Only, Exercism Report separate scores by source bias and format by model (→axis DLinked with).

### Diff-XYZ [S1] (arxiv 2510.12487, 2025-11)
- **Measurement**: diff Understanding — 3 Map Tasks(apply: old+diff→new / anti-apply: new−diff→old / diff Creation), CommitPackFT1,000 actual commits in 5 languages from(Python/JS/Java/Kotlin/Rust) × 200, 891repositories.
- **Scoring**: apply/anti-apply is  stripped Exact Match + line IoU; diff Generation is after parsing rate · application rate · application EM/IoU + F1±.
- **Cross-format**: udiff / udiff-h / udiff-l / search-replace. Conclusion "search-replace is the most effective representation overall" — **skepticLee WEAKENED Process**: diff-Interest tasks · Valid only in the scope of large models, quantitative connection with production editing is thesis §6Mrs. from [S1][D1].
- **Numerical Equivalent**: GPT-4.1 search-replace apply 0.96/anti 0.93/diff EM 0.95; Claude 4 Sonnet 0.97/0.87/0.94; Qwen2.5-Coder 0.5B ≈ 0.00 / 7B 0.59 / 14B 0.82 / 32B 0.85 (apply EM).
- **limit, frontier**: Single-pass reconfiguration/format task; Does not include production agent editing (multiturns, line moves, format recovery).

### SWE-bench Series / RepoBench / terminal-bench / CodeEditorBench [S18][S19][S20]
- **SWE-bench** (ICLR 2024 Oral, arxiv 2310.06770): Actual GitHub Create issue → resolution patch; **Docker Apply patches + run tests in a quarantine environment**Scored as. High reproducibility but relies on issue selection and patch execution fidelity.
- **SWE-bench Verified**: "A subset of 500 problems that real software engineers have confirmed are solvable" — Improved task quality, but narrowed subset.
- **RepoBench** (ICLR 2024, arxiv 2306.03091): Completion/understanding of storage unit code. Fairness concerns: contextual budgets, repository search quality.
- **terminal-bench**: Terminal Agent (interactive shell task). Fairness issues: tool availability, environmental variations, hidden status.
- **CodeEditorBench** (arxiv 2404.03543): Debugging/Translation/Polishing/Demand Conversion 4 Editing Tasks — more oriented towards real scenarios than creation-driven benchmarks.
- **Criticism** (Fabian Hertwig "Code Surgery", 2025-04-26 [S17]): Editorial benchmarks are more important than model inference. **Robustness of the patch/application layer**tendency to measure — overfitting patch formatting, context anchoring, spaces, and rewriting strategies. "A good model brittleIt may look bad because of one layer of application."

---

## 2. Axis B — Editorial Format Science

### AdaEdit / "To Diff or Not to Diff?" [S6][S7] (arxiv 2604.27296, 2026-04)
- **Definitions**: Edit Format = Diff+Patch with reconstruction identity `Patch(C, Diff(C,C'))=C'`; Edit Format Learning = (I, C, C') From triple E=Diff(C,C')Minimize token cross-entropy in.
- **BLOCKDIFF/FUNCDIFF**: tree-sitter AST Based on block-by-block rewrite format(BlockDiff: Random fine AST Node, FuncDiff: Function unit). AdaEdit = Adaptive Format Selection.
- **Results (skepticLee WEAKENED Process)**:
  - Macro Average Accuracy Equivalent: Qwen2.5-Coder-7B FullCode 57.07 vs FuncDiff+AdaEdit 57.95; 14B 63.89 vs 64.68; DeepSeek-Coder-6.7B 52.21 vs 52.55. **&#10;**, Retreat by benchmark(DeepSeek CanItEdit 44.88→38.98); Confidence interval · No equivalence test.
  - **Token Cost**: CanItEdit long-code Subset (80 tasks, 7B): FullCode 648.30 tok → BlockDiff+AdaEdit 466.04 (**−28.12%**), FuncDiff+AdaEdit 481.63 (**−25.71%**). Abstract "latency and cost over 30% Savings "is **Unsupported** (The measured structured format reduction rate is 25.71–28.12%; Table 3on latency No value; ContentDiff −33.25%is not a structured format).
  - Single laboratory · fine-tuning(fine-tuned) SETTINGS; No independent replication.

### Mechanism Taxonomy (Axis B+C All News) [S6][S10]
| Mechanism | Addressing | represent | Proof of accuracy | Token Expense Evidence | Failure mode |
|---|---|---|---|---|---|
| Rewrite all (whole) | None (Whole file) | Aider whole, grok `write` | Weak Model Best (2023 Aider) [S3] | Proportional to file size (648.30 tok Yes) [S6] | Omit large files in-between, diff Absent |
| Search-substitution (search-replace) | Unique Text Fragment | Claude Code str_replace, Diff-XYZ sr | Big Model Best (Diff-XYZ) [S1] | Short Response (Any File Size) | Ambiguity, Space Reproduction |
| Integration diff (udiff) | Hunk Header + Context | Aider udiff, AdaEdit UniDiff | Large Model Excellent/Minimal Heat Level [S1] | Medium | Hunk arithmetic, context drift |
| Line Numbers | Original Absolute Line | omp DSL | Not Measured | Low [V4] | **Quiet misediting when moving lines** [V2] |
| Hash Anchor | LINE#ID / LINE:h1:h2 | omp/pss hashline, grok | Unmeasured (Bench Assignment) | Input +12 to 41% overhead [V4] | **stale repulsed = Safety failures**, Needs rereading [V2] |
| AST/Block | tree-sitter Node | AdaEdit BlockDiff, omp SWAP.BLK | FullCodeand macro average equivalent [S6] | −25~28% [S6] | Unparsable state force, non-code file square |

![Editing Tool: Model Recognition Burden vs Token Consumption (200 Files Distribution)](assets/edit-mechanisms-burden-vs-tokens.png)

**Graph Interpretation** (200Composite Files Distribution: 10 PL × 20, 3 to 200 lines long, 6 edits, seed 42 — `assets/edit-mechanisms-dist-200.json`, generators `assets/corpus-generator.py`):

| Sudan | Median response | Median Total Tokens (Input + Response) | 10~90Percentile |
|---|---|---|---|
| Rewrite all | 134 | 264 | 86~1,224 |
| Search-substitution | 65 | 204 | 99~696 |
| Integration diff | 68 | 212 | 102~708 |
| Syntax Block* | 160 | 288 | 111~1,249 |
| Line Numbers | 42 | 250 | 105~1,129 |
| Hash Anchor pss | 105 | 428 | 228~1,623 |
| Hash Anchor grok | 82 | 464 | 185~2,198 |

- **The entire rewrite/syntax block has a wide distribution in proportion to the file size** (max ~2,500I), the rest is a narrow distribution regardless of the file size (within hundreds of characters).
- **Search-substitution · integration diffis at least the total cost** (Median ~ 200 characters), low cognitive burden — matches the default selection of commercial agents.
- **The line number indicates that the response is always minimized**However, with input overhead (+17 ~ 127%), the total cost is similar to search-substitution. stale o'clock *Quiet misediting* Risk is not included in this figure.
- **Hash anchors have a total cost of up to** (Median 428-464 characters): Anchor input overhead (+46-454%) is the culprit. stale Cost of reread turn still not included — actually more expensive.
- **pss Bench Implications**: Formatting of 4 benches pss-json/grok-jsonis at the top of the cost, ompis intermediate. Search-substitution (2) · Integration diff(3)is not on the bench.

*The syntax block is an estimate of the new content +25 character wrapper (tree-sitter Unused — on bench `resolveBenchBlock`is such a band resolver).

### Model Size × Format Interaction
- Diff-XYZ: "smaller open models still struggle regardless of representation" — Qwen-0.5Bis available in all formats ≈0.00 [S1].
- Aider: GPT-3.5(About) → whole, GPT-4(Kang) → diff, GPT-4 Turbo → udiff. **Format selection moves forging along the model capability slope** [S3][S4].
- AdaEdit: Structured format only competes with full generation on large models [S6].
- **Conclusion**: "The best editing method is different for each model "means (1) ability slope (about→ duplicate format, strong→ compression format) and (2) familiarity with post-training(Claude is  str_replace, GrokSilver is decomposed into two axes called post-training on its anchor).

---

## 3. Axis C — Production Agent's Actual Editing Mechanism

| Agent | Mechanism | Addressing | Failure Mode/Notes |
|---|---|---|---|
| Aider | whole/diff/diff-fenced/udiff (+editor-diff/editor-whole) | All Rewrite/Hunk/Search-Substitute | By Model `edit_format` DEFAULT: base `whole`, Multiple `diff`, Gemini `diff-fenced` [S5] |
| Claude Code | agentic Terminal tools (editing mechanisms not specified in public docs — honest gap) | Public Document Unspecified | Failure Taxonomy Undisclosed [S-gap] |
| omp / pss | hashline LINE#ID Anchor DSL | Hash Anchor | DSL ops: SWAP/SWAP.BLK/DEL/INS.PRE/POST/HEAD/TAIL/INS.BLK.POST/REM/MV; `[PATH#TAG]` Header [S8] |
| pss edit_file | replace/append/prepend + expected_file_hash | Hash Anchor | `new_content` min(1) → Unable to empty file; Deletion is only by scope abbreviation [V4] |
| Grok | `LINE:LOCAL:CHUNK` (ChunkFingerprint) | Hash Anchor (FNV-1a + Chunk) | **Check upstream primary source**: chunk Base 8 (bench mirror is 16), different hash initialization [S11] |
| OpenAI Codex CLI | Patch based: `*** Begin Patch ... End Patch ***` | File path + @@ Context anchor (not line number) | Context mismatch · No file · Invalid patch format [S14] |
| Gemini CLI | Built-in file tools | Public Document Unspecified | Change tool is approved(confirmation) Necessity [S15] |
| Cursor | ONLY Apply model (primary Model Sketch → Separate Training Apply Model is integrated) | When disclosed unknown | brittle diff/Introduced in response to context drift (external synthesis, medium reliability) [S17] |
| GitHub Copilot CLI | agentic Harness | When disclosed unknown | "nothing happens without your explicit approval" [S16] |

**Verify Anchor Calculation (Local Code)**:
- pss hashline: SHA-256(`seed:stripped`) → 16-Symbol Alphabet 2-Character Anchor; seed=0 (lines with letters/numbers) or line number; File Hash 8-hex [S13][V4].
- grok: whitespace-normalized FNV-1a 32-bit Line hash + fixed 16 row chunk fingerprint (upstream is 8 rows) [S11].

---

## 4. Axis D — Benchmark Fairness Methodology + pss Bench mapping

### What Previous Studies Have Established About “Fairness”
1. **Command Equivalence(instruction equivalence)**: Diff-XYZreports the presence or absence of format prompts as a separate condition (system prompt w/o format vs w/ format) — Control that format scaffolding itself affects performance [S1].
2. **Separate reporting by model**: AiderIsolate the model × format cell, Diff-XYZFigure Conclusions by Model Size. **"Format Xbest "is always stated with the model range** [S1][S5].
3. **Select Scoring**: pass@k(CanItEdit) vs Launch(CanItEdit/Aider) vs EM/IoU(Diff-XYZ) — Format comparison is only established in the same grader [S2][S1].
4. **Token · Cost measurement**: AdaEditis aggregated at a cost of only output tokens, up to the first renderable token latencyDefined as — Scope of measurement must be specified [S6][S7].
5. **transport Failure separation**: (pss Bench-like) request failed vs Parsing failure separation treatment is a premise of process comparison [V4].

### Code Verified pss Bench fairness assessment [V2][V3][V4]

**Bench Facts**:
- 24 tasks, 4 formats, default 576 attempts (2 Model × 4 Format × 24 Task × 3 Runs).
- `delete-first-line`Silver pss-jsonAbbreviate the range with(replace first=1 last=2 → as a spare line) **Expressive** — `suite.test.ts`of "pssCannot be expressed as "Notes are incorrect [V4].
- `resolveBenchBlock`Silver Brace Depth/Indent Based Bench Only Resolver — omp-jsonof `swap_block`/`delete_block`/`insert_block_after` Scoring is tree-sitterWeigh the behavior of this band, not [V4].

**Asymmetrical 1 — grok `write` Escape [V3]**:
grok-jsonof `write`(Rewrite all) op0 A anchors·tolerance 0With Guns **24/24 Passed**. ompis the full range SWAPIt can be mimicked with pss-jsoncannot be without a valid anchor. Bench has open paths to bypass the "anchor discipline" you are trying to measure in only one format.

**Asymmetric 2 — Anchor rejected, line number misedited [V2]**:
Attempt to apply edits after line movement (Target line 3, line→ 2): pss-json "Stale anchor ... Re-read the file" **repulsed**; grok-json "Anchor stale at line 2" **repulsed**; omp-dsl `SWAP 3.=3` **Quietly replace the wrong line**. — The anchor's robustness is not "survival" but "rejection" (safety failure)., **pss Bench is single-shot (no reread) and does not measure this attribute**. In addition, the line number format stale Structurally glass on single-shot bench as there are no failures.

**Asymmetric 3 — Scope of interpretation [V4]**:
2 Base Models(deepseek-v4-flash, minimax-m3)is symmetrical outside of post-training in all four formats→, but the bench result "**Possibility to learn prompts from untrained models in any format**"Can only be interpreted as. In the matrix Claude/Grok Symmetrical collapse when added — from then on per-model × per-format Tablega load bearing.

**Fair design elements (retention recommended)**:
- tolerance 4the bell strict passAggregate separation with [V4] — grokTolerance path of (string-wrapping, bare-object, Restore suffix, remove arrow) creditDidn't give.
- transport Failure scored Exclude from population [V4].
- Task + Run Unit paired delta + fingerprint Stratification [V4].

---

## 5. Argument Claim Screening Result (debate-log Summary) [D1-D5]

| Team Captains | skeptic Judgment  | Basis |
|---|---|---|
| search-replaceis best overall | **WEAKENED** | diff-Understanding · Limited to a large model range; counterexample(GPT-4.1-nano udiff EM 0.50 vs sr 0.07; Qwen-0.5B sr 0.00); §6 Deny Production Connection |
| diffis 20-30% fail | **REFUTED** | 1No tea studies; Blog Arithmetic Inverse; No % on citation page; Large deviation by model/format/task |
| Anchor is stronger than line number | **Partial (execution validation)** | pss/grokReject Silver, ompis a misedit [V2]; But no travel conditions on the bench |
| AdaEdit Accuracy Equivalent + 30% Cost Savings | **WEAKENED** | Macro mean equivalence only; Cost 25.71–28.12%; ">30%" Unsupported |
| grok Anchor = FNV-1a Chunk Fingerprint | **SUPPORTED (caveat)** | Check upstream primary source; Dan Bench Mirror(chunk 16, Hash initialization) is inaccurate [S11] |

---

## 6. bibliography (ranked)

| # | Source | Content | Confidence:  | Access date |
|---|---|---|---|---|
| S1 | https://arxiv.org/html/2510.12487v2 | Diff-XYZ Cross-format studies | 1CHA | 2026-08-02 |
| S2 | https://arxiv.org/abs/2312.12450 | CanItEdit Thesis | 1CHA | 2026-08-02 |
| S3 | https://aider.chat/2023/07/02/benchmarks.html | Aider 2023 Format Bench | 1Car (Vendor) | 2026-08-02 |
| S4 | https://aider.chat/2023/12/21/unified-diffs.html | udiff Essential (61%) | 1Car (Vendor) | 2026-08-02 |
| S5 | https://aider.chat/docs/config/adv-model-settings.html | By Model edit_format DEFAULT | 1Car (Vendor) | 2026-08-02 |
| S6 | https://arxiv.org/html/2604.27296v1 | AdaEdit (BlockDiff/FuncDiff) | 1CHA | 2026-08-02 |
| S7 | https://github.com/nju-websoft/AdaEdit (b8c6184) | AdaEdit In Store | 1Car (Code) | 2026-08-02 |
| S8 | https://registry.npmjs.org/@oh-my-pi/hashline | hashline Package (grammar/prompt) | 1Car (Code) | 2026-08-02 |
| S14 | https://github.com/openai/codex (README) | Codex CLI Patch Format | 1Car (Code) | 2026-08-02 |
| S15 | https://github.com/google-gemini/gemini-cli (README) | Gemini CLI Built-in tools | 1Car (Code) | 2026-08-02 |
| S16 | https://github.com/cli/cli (Copilot CLI README) | Copilot CLI Approval-Priority Harness | 1Car (Code) | 2026-08-02 |
| S17 | https://fabianhertwig.com/blog/coding-assistants-file-edits/ | "Code Surgery" (2025-04-26): Cursor Apply Criticism of model and bench overfitting | Blog (Synthesis) | 2026-08-02 |
| S18 | https://github.com/SWE-bench/SWE-bench (README) | SWE-bench + Verified Methodology | 1Car (Code) | 2026-08-02 |
| S19 | https://github.com/CodeEditorBench/CodeEditorBench (README) | CodeEditorBench 4Bell Editing Tasks | 1Car (Code) | 2026-08-02 |
| S20 | https://github.com/Leolty/repobench (README) | RepoBench Completion of storage units | 1Car (Code) | 2026-08-02 |
| S10 | https://anishgandhi.com/why-ai-tools-dont-use-diffs/ | "diff 20-30% Failed "claim (REFUTED) | Blog | 2026-08-02 |
| S11 | https://github.com/xai-org/grok-build@a4221165 | scheme.rs/hash.rs ChunkFingerprint | 1Car (Code) | 2026-08-02 |
| S12 | https://github.com/nuprl/CanItEdit | CanItEdit In Store | 1Car (Code) | 2026-08-02 |
| S13 | pss-runtime Local | hashline.ts, edit-file.ts | 1Car (Code) | 2026-08-02 |

**Verification artifacts [V]**: V1=verify-canitedit.md, V2=verify-shift-robustness.md, V3=verify-grok-write.md, V4=(Previous Session Execution + Code Reading: Bench Facts).

---

## 8. Run Live Bench: Formatting Performance by Model (2026-08-02, freerouter)

![Format performance by model](assets/edit-formats-per-model.png)

**Launch**: 2 models × 4 formats × 24 tasks × 2 runs = 384 attempts, Live Provider (freerouter, temperature 0). 2026-08-02.

| Format | deepseek-v4-flash | minimax-m3 | Difference |
|---|---|---|---|
| pss-json | **93.8%** (45/48) | 79.2% (38/48) | +14.6pt (deepseek Upper hand) |
| omp-dsl | 89.6% (43/48) | **97.9%** (47/48) | −8.3pt (minimax Upper hand) |
| omp-json | **85.4%** (41/48) | 72.9% (35/48) | +12.5pt (deepseek Upper hand) |
| grok-json | **95.8%** (46/48), strict 87.5% | 79.2% (38/48), strict **41.7%** | +16.6pt (deepseek Upper hand) |

**Opposite of format preferences by model** — Check User Predictions:
- **deepseek-v4-flash**: grok-json High(95.8%), pss-json MELEE(93.8%), omp-json Lowest (85.4%). 85% + of all formats — Excellent format learning power.
- **minimax-m3**: omp-dsl Overwhelming best (97.9%), remaining 3 formats plummet to 72.9-79.2%. omp-dsl vs omp-json paired delta **+25.0pt [12.5~39.6]** — Same address designation (line number), but only transmission JSONsignificantly collapsed even if changed to. grok-jsonSilver strict 41.7% (Tolerance Route 32 of arrow-stripped 32times — Failure in anchor copying discipline).
- **Oppose token efficiency**: minimaxis available in all formats deepseek Less than half of the contrast output token (92~172 vs 317~404) — However, the delay time is 2 ~ 5 times slower (19.7~33.9s vs 6.4~17.6s).

**Bench Fairness Implications**: Same task · same prompt · same grader, format excellence flips model by model. "Format XThe conclusion that "is best" should always be stated with the model, per-model × per-format I checked the existing recommendation that the cell is a load bearing structure..

---

## 9. Self-recovery(recovery) Measurement Items (added 2026-08-02)

**Motivation**: Initial edit failure (temporary) and repetition mistake (format-model incompatible) are different phenomena — the latter is not fixed even by retrying. `--recovery <n>` With flags up to nFeedback up to (Error message/Application result diff)give it a retry and measure if it recovers.

![first-shot Success rate vs Resilience (Independent Axis)](assets/edit-formats-recovery-axes.png)

**Graph Interpretation** (generators: `assets/recovery-axes-chart.py`, `uv run --with matplotlib python3 assets/recovery-axes-chart.py`):
- Left: Bone Bench(384 attempts)of first-shot Pass rate — deepseek×grok-jsonThis is the highest at 95.8%.
- Right: x=first-shot, y=Recovery rate (Failed attempting) — deepseek×grok-jsonThe only (95.8%, 0%) location. In the upper light green (recoverable) and lower light pink (dead-end format) quadrants, **Both axes are independent**Indicates that the 7 empty markers were not failed in the demo, resulting in a recovery rate of n/a.

**Implementation** (`src/recovery.ts` + run.ts/report.ts):
- `--recovery 3` → Reason for rejection (parsing error) or result of application if each attempt fails diffThe user Feedback via message, retry up to 3 times.
- **2026-08-03 Revision: tool-protocol recovery** — Feedback is no longer user-role Do not manipulate with sentences. The retry turn `userPrompt → assistant(edit payload) → tool(Actual tool output)` It becomes a structure,, tool Messages include: **Only the data returned by the actual tool** Contains: Original error string when rejected(pssis already "Re-read the file."included in its own error), if the application is successful `OK - edited file` Block + Anchor by Format diff (`buildToolOutput`). of the bench pss-json System Prompt "edit_file returns an OK block with a diff"The Recovery Loop now upholds the contract promised. **Oracle Crest("does not match the intended change" + Full file dump) is removed** — The actual tool doesn't know the intent,. `run.ts` is  tool Message AI SDKof `tool-result` Serialize into parts (live provider verified).
- Attempton `recovery` Add Record: `{ attemptsUsed, recovered, firstAttemptFailed, repeatedFailure }`.
- In the report **"Recovery by model and format"** Add section: `first-shot` / `recovered` / `recovery rate`(Recovery rate from failures) / `repeated-failure`(Repeat the same error class) / `avg attempts`.
- RED→GREEN: `recovery.test.ts`(6rows) + `report.test.ts`(2cases) — Failed tests first written and implemented, 96 cases passed in full + tsc clean.

**Live Demos** (2 tasks × 4 formats × 2 models × 1 run, `--recovery 3`):

| model | format | first-shot | recovered | recovery rate | repeated-failure | avg attempts |
|---|---|---|---|---|---|---|
| deepseek-v4-flash | pss-json | 2/2 | 2/2 | n/a | 0/2 | 1.0 |
| deepseek-v4-flash | omp-dsl | 2/2 | 2/2 | n/a | 0/2 | 1.0 |
| deepseek-v4-flash | omp-json | 2/2 | 2/2 | n/a | 0/2 | 1.0 |
| deepseek-v4-flash | **grok-json** | 1/2 | 1/2 | **0.0%** | **1/2** | **2.0** |
| minimax-m3 | pss-json | 2/2 | 2/2 | n/a | 0/2 | 1.0 |
| minimax-m3 | omp-dsl | 2/2 | 2/2 | n/a | 0/2 | 1.0 |
| minimax-m3 | omp-json | 2/2 | 2/2 | n/a | 0/2 | 1.0 |
| minimax-m3 | grok-json | 2/2 | 2/2 | n/a | 0/2 | 1.0 |

**Observation**: deepseekof grok-jsonThe only one `py-append-method`Failed first attempt at not recovering after → 3 retries(recovery rate 0.0%, repeated-failure 1/2). All the same model in different formats first-shot Success — This is **It's not a temporary mistake. grok-json the anchor format deepseekContinuously incompatible with**“Initial Failure.” vs Repetition mistake "classification works example.

**Implications for fairness**: first-shot rateIf you look at it deepseek grok-jsonThe 95.8% (was §8)It looks the best with, recovery Measurement reveals non-recoverable format in case of failure. **Single-shot success rate and resilience are independent axes** — Both must be reported to determine "is it worth giving the format to this model".

### Cumulative pass rate by retry — minimax-m3 × pss-json (2026-08-03, 24 tasks × 3 runs = 72 attempts)

![Cumulative pass rate by retry](assets/edit-formats-attempt-ladder.png)

**Launch**: `--models minimaxai/minimax-m3 --formats pss-json --runs 3 --recovery 3 --disable-thinking`, 67 scored attempts (request Exclude 5 failures). `--formats` Filters are used for this run.tsAdded to — you can only pick the format you want to measure. generator: `assets/attempt-ladder-chart.py`.

| State | Accumulated Pass | Ratio | Δ (1versus times) |
|---|---|---|---|
| 1Episodes (first-shot) | 65/67 | 97.0% | — |
| 2Episodes | 65/67 | 97.0% | 0pt |
| 3Episodes | 65/67 | 97.0% | 0pt |

**Observation**: Re-measured with tool protocol (actual tool output only feedback) **first-shot 97.0%The gain that retries add up in 0** — Reprisal 0/2 (recovery rate 0.0%). Compared to the previous Oracle feedback run (94.3% → 95.7%, recovery 25%),, **The / Those / That +1.4pt Any improvement "does not match the intended change" What the Oracle Crest Makes**the error string returned by the actual tool, or OK+diff Block alone minimax×pss-jsonof failures (1 parsing, wrong-content 1cannot be repaired). deepseek×grok-jsonof the "High first-shot + Unlike "irrecoverable", "high first-shot + Oracle Removal Missing Recovery Curve "Case — **Direct evidence that Oracle feedback has inflated recovery rates**C.

### m2.7 Additional Measurements (2026-08-03) + transport Debug

**m2.7 Tool Protocol**: 24 tasks × 3 runs = 72 attempts, Score all(request 0 Failures). first-shot 47/72 = **65.3%**, Even after retrying 65.3% — **Reprisal 0/25 (0.0%)**, repeated-failure 9/72, avg attempts 1.7. m3(97.0%) The contrast is very weak and there are many failures,(unparsable 15rows, wrong-content 10case) None of which were recovered by tool output alone. **0 restores after Oracle removal for both models** — "Cannot repair semantic/format errors with tool output alone "is a model irrelevant phenomenon.

**found in the course of modification, transport BUGS**: First m2.7 Implementation is 28-21 times out of 72 "All eligible upstream providers failed"dropped to. The cause was **tool-protocol assistant Message plain-textOnly sent to** — m2.7 Upstream is `assistant(tool-call PART#) + tool` You get a combination only., plain-text assistant Behind tool Rejected all messages(m3accepts both). `run.ts`A assistant Also in Messages `tool-call` Edit to paste the part(`input: { payload }`)and then request Measured normal with 0 failures, which is **of a format bench transport Hierarchy may behave differently for different models**is also a fairness lesson — transport Failure scored Existing rules excluding from population(V4)Examples of when this is actually triggered.

### read_file Further Re-measurement of Verification Channels (2026-08-03) — Recovery Curve Survived

![Cumulative pass rate by retry](assets/edit-formats-attempt-ladder.png)

**Motivation**: Tool Protocol (Error String + OK/diffIn only), both models had 0 recoveries. In the actual harness, the model wrong-contentThe path to fix the **Edit and reread** — `edit_file`Lee "OK + diff"If you give, the model will `read_file`View the current file status with and modify it against the task. Not having that channel in the bench recovery loop.

**Implementation** (`recovery.ts` + `run.ts`):
- If editing is applied but the content is incorrect tool To Message **Determine the current file status `read_file` in the format append** (`renderFile` Callback = of each format `render(path, content).user` — Include anchor/hash).
- **Apply Cumulative State**: Each retry is original initialNot this one. **Current state that reflects edits made up to the last attempt**(In the past, even if the → model that is reapplied to the original always makes correct corrections, "Stale anchor"Denied as meaning equal to the cumulative editorial value of the actual agent.)
- `extractJson`B balanced-brace Replace with parser — m2.7To this output `<minimax:tool_call>` XML As a rapper JSONHandle duplicate pasting cases.
- RED→GREEN: `recovery.test.ts` Cumulative status test + `formats.test.ts` XML Added wrapper test, passing all 99 cases + tsc clean.

**Measurement (24 tasks × 3 runs, `--recovery 3`)**:

| model | 1Episodes | 2Episodes | 3Episodes | recovery rate | repeated-failure |
|---|---|---|---|---|---|
| **m3 read_file** | 81.4% (57/70) | 92.9% (65/70) | 95.7% (67/70) | **76.9%** (10/13) | 0/70 |
| **m2.7 read_file** | 65.3% (47/72) | 69.4% (50/72) | 73.6% (53/72) | **24.0%** (6/25) | 9/72 |
| m3 Tool Protocol (formerly) | 97.0% | 97.0% | 97.0% | 0.0% (0/2) | — |
| m2.7 Tool Protocol (formerly) | 65.3% | 65.3% | 65.3% | 0.0% (0/25) | 9/72 |
| m3 Oracle (Removed) | 94.3% | 95.7% | 95.7% | 25% (1/4) | — |

**Observation**:
- **Verification channel saves recovery.** m3Silver first-shot Reinstating 10 of 13 Failed Cases (76.9%) — wrong-contentDegree read_fileView and self-correct the current status with. m2.76 out of 25 cases of silver (24.0%).
- m2.7of `while-to-for-range`was before 0/3 → **3/3 Restore all** — by applying a cumulative state "This is an accurate correction, stale anchorRejected as "The case was released.
- m2.7 Remaining Failed(delete-middle-line, insert-indented-block, move-block-up, large-range-replace, py-dedent-block, delete-first-line)is mostly **pss-jsonTasks that cannot be represented as** (suite.test.tsof delete-first-line Comment: delete op FREE + new_content It should not be empty) — Not a model skill problem, but a format expression problem. unparsable 15Many of the cases are m2.7of XML Wrapping/typo.
- **Fairness conclusion**: "The tool output alone cannot repair the semantic error. "0% **Artifacts in absence of verification channels**. . read_file A bench with channel + cumulative status is a recovery measure equivalent to a real agent, and the difference in recoverability between models(m3 76.9% vs m2.7 24.0%)Reveal.

### runs=10 Full Format Re-measurement (2026-08-03) — Sample Enlargement Results

![4bill(s) edit format's 1-turn success rate and 3-turn resilience](assets/edit-formats-recovery-runs10.png)

**Launch**: By Model 4 formats × 24 tasks × 10 runs = 960 logical attempts, `--recovery 3`, `read_file` Verification channel + Accumulated state, temperature 0, thinking off. request Failure is scored excluded from the population.

| model | Format | scored | 1Turn | 3Turn Final | recovery rate | repeated-failure |
|---|---|---:|---:|---:|---:|---:|
| m3 | pss-json | 238/240 | 87.8% (209/238) | **96.2%** (229/238) | **69.0%** (20/29) | 2/238 |
| m3 | omp-dsl | 240/240 | 95.4% (229/240) | **99.6%** (239/240) | **90.9%** (10/11) | 0/240 |
| m3 | omp-json | 240/240 | 82.9% (199/240) | **84.2%** (202/240) | **7.3%** (3/41) | 0/240 |
| m3 | grok-json | 233/240 | 90.6% (211/233) | **97.9%** (228/233) | **77.3%** (17/22) | 3/233 |
| m2.7 | pss-json | 240/240 | 65.8% (158/240) | **72.9%** (175/240) | **20.7%** (17/82) | 36/240 |
| m2.7 | omp-dsl | 240/240 | 77.9% (187/240) | **90.0%** (216/240) | **54.7%** (29/53) | 24/240 |
| m2.7 | omp-json | 240/240 | 96.3% (231/240) | **96.7%** (232/240) | **11.1%** (1/9) | 0/240 |
| m2.7 | grok-json | 240/240 | 80.8% (194/240) | **94.2%** (226/240) | **69.6%** (32/46) | 0/240 |

**Observation**:
- **The optimal format for each model is split.** m3 is  `omp-dsl`This is the best at 99.6%, m2.7Silver `omp-json`This is the best at 96.7%. The conclusion that the same format should not be given as the default for all models 240 scored attempts/cell also maintained in the specimen.
- **Verification channel effect varies by format.** m3of `omp-dsl`11 pieces of silver first-shot Restore 10 of the failures(90.9%), `grok-json`17 of 22 Silver(77.3%), `pss-json`recovered 20 of 29 (69.0%), versus `omp-json`Only 3 out of 41 (7.3%) recovered.
- **m2.7Silver `grok-json`Lesson 1 `omp-dsl`Recovery curve is large at.** 69.6% (32/46) and 54.7% (29/53), respectively,, `pss-json`is as low as 20.7% (17/82) and repeated-failureis 36/240. `omp-json`Silver first-shotThis is already 96.3%, so there are only 9 recoverable cases in itself..
- **runs=10The format × model interaction is sharper than the variability between runs in.** m3 is  `omp-json`Structural failure of (final 84.2%, indentation 38case) is prominent,, m2.7Silver `pss-json`Parsing failed on(unparsable 55case) is prominent..
- **Interpretation criteria**: 3Turn end success rate is the overall resolution rate, recovery rate is  first-shot The rate at which failures are resolved by actual validation feedback. It is necessary to report the absolute performance and resilience of the format together without combining the two.

---

## 7. Gap (documented limit)

- **RepoBench·terminal-bench Detailed methodology + Morph Blog Body**: Closed with low confidence (3rd source, not fully debited from this run).
- **Claude CodeAccurate editing mechanisms in**: No public 1st document found in this run — actual product(str_replace_editor)is known but not validated here.
- **AdaEdit Independent Replication**: No announcement to date (documented gap).
- **grok Public documents (off-code)**: Non-code documentation of the anchor scheme not found.
- **Convergence**: 3Expansion Waves (lane 4 → skeptic+grok-lane → gap-fill) 0 Actionable Unidentified Leads after. All Argument Claims are debate-logRecord your decision on.
