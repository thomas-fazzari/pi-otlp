# Contributing

Run `mise run install` once after you clone. It installs the dependencies and the Git hooks that check commit messages.

1. Branch from `master`. Name the branch `type/subject`, such as `fix/tool-legend`.
2. Write each commit title as `type: subject`, such as `fix: dashboard failure panels and tool legend`. The types are `fix`, `feat`, `test`, `style`, `docs`, `build`, `ops`, `chore`, `perf` and `refactor`. You may add a lowercase scope after the type, as in `fix(dashboard): tool legend`. Start the subject with a lowercase letter. Add `!` before the colon for a breaking change. Keep the title within 50 characters. A commit has a title only, so put the description in the pull request.
3. Run `mise run check` before you push. For changes to the exported telemetry, also run `mise run e2e`, which needs Docker.
4. Open a pull request. Write its title like a commit message (the squash merge uses it). The `ci-ok` check must pass.

## Releases

Tag a `master` commit whose `ci-ok` check passed. Name the tag after the version, such as `v0.1.0`, and push it. CI then publishes the npm package at that version, and a GitHub release with the Grafana dashboard. Each runs in its own job, so you can rerun a failed one alone. The version comes only from the tag, and `package.json` keeps `0.0.0`.
