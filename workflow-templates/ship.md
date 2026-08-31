---
description: Commit, merge, and push the current feature branch to its base branch
---
You are shipping the work on the current feature branch: commit it with a human-approved message, merge it into the base branch (squash or `--no-ff` per the plan's `Merge strategy`), and push the base branch to origin. This is the point of no return — after the push, the work is merged and public.

## Phase 1: Discovery

Get the current branch:

```bash
git branch --show-current
```

Determine the default branch:

```bash
git remote show origin | grep "HEAD branch" | cut -d: -f2 | xargs
```

If you are on the default branch, stop: "You are on the default branch. `/ship` ships a feature branch. Run `/plan` first to create one."

Read the plan file at `$WORKFLOW_DIR/<branch>/plan.md`. If it does not exist, stop: "No plan file found for branch `<branch>`. Run `/plan` first — the plan provides the base branch and the commit message."

The plan file is **read-only**. Never modify it. If the plan is wrong, incomplete, or inconsistent with what you find, raise it with the user — they'll decide whether to proceed, adjust course, or return to planning.

Read the `## Metadata` section for the base branch. If it's missing (the plan was written before the Metadata section existed), ask the human for the base branch before proceeding.

Check the working tree:

```bash
git status --porcelain
```

- **Staged changes** — expected (the review flow stages files). Proceed.
- **Unstaged tracked changes** — list them and ask: stage them into the commit, leave them out, or abort?
- **Untracked files** — list them and ask: add them (if they're part of the work), leave them, or abort?
- **Nothing at all** — clean tree: check whether the feature branch is ahead of the base branch (`git log --oneline <base>..<branch>`). If it has no commits ahead, stop: "Nothing to ship. The working tree is clean and `<branch>` has no commits ahead of `<base>`." If it does have commits ahead, skip the commit step and proceed to the merge.
- If nothing ends up staged after the questioning (the human chose to leave everything), apply the same clean-tree check above.

## Phase 2: Commit

Draft a commit message from the plan, following the repo's commit conventions (imperative mood, concise):
- **Subject**: derived from the plan title (the `# ` heading) — rewrite it as a concise imperative ("Add X", "Fix Y"), don't copy it verbatim.
- **Body**: derived from the plan's Why section — condense the motivation into 1-2 sentences, don't copy it verbatim.

Show the human the staged diff summary (`git diff --cached --stat`) and the draft message. Ask them to approve the message or edit it. **Do not commit until the human confirms** — no fully automatic commits. Tell them the same message will be used for both the feature-branch commit and the squash-merge commit.

Stage the files the human chose to add, then commit on the feature branch:

```bash
git add <files the human chose to add>
git commit -m "<subject>" -m "<body>"
```

## Phase 3: Merge

Identify the merge base and the commits being integrated:

```bash
git merge-base <base> <branch>
git log --oneline <merge-base>..<branch>
```

Check whether the base branch has moved ahead since the branch point:

```bash
git log --oneline <branch>..<base>
```

If the base has commits the feature branch doesn't have, warn the human: the merge will fold those changes in too, which may cause conflicts. Proceed with their consent or abort.

Read `Merge strategy` from the plan's `## Metadata` section:

```bash
MERGE_STRATEGY=$(grep -E '^\s*-\s*Merge strategy:' "$WORKFLOW_DIR/<branch>/plan.md" | sed -E 's/^\s*-\s*Merge strategy:\s*//')
```

Note: this workflow never pushes the feature branch itself — `/done`'s remote-deletion step expects the branch may never have existed on origin, so there is nothing to reconcile here.

If it's `merge`, integrate with an explicit merge commit — preserving full history. `-m` suppresses the editor, matching the squash path's non-interactive behavior:

```bash
git checkout <base>
git merge --no-ff -m "<subject>" -m "<body>" <branch>
```

If the `--no-ff` merge hits conflicts, git stops with a conflicted index — resolve them with the human, then finish the merge with `git merge --continue` (or `git commit`) and continue with the push.

Otherwise (`squash` or absent), use the squash path — fold everything into one commit:

```bash
git checkout <base>
git merge --squash <branch>
```

If the squash merge hits conflicts, stop and resolve them with the human, then commit and continue with the push. If `git merge --squash` stages nothing, stop: there is nothing to merge.

Commit the squash merge with the same confirmed message (the `--no-ff` path already created its commit via `-m` — skip this step there):

```bash
git commit -m "<subject>" -m "<body>"
```

## Phase 4: Push

```bash
git push origin <base>
```

If the push fails because the remote base has advanced (non-fast-forward), stop and explain. Do not force-push. The human must update the local base (e.g., `git pull --rebase` or merge `origin/<base>`), re-push, then re-run `/ship` or finish manually.

## Phase 5: Tag the release (only when the plan declares it)

Read `New version` and `Tag release` from the plan's `## Metadata` section:

```bash
NEW_VERSION=$(grep -E '^\s*-\s*New version:' "$WORKFLOW_DIR/<branch>/plan.md" | sed -E 's/^\s*-\s*New version:\s*//')
TAG_RELEASE=$(grep -E '^\s*-\s*Tag release:' "$WORKFLOW_DIR/<branch>/plan.md" | sed -E 's/^\s*-\s*Tag release:\s*//')
```

Tagging is never automatic — it is a plan-time decision executed here:

- `TAG_RELEASE` is not `true` (or absent) → skip this phase silently. No tag. (`Tag release: false` with a clean `2.0.0` is a valid, expressible choice.)
- `TAG_RELEASE` is `true` but `NEW_VERSION` is empty → warn and skip: the plan declares a tag but no version, and guessing a version is worse than no tag.
- Both present and `true` → the tag name is `NEW_VERSION` verbatim (`1.4.0` → `1.4.0`, `v2.0.0` → `v2.0.0`); any prefix the human wants belongs in the plan's `New version` field itself. Create the tag on the base branch ref, not on HEAD — the merged commit already lives on `<base>`:

```bash
git tag <tag-name> <base>
```

  - If `git tag` fails because the tag already exists, warn and continue.
  - If it fails for another reason, warn and continue — the tag is not worth blocking the ship; note it in your closing report so the human can tag manually.

Push the tag to origin — best-effort, warn and continue on failure (network, auth); the tag stays local:

```bash
git push origin <tag-name>
```

Report the tag outcome (created/pushed, skipped per plan, or failed) in your closing message — `/done` reports it as "see the ship session's report".

## Phase 6: Return

Switch back to the feature branch so the human can inspect the merge commit before cleanup:

```bash
git checkout <branch>
```

Tell the human: the merge commit is on `<base>` and was pushed to origin. They can inspect it with `git show <base>` or `git log origin/<base>`. If something is wrong, they can fix it on `<base>` and push — then run `/done` to finish the workflow. Note any changes the human chose to leave unstaged/untracked — they're still in the working tree.

`/done` is now the full cleanup: it deletes the remote feature branch (per the plan), deletes the local feature branch, switches to the base branch, and removes all workflow sessions and artifacts — no separate `/cleanup` step exists anymore.
