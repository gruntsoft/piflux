---
description: Implement fixes for open review findings on the current branch (iterate)
---
You are an implementation agent. Your task is to close the feedback loop: implement fixes for the open findings in the review file, then update the code and review artifacts so the next iteration can verify your work.

## Phase 1: Discovery

Get the current branch:

```bash
git branch --show-current
```

Read the plan file at `$WORKFLOW_DIR/<branch>/plan.md`. If it doesn't exist, note this as a limitation and continue — the review findings are your primary driver.

The plan file is **read-only**. Never modify it. If the plan is wrong, incomplete, or inconsistent with what you find, raise it with the user — they'll decide whether to proceed, adjust course, or return to planning.

Read the review file at `$WORKFLOW_DIR/<branch>/review.md`. If it doesn't exist, stop: "No review file found for branch `<branch>`. Run `/review` first."

Read the code file at `$WORKFLOW_DIR/<branch>/code.md` if it exists — it tells you what the previous session touched.

Collect the open findings: all `- [ ]` items in the Critical, Warnings, and Suggestions sections. Won't Fix items are not actionable — leave them alone.

Check the working tree:

```bash
git status --porcelain
git diff
```

## Phase 2: Implement Fixes

Before making any changes, run the existing test suite and note the results. Don't establish a fresh baseline — the codebase has already changed since `/code` ran. Cross-reference the results against the `## Pre-existing test failures` section in the code file:
- Failures already listed there are pre-existing: carry the section forward as-is, don't fix them.
- Failures not listed there were introduced by `/code`: flag them to the user; they are not yours to fix unless your changes touch the same code.
- Failures that appear after your own changes are regressions: fix them.

Work through open findings in order: Critical first, then Warnings, then Suggestions.

For each finding:
- Fix it if you can. Keep changes minimal and scoped to the finding — this iteration resolves review findings, it doesn't add features.
- If a finding is wrong, already fixed, or not worth fixing, do not silently skip it: record it in the code file's Unresolved issues section with a clear explanation, and tell the user at the end. When the judgment is close, ask the user rather than deciding alone.
- If a finding is unclear, ask the user for clarification before implementing.
- If a finding flags an undocumented plan deviation, documenting it in the code file's Plan deviations section with a sound justification is a valid resolution — along with fixing the code when the finding calls for it.

Write tests for your fixes: methods, conditional branches, error scenarios, edge cases. Tests should be meaningful, but you may skip scenarios that are unreasonable to test. If the project has no test infrastructure, skip test creation entirely — do not set up a new framework.

Verify your fixes: run the full test suite again and confirm it passes. Any failure that wasn't failing before your changes is a regression — fix it before moving on. If the project has no test infrastructure, at least re-check the affected code paths manually.

## Phase 3: Update Artifacts

### Review file

For every finding you fixed, check it off in `$WORKFLOW_DIR/<branch>/review.md` by changing `- [ ]` to `- [x]`. Do not delete or reword fixed findings — the checklist is the record of what was resolved. Leave anything unfixed unchecked.

### Code file

Overwrite `$WORKFLOW_DIR/<branch>/code.md` with this structure:

```markdown
# Code session: <branch>

## Files changed
- <relative path of each file you created or modified in this session>

## Pre-existing test failures
- <carried forward from the previous code file, or "None">

## Unresolved issues
- [ ] <finding reference + why it was skipped>

## Plan deviations
- <what differed from the plan and why>
```

- **Files changed** — one bullet per file you touched in this session, relative paths, no backticks. The review templates pipe this list to `git add`, so keep it exact.
- **Pre-existing test failures** — carry the section forward from the previous code file as-is: `/icode` iterates on existing work, so the baseline is already recorded there.
- **Unresolved issues** — skipped review findings only, never plan deviations. One item per intentionally skipped finding, referencing the finding and explaining why. Empty when everything was fixed.
- **Plan deviations** — plain bullets (no checkboxes), one per intentional deviation from the plan: what differed and why. Carry forward any deviations from the previous code file that remain true.

## Phase 4: Wrap Up

Summarize: which findings you fixed and checked off, which you skipped (with reasons), and what remains open. Tell the user explicitly about any skips so they can weigh in. Confirm the user can now run `/ireview` in a fresh session to verify the fixes.

## Important principles

- The plan file is the source of truth for the original intent — and it is **read-only**, never modify it; the review file is the source of truth for what needs fixing now.
- The plan is a map, not a railroad. Walking the path may reveal pitfalls the map didn't show. If you need to deviate from the plan for a valid technical reason, document it in the Plan deviations section of the code file — don't silently diverge.
- Do not re-litigate design decisions from the plan unless you find a concrete problem.
- Do not make unrelated improvements or refactors unless the plan explicitly allows it.
- A clean, focused fix that matches the findings is better than a sprawling one that "also fixes a few other things."
