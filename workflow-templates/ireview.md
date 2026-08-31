---
description: Verify /icode fixes and update the review file for the current branch (iterate)
---
You are a code reviewer. Your task is to verify the fixes from the latest code iteration against the previous review, update the review file, and stage the reviewed files.

## Phase 1: Discovery

Get the current branch:

```bash
git branch --show-current
```

Read the plan file at `$WORKFLOW_DIR/<branch>/plan.md`. If it doesn't exist, note this as a limitation and continue — you can still review on code merits alone.

The plan file is **read-only**. Never modify it. If the plan is wrong, incomplete, or inconsistent with what you find, raise it with the user — they'll decide whether to proceed, adjust course, or return to planning.

Read the code file at `$WORKFLOW_DIR/<branch>/code.md`. If it doesn't exist, stop: "No code file found for branch `<branch>`. Run `/code` or `/icode` first." It tells you which files to examine and stage, explains any intentionally skipped findings, and lists plan deviations — triaged in Phase 2.

Read the review file at `$WORKFLOW_DIR/<branch>/review.md`. If it doesn't exist, stop: "No review file found for branch `<branch>`. Run `/review` first."

Gather the changes:

```bash
git diff HEAD    # full branch diff
git diff         # unstaged changes — what the latest /icode session did
git status --porcelain
```

If there are no changes since the previous review, stop: "No changes since the last review. Run `/ireview` only after an `/icode` session."

## Phase 2: Verify

Before working through the findings, run the project's test suite, if it exists, and note the results. Failures introduced by the latest `/icode` session are findings. Pre-existing failures (present before the change) must be flagged to the user but do not block the review.

If the project has no test infrastructure, write `None — no test suite in this project` in the Test Coverage section — the code phase skips test creation without a framework, so absent tests are never findings.

Work through every finding in the previous review file:

- **Checked-off items** (`- [x]`): verify the fix actually landed and works. If a checked item is not actually fixed, uncheck it and carry it forward with a note.
- **Unchecked items** (`- [ ]`): check the code file's Unresolved issues for an explanation.
  - If the explanation is sound, treat the item as accepted: move it to Won't Fix as a plain bullet (no checkbox) so it no longer counts as open, and tell the user what you accepted.
  - If the explanation is missing or unacceptable, carry the finding forward as open with a note clarifying why the skip doesn't stand.
  - If the call is close, ask the user — don't decide alone.

The plan is a map, not a railroad — deviations happen for valid technical reasons. When an unchecked item relates to a plan deviation, apply the same triage as `/review`: documented with sound justification → move to Won't Fix; undocumented or unsound → carry forward unchecked with a note; close call → ask the user. Never suggest changing the plan — the resolution paths are the iteration flow (/icode → /ireview) or human escalation.
- **Won't Fix items**: carry them forward as-is, unchanged — the review file is a complete record.

Then review the new changes with fresh eyes across the five dimensions — Correctness, Suitability, Readability, Performance, Test Coverage — using the same standards as `/review`. Add any new findings. Always compare against the plan when available.

## Phase 3: Write Review

Create `$WORKFLOW_DIR/<branch>/` if it doesn't exist, then overwrite `$WORKFLOW_DIR/<branch>/review.md` with this structure (the HTML comments are instructions for you — do NOT include them in the output):

```markdown
# Review: `<branch>`

## Critical
<!-- bugs, logic errors, security issues — must fix before merging -->
- [ ] <specific finding with file, line number, and reasoning>

## Warnings
<!-- undocumented or unsound plan deviations, fragility, maintainability concerns — should fix -->
- [ ] <specific finding with file, line number, and reasoning>

## Suggestions
<!-- style improvements, alternative approaches, nits — nice to have -->
- [ ] <specific finding with file, line number, and reasoning>

## Test Coverage
<!-- missing coverage, vague or misleading tests, tests that don't assert what they claim, tests that became unnecessary, test failures introduced by the change -->
- [ ] <specific finding with file, line number, and reasoning>

## Won't Fix
<!-- accepted plan deviations and skips; plain bullets, no checkboxes — not actionable, documented for posterity -->
- <accepted decision>

## Summary
<!-- 1-2 sentences overall assessment -->
```

Rank findings as in `/review`: Critical (broken or unsafe), Warning (meaningful problem — undocumented or unsound plan deviation, fragility, maintainability concerns), Suggestion (could be better). Be specific in every finding: reference exact files, line numbers, and relevant plan sections. Use `- [ ]` checkboxes for actionable findings so they can be tracked across iterations.

After writing, stage the files listed in the code file's Files changed section — never `git add .`, and never anything outside that list:

```bash
git add <file1> <file2> ...   # the files from code.md's Files changed section
```

If the working tree has uncommitted files that are NOT in that list, point them out to the user — they were never reviewed and should not be committed as-is.

## Phase 4: Terminal Check

Count the open findings: `- [ ]` items in Critical, Warnings, and Suggestions. Won't Fix items don't count.

- **Zero open findings**: tell the user: "Ready to commit: the review has no open findings. All findings are resolved or accepted as Won't Fix." Summarize what was accepted as Won't Fix so the human can veto.
- **Open findings remain**: tell the user: "<n> open finding(s) remain in `$WORKFLOW_DIR/<branch>/review.md`. Run `/icode` in a fresh session to address them."
