# Pobify integration

The `pobify` branch contains two isolated extensions:

- A draggable resource overlay mounted from `AppHeader.vue`.
- Detailed descriptions for models returned by the existing Ollama model selector.

The resource overlay reads `http://127.0.0.1:7412/v1/metrics` once per second. It stores only its layout preferences in local storage.

Daily automation merges the latest `n8n-io/n8n` master into a deterministic short-lived branch
and opens one pull request for each upstream tip. It creates one open issue instead of guessing when
conflicts occur. Add `.github/workflows/util-pobify-sync.yml` to the fork's default `master` branch
as well as `pobify`. GitHub only schedules workflows that exist on the default branch. Add
`.github/workflows/build-pobify-image.yml` to `master` too when manual image dispatch is required.
Manual image runs always check out `pobify`. A stale build does not publish a mutable image tag.

The complete fork is stored in `PoghyBiboLabs/n8n`. The independent private mirror is
`PoghyBiboLabs/n8n-pobify-mirror`. Set `POBIFY_AUTOMATION_TOKEN` to a fine-grained token that can
write contents, workflows, issues, and pull requests in the fork. A separate token is required because pushes
made with the workflow `GITHUB_TOKEN` do not start pull-request CI. Set `MIRROR_TOKEN` to a token
that can write contents and workflows in the private mirror. The mirror job synchronizes every fork branch and all tags.
