# CLAUDE.md

Instructions for Claude Code sessions working in this repository.

## Branching rule (set by the owner, 27/09/2026)

- Use ONE branch and ONE pull request for the whole task.
- Commit and push every step to that same branch. Do not open a new branch or PR per step.
- Do not merge the PR yourself. Report when the task is complete and wait for the owner to
  merge.
- If the PR gets merged mid-task, stop and ask before creating any new branch.

This rule replaces every earlier instruction to open a pull request per ticket or step, or
to merge as soon as CI is green, wherever it appears, including:

- `docs/HANDOFF.md`, section 4 "How to work here" (now points here);
- `docs/01-MASTER-BUILD-PROMPT.md`, rule 2 (push after every ticket and check the remote
  `main` SHA): push each step to the task's branch instead; `main` changes only when the
  owner merges;
- `docs/00-README.md`, "Order of work" step 5, and DECISIONS.md D-004 and D-073, where
  they describe pushing or merging per ticket;
- any brief given in a session that asks for a PR per step or a self-merge.

The rest of those documents still applies.
