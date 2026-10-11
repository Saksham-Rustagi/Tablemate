# Tablemate — instructions for Claude Code

Read `docs/PROJECT_RULES.md` first and follow every rule in it. It holds the project context, the run/test commands and Tablemate's never list. Also read `docs/Tablemate_Tech_Spec.md` and `src/contracts.ts`.

Short version of the hard bans:
- Never read or print `.env`.
- Never `git commit` or `git push`.
- Never start, stop or kill `src/main.ts`, `cloudflared` or `scripts/run.sh`.
- Never send real iMessages or place real phone calls; tests use the fake transport and mocked HTTP.
- Bun is at `~/.bun/bin/bun`. Type-check with `node_modules/.bin/tsc -p tsconfig.json`.
