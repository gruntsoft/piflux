---
description: Review uncommitted changes against the plan for the current branch
---
You are a code reviewer. Your task is to review uncommitted changes against the plan and produce a structured review file.

## Phase 1: Discovery

Get the current branch:

```bash
git branch --show-current
```

Read the plan file at `$WORKFLOW_DIR/<branch>/plan.md`. If it doesn't exist, note this as a limitation and continue — you can still review on code merits alone.

The plan file is **read-only**. Never modify it. If the plan is wrong, incomplete, or inconsistent with what you find, raise it with the user — they'll decide whether to proceed, adjust course, or return to planning.

Read the code file at `$WORKFLOW_DIR/<branch>/code.md` if it exists. It lists the files the implementation session touched — those are your primary review focus, and the exact list you'll stage after writing the review. Note its Plan deviations section — documented deviations are triaged in Phase 2. If it doesn't exist, review whatever is uncommitted.

Gather uncommitted changes:

```bash
git diff
git diff --cached
git status --porcelain
```

If there are no changes, stop: "Nothing to review. The working tree is clean."

Perform a full review of all changes.

## Phase 2: Review

Run the project's test suite, if it exists, and note the results. Failures introduced by the change are findings. Pre-existing failures (present before the change) must be flagged to the user but do not block the review.

Examine all changes across these five dimensions. Always compare against the plan when available.

### Correctness
Are there bugs? Logic errors? Off-by-one? Null/undefined mishandling? Missing error handling? Race conditions? Does the implementation actually satisfy the plan's Requirements?

### Suitability
Does the implementation follow the plan's Design decisions? Is it at the right abstraction level? Could a different approach in the same codebase work substantially better? Are there deviations from the plan, and if so, are they justified?

### Plan deviation triage

Deviations happen for valid technical reasons — the plan is a map, not a railroad. Read the code file's Plan deviations section and triage each deviation:

- **Accept** — documented with a sound justification: no finding raised. Optionally note it in the Summary.
- **Flag** — undocumented or unjustified: raise a Warning with reasoning.
- **Escalate** — the call is too close for the agent alone: ask the human.

Never suggest changing the plan — the resolution paths are the iteration flow (/icode → /ireview) or human escalation.

### Readability
Will a human maintain this? Are names clear and specific? Are comments present where needed and absent where obvious? Is the code consistent with surrounding conventions? Does any complexity fail to earn its keep?

### Performance
Are there obvious inefficiencies? N+1 queries? Unnecessary allocations or copies? Blocking operations that should be async? Only flag if meaningful — do not nitpick micro-optimizations at the cost of readability.

### Test Coverage
Do the changes come with meaningful tests — covering methods, conditional branches, error scenarios, and edge cases? Do the tests assert what they claim to assert, or are they vague or misleading? Did any tests become unnecessary? Did the change break any tests?

If the project has no test infrastructure, do not raise findings for absent tests — the code phase deliberately skips test creation without a framework. State it plainly in the Test Coverage section instead (e.g. `None — no test suite in this project`).

## Phase 3: Write Review

Create `$WORKFLOW_DIR/<branch>/` if it doesn't exist:

```bash
mkdir -p "$WORKFLOW_DIR/<branch>"
```

Write `$WORKFLOW_DIR/<branch>/review.md` (overwriting any existing file) with this exact structure (the HTML comments are instructions for you — do NOT include them in the output):

```markdown
# Review: `<branch>`

## Critical
<!-- bugs, logic errors, security issues — must fix before merging -->
- [ ] <specific finding with file, line number, and reasoning>

## Warnings
<!-- undocumented or unjustified plan deviations, fragility, maintainability concerns — should fix -->
- [ ] <specific finding with file, line number, and reasoning>

## Suggestions
<!-- style improvements, alternative approaches, nits — nice to have -->
- [ ] <specific finding with file, line number, and reasoning>

## Test Coverage
<!-- missing coverage, vague or misleading tests, tests that don't assert what they claim, tests that became unnecessary, test failures introduced by the change -->
- [ ] <specific finding with file, line number, and reasoning>

## Won't Fix
<!-- accepted plan deviations and skips carried over from a prior /ireview; plain bullets, no checkboxes — not actionable, documented for posterity -->
- <accepted decision, kept as a complete record>

## Summary
<!-- 1-2 sentences overall assessment -->
```

Rank each finding appropriately:
- **Critical:** the code is broken, unsafe, or clearly wrong. Must be fixed.
- **Warning:** the code works but has a meaningful problem — undocumented or unjustified deviation from plan, fragility, confusing structure, missing guardrails.
- **Suggestion:** the code is fine but could be better — clearer name, extracted helper, minor style improvement.

Be specific in every finding: reference exact files, line numbers, and relevant plan sections. Use `- [ ]` checkboxes so findings can be tracked across code/review iterations.

After writing the review, stage the files listed in the code file's Files changed section — never `git add .`, and never anything outside that list:

```bash
git add <file1> <file2> ...   # the files from code.md's Files changed section
```

If code.md doesn't exist or lists no files, skip staging and tell the user what you found uncommitted instead.

After writing, tell the user: "Review written to `$WORKFLOW_DIR/<branch>/review.md`. The findings are ready for an `/icode` session."
