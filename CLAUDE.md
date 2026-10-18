# mixr: rules for agents

## No PII or PCI in the repo. Ever.

This applies to code, tests, fixtures, eval data, prompt examples, docs, commit messages and screenshots.

- **No real names.** Not users, not testers, not teammates, not anyone from a screenshot or a real chat. Use invented names (Maya, Jordan, Priya, Riley, Sam, Casey). Refer to teammates by role ("the messaging dev").
- **No real phone numbers.** Use the fictional 555-01xx range (`+1425555xxxx`, `+1555...`).
- **No real emails.** Use `@example.com`, or a made-up local part at `uw.edu` where the code requires a UW address. Project addresses on our own domain (`hello@joinmixr.club`) are fine.
- **No personal hostnames or logins** (e.g. an ssh user@host built from someone's name). Read them from env (`DEPLOY_HOST`).
- **No card numbers, keys or tokens.** `.env*` stays out of git.
- **Real chats are inspiration only.** When a bug shows up in a real conversation, rewrite the repro with invented names and wording before it goes into a test or eval case.

Before every commit, grep the diff for names you've seen in chat or screenshots, phone numbers outside 555, and emails outside example.com. Subagents must be told this rule in their prompt.
