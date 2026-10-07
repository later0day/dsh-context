# dsh-context

A DeepSeek Harness plugin for context insight, actions, and management.

## Background

- DeepSeek Harness (dsh):
  - an open-source agent harness developed by DeepSeek AI.
  - Github: https://github.com/deepseek-ai/deepseek-harness
  - NPM: @deepseek-ai/dsh
  - MUST ensure the full clone of the DeepSeek Harness repository is available locally, before any work.
  - MUST always dive deep into the details of dsh source code and dependencies, for its mechanisms, lifecycles, and modules. Ensure every decision is based on the full and actual truth of the dsh source code.
  - Local clone at `~/dev/deepseek-harness`: `git pull` on `main` to update, and run `pnpm install` after pulling or switching commit/tag. Commits and version tags are available for reference and diff.

- DeepSeek Harness Plugin:
  - Reference docs: https://deepseek-harness.github.io/deepseek-harness/en/reference/
  - Example plugins: GitHub topic `dsh-plugin` — https://github.com/topics/dsh-plugin

## Coding
- Make the minimal change that fully solves the problem, with the most efficient implementation.
- Reuse the classes, utilities, styles, style tokens, events, presets, and lifecycles that DeepSeek Harness already provides.
- Keep code and tests small, loosely coupled, and modular; avoid duplication.
- Add comments only for major decisions or significant value, and update or delete outdated ones when modifying the code.
- Write comments, documentation, PR descriptions, and commit messages in English.
- Generate one-time temp files in the `.tmp` directory and clean them up right after use.

## Pre-commit checks

Complete ALL of these before ANY commit:

- Close out the to-do list, ensuring every item is completed, cleaned up or explicitly closed.
- Review the full diff independently: every change necessary, correct, and not over-engineered.
- Clean up generated temporary files and temporary or unhelpful comments.
- Run `pnpm run lint:fix && pnpm run test && pnpm run build` as a single command and capture the FULL output.
  - Example for per-file 100% coverage output:
    ```
    % Coverage report from v8
    -------------------------|---------|----------|---------|---------|-------------------
    File                     | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
    -------------------------|---------|----------|---------|---------|-------------------
    -------------------------|---------|----------|---------|---------|-------------------
    ```

## Layout & responsive

- The plugin pane is the shell's center column, not the viewport — its width follows the sidebar's collapse and drags. Drive responsive layout with container queries (the harness's own idiom), not viewport media queries.
- Fold, never crush: under width pressure, wrap rows or fold grid columns instead of truncating into unreadability. No horizontal scrollbars, no overlapping content, and every field stays reachable on the narrowest pane.
- Mind container-query side effects: size containment changes containing-block behavior, so fullscreen overlays portal to `document.body`. Point-of-use specifics live in the CSS comments next to the rules they guard.
- Verify layout changes visually before shipping: a spread of widths from desktop down to phone (~390px), in both locales (English labels are the truncation stress case), on a long session, including the `/context` modal.

## Build & run
- Run `pnpm run build` after code changes applied.
- Run `pnpm run watch` to keep the local plugin hot-reloaded on dsh while developing in the browser.
- The dsh web server may already be running at `http://127.0.0.1:3080/`.
- Run `pnpm run web` to restart it (kills the running `dsh web` first, then starts `dsh web --no-open`).
- If the browser hits an auth-token issue, kill the dsh process and restart with `dsh web --no-open`, then open the printed `http://127.0.0.1:3080/?token=XXXXXXXXX` URL.

## Compatibility - Important!
- MUST install and work correctly on every supported `@deepseek-ai/dsh` release, with no regressions in runtime dependencies, message parsing, or any user-visible behavior.
- **`docs/compatibility.md` is the single source of truth** — supported releases, durable-log generations, fold-by-shape and optional-seam rules, parsing resilience for untrusted log/projection data, low-level parity with the harness's own metering, and the baseline gates. Read it BEFORE any compatibility-relevant change, and keep it current whenever the code or the supported set changes.
- Consider updating dependencies to the latest version where possible — deepseek-harness evolves rapidly.

## I18n
- Chinese (Simplified) and English are supported for UI elements.
- Update all the supported languages translations when adding or modifying the UI elements.
- Do not keep the deprecated or unused language keys.

## Docs
- `docs` directory contains only end-user faced documents.
- `docs/social-preview.png` (GitHub social preview) must be exactly **1280 × 640 pixels**.
- `README.md` images must use external URLs so they render on both GitHub and NPM — put the file in `docs/` and embed it as `![alt](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/<image>.png)`.

## Git
- When asked to commit, please commit the possibly mixed changes separately for each task or purpose.
- `gh` cli is installed and logged in.
- Run `git push` after creating commits.

## Releasing
- Version X.Y.Z, 大版本.次版本.小版本。
- Review all the commits/changes since last tagged release.
- Releases are cut by tagging: `git tag vX.Y.Z && gh release create vX.Y.Z`.
- A [GitHub Actions workflow](.github/workflows/release.yml) then builds, tests, and publishes the package to npm automatically — no manual action needed.
- Write the release notes from the [release template](.github/release_template.md)

<!-- CODEGRAPH_START -->
## CodeGraph
This repo is indexed by CodeGraph (a `.codegraph/` directory exists at the repo root, if not run `codegraph init` to initialize it).
- MUST reach for it BEFORE any grep/find or reading files when you need to understand or locate code:
- **Shell** (always works): ALWAYS run and collect ALL output of `codegraph sync -q && codegraph explore --path /some-path "<symbol names or question>"` without truncating text
<!-- CODEGRAPH_END -->
