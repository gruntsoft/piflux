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

## Phase 2: Check the branch name, then create or adopt the branch

Determine the default branch:

```bash
git remote show origin | grep "HEAD branch" | cut -d: -f2 | xargs
```

Get the current branch:

```bash
git branch --show-current
```

**Pre-flight collision checks** — before creating anything, check whether a branch named `<branch>` already exists, locally and on origin:

```bash
git branch --list <branch>
```

```bash
git ls-remote --heads origin <branch>
```

**If the branch exists locally** (non-empty `git branch --list` output):

- Ask: "A local branch `<branch>` already exists. Should this workflow adopt it as its working branch, or would you like a different branch name?"
- If the user picks a **different name**, rerun this phase's collision checks with the new name.
- If the user chooses to **adopt** the existing branch, no branch is created. Ask explicitly which base branch the work should target: "Which base branch should this work target?" — suggesting the default branch (`<default>`). The base must differ from the adopted branch itself; reject an answer naming `<branch>` and ask again. If the adopted branch is not currently checked out, switch to it (`git checkout <branch>`). Note down that the branch was **not** created by this workflow — you'll record that in the start artifact — together with the chosen base branch, then continue to Phase 3.

Note that the `ls-remote` pattern is a tail match: an output line ending in `refs/heads/old/<branch>` (or any `<segment>/<branch>`) does **not** mean `<branch>` exists on origin. Treat the remote as holding the branch only when a printed ref is exactly `refs/heads/<branch>` — the sha is arbitrary, the ref path must match exactly.

**If the branch exists on origin only** (empty `git branch --list` output, and `git ls-remote` printed a ref that is exactly `refs/heads/<branch>`), do not proceed with this name: tell the user "A branch `<branch>` already exists on origin — pick a different branch name for this workflow" and rerun the collision checks with the new name. Adoption is not offered here: a locally created branch shadowing a remote branch name is a hidden trap for later teardown.

**If the branch exists neither locally nor on origin** (no local hit, no exact `refs/heads/<branch>` ref printed), create it:

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

Note down whether the branch was **created** by this workflow (`checkout -b` ran) or **adopted** (an existing local branch), and which branch it is based on (`<default>` or `<current>` for created; the user's explicit answer for adopted) — you'll record both in the start artifact next.

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
- Base branch: <branch the new branch was created from, or the user-chosen base for an adopted branch>
- Branch created by workflow: <true | false>
```

After writing the file, tell the user — truthfully for what happened: "Branch `<branch>` created from `<base>`." when the branch was created, or "Using existing branch `<branch>`, based on `<base>`." when it was adopted. Then: "Start a fresh session with `/plan <description>` to plan the work."
