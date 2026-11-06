# Working rules

These rules apply to everyone who changes this repository, including coding agents.

## Repository layout

This repository is public. It holds the generic tool: nothing in it may depend on, or name, a particular user's project.

It can run on its own, or as a submodule of a private product repository, for example at `studio/`.

**Before you change anything:**

1. Run `git rev-parse --show-superproject-working-tree`.
2. If it prints a path, you're in a submodule. Read that repository's `AGENTS.md` too. Its rules add to these.
3. Decide where the change belongs:
   - A generic feature or fix goes here.
   - A project's bumper, font, music, logo, theme, notes or plan goes in that project's repository, as an [extension](README.md#extensions) when it affects the app.
   - If a generic feature would have to name a project, add an extension point here, and put the project's part in the extension.

**To work across a submodule and its parent:**

1. Commit and push here first, on this repository's `main`.
2. In the parent, stage the `studio` path and commit the new pointer. Never commit a pointer to a commit that isn't pushed.
3. Run `git status` in both repositories before you finish. A submodule starts in detached `HEAD`, so run `git switch main` in it before you commit.

## What must stay out

- Personal or project names, absolute paths, hostnames, account names and email addresses, in code, tests, placeholders and docs. Use made-up examples such as `acme/widget` and `example.com`.
- Tokens, keys and passwords. Never print them. Secrets stay on the server and in ignored files, and API responses never return them.
- Fonts, music, logos and other files you may not redistribute.

`npm run check:public` checks for paths and secrets, and CI runs it. It can't recognize names, so read your diff.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, such as `fix(video): keep labels on missing shots`.
- Make one logical change per commit, and work directly on `main`.
- Credit only people as authors: no `Co-Authored-By` trailers, and no tool attribution or "Generated with" footers in commits, code, docs or UI text.
- Don't rewrite pushed history.

## Before you commit

All of these must pass:

```sh
npm run typecheck
npm test
npm run test:integration
npm run check:public
```

`npm run test:integration` needs the Postgres container. Run `npm run test:render` as well after a change to rendering. It needs Postgres and Garage.

Add a test with every fix and feature. Report failures as they are.

## Writing

- Code, comments, docs, commit messages and UI text describe what is, in the present tense. They don't describe what used to be, how a defect was found or what a session did. What no longer exists belongs in Git history.
- Keep the README in step with the behaviour you change.
- State a constraint a reader must respect, with a reason that stands on its own.
- Write UI text and docs for the reader: lead with the point, use short sentences, and keep one term for one concept.

## Code

- The browser preview and the export draw through the same code in `video/`. Keep them on one path, so the preview shows what the export produces.
- `shared/` and `video/` run on the server and in the browser, so they use no Node.js APIs.
- Extensions depend only on `shared/extension.ts`. Treat a change to it as a change to a public contract, and update `examples/title-card` and the README with it.
- Long work runs on the server as a job, not in a request.
- A schema change adds one `applyMigration` call with the next version number in `server/db.ts`. Never edit a migration that has shipped.
- Never run real publishing, uploads, paid narration or anything that costs money or changes an external account just to verify a change. Mock it in tests.
