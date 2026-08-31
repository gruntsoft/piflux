---
description: Set up a feature branch for the plan→code→review workflow
argument-hint: "<branch-name>"
---
You are starting the workflow: set up a feature branch so a planning session can follow. Your task is branch management only — branch creation, collision handling, and writing a start artifact. Planning itself happens later via `/plan`.

## Phase 1: Branch name

Take the branch name from the argument ($@). The workflow extension has already sanitized it (lowercase, non-alphanumeric characters replaced with hyphens, trimmed) — accept it exactly as given. Do not sanitize, slugify, or validate it; if git rejects the name when creating the branch, report git's error and let the user pick a different name.

If none was provided, ask the user for a branch name before proceeding.

**Check for an existing start artifact** (before creating any branch):

- If `$WORKFLOW_DIR/<branch>/start.md` already exists, warn the user and ask whether to overwrite it or pick a different branch name.

**Check for uncommitted changes** (before creating any branch):

```bash
git status --porcelain
```

If there are any changes (tracked or untracked), warn the user: "There are uncommitted changes in the working tree. It's best to start from a clean slate. Would you like to stash them, clean them, or proceed anyway?" If the user chooses to stash, run:

```bash
git stash push -m "start-before-<branch>"
```

## Phase 2: Create the branch

Determine the default branch:

```bash
git remote show origin | grep "HEAD branch" | cut -d: -f2 | xargs
```

Get the current branch:

```bash
git branch --show-current
```

**If you are on the default branch:**
- Refresh the default branch before branching off it (if the fetch fails — e.g., offline — skip it and use the local ref):
  ```bash
  git fetch origin
  ```
- Create and switch to the new branch:
  ```bash
  git checkout -b <branch> origin/<default>
  ```

**If you are NOT on the default branch:**
- Ask: "You're on branch `<current>`, not the default `<default>`. Should the new work be based on `<current>` or `<default>`?"
- Wait for the answer.

  **If the user chose `<current>` (the branch they're on):**
  ```bash
  git checkout -b <branch>
  ```

  **If the user chose `<default>`:**
  ```bash
  git fetch origin
  git checkout -b <branch> origin/<default>
  ```

**After branching**, handle branch collisions: if `git checkout -b <branch>` fails because the branch already exists, report the error and suggest a modified branch name.

Note down which branch the new branch was created from (the `<default>` or `<current>` you branched off) — you'll record it in the start artifact next.

## Phase 3: Write the start artifact

Create the directory first if needed:

```bash
mkdir -p "$WORKFLOW_DIR/<branch>"
```

Write `$WORKFLOW_DIR/<branch>/start.md` with this structure:

```markdown
# Start: <branch>

## Metadata
- Feature branch: <branch>
- Base branch: <branch the new branch was created from>
```

After writing the file, tell the user: "Branch `<branch>` created from `<base>`. Start a fresh session with `/plan <description>` to plan the work."
