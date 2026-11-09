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

- Link an approved issue with `Closes #N`. You must be the issue author or an assignee. If not, a bot closes the PR.
- Keep a maximum of 3 open PRs. If you open more, a bot closes your newest PR. Get an earlier PR merged or closed first. To ask, post in `#pr-discussion` on Discord.
- Keep each PR small and change only what the issue asks for. If a PR is large or has unrelated changes, we ask you to split it.
- If your PR has a breaking change, describe it in the PR.
- Fill in the "AI Assistance" section of the PR template. Do not remove it. If the section is missing, the gate check fails. You are responsible for each line that you submit.

## Build and test

Install with `pip install -e ".[dev]"`. [`AGENTS.md`](AGENTS.md) covers the
lint and test commands, the graph backend the test suite needs, the TypeScript
port, the architecture, and the conventions every change must follow.
