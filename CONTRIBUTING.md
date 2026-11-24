# Contributing to SelfGraph

We use an issue-first flow, so that we can review each change. Read this page
before you open a pull request (PR).

Talk to us on [Discord](https://discord.gg/HcBKJHXmnu). Each PR gets one
thread in `#pr-discussion`; keep all discussion of a change there and in the PR,
including asking for a review or for a PR to be closed.

## The flow

```
open an issue  ->  issue /approved  ->  open a PR  ->  review & merge
   (anyone)         (maintainer)          (you)
```

1. Open an issue. Describe the bug or the change. Anyone can open an issue and discuss it.
2. Wait until a maintainer approves the issue with `/approved`.
3. Open a PR that links the approved issue with `Closes #123`.

Only the issue author or a person assigned to the issue can open the PR for it.
To work on an issue that another person opened, comment on the issue and ask a
maintainer to assign it to you.

A maintainer is a person in the `maintainers` list of
[`.github/vouched.json`](.github/vouched.json), or a person with write access
to this repository.

## Pull request rules

- Link an approved issue with `Closes #N`. You must be the issue author or an assignee. If not, a bot closes the PR. To be assigned, comment `/take` on an unassigned approved issue (up to 10 assigned issues at a time).
- Keep a maximum of 10 open PRs. If you open more, a bot closes your newest PR. Get an earlier PR merged or closed first. To ask, post in `#pr-discussion` on Discord.
- Keep each PR small and change only what the issue asks for. If a PR is large or has unrelated changes, we ask you to split it.
- A PR over 1,000 changed lines (additions plus deletions, lockfiles excluded) is not reviewed. Split it into stacked PRs: open the first against `main`, base each next one on the previous branch, and give the order in each description ("1/3", "2/3").
- If your PR has a breaking change, describe it in the PR.
- Raise every new error with a code and a hint, the same on the API, CLI, and MCP in both SDKs, and never show a password or token in it. [`AGENTS.md`](AGENTS.md) has the details.
- Fill in the "AI Assistance" section of the PR template. Do not remove it. If the section is missing, the gate check fails. You are responsible for each line that you submit.

## Build and test

Install with `pip install -e ".[dev]"`. [`AGENTS.md`](AGENTS.md) covers the
lint and test commands, the graph backend the test suite needs, the TypeScript
port, the architecture, and the conventions every change must follow.

## Before you push

Most review rounds are spent on mechanical misses. Catch them yourself first.

1. Run the precheck: `python scripts/precheck.py --base origin/main` (or `make precheck`).
   It is stdlib only and runs on embedded Kuzu. It flags tests that already pass on
   main, banned comments, em dashes, BOMs, a half-updated conformance pair, a PR over
   1,000 changed lines, and a branch that no longer merges. The CI job
   `review-precheck` runs the same script.
2. Run the probes for the area you changed: `make probes`, or one at a time under
   `scripts/probes/`. Each runs on Kuzu with no network. Use `parity_table.py` for a
   Python or TypeScript change, `plan_apply.py` for maintenance or the contradiction
   judge, `secret_echo.py` for store or connection code, and `unmerge_order.py` for
   resolution and merges.

### Checklist

- New tests must fail on main; assert the new behaviour or stored state, not just that a call raises.
- Reuse existing helpers; grep for the literal, regex, or Cypher before you write a new function.
- No dead, defensive, backward-compatibility, legacy-data, or migration code.
- One-line doxygen docstrings only; give the TypeScript side the same `@return`; no narration comments, em dashes, or BOMs.
- Change Python and TypeScript together (results, ids, encoding, error text, warning codes, flags, MCP shapes); any change to parsing, validation, error text, or ordering needs a case in both `py_side.py` and `ts_side.ts`.
- Fix every sibling path: node and edge, single and batch, every store, scalar and nested, explicit and generated ids, API and CLI and MCP.
- Key by owner and name, not the surface form; scope synonyms and certification to the owner; handle keys with `\0`, `:`, and `"`.
- Removal (unmerge or delete) must keep what another merge or a direct statement still backs, and must not depend on order.
- Never let a credential reach an error message, a driver message, or the exception chain.
- Build the result from what was stored, not from the plan; a destructive step must not run before a write that can still fail.
