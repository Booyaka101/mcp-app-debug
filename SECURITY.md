# Security Policy

## Supported versions

The latest version published to npm is the only one that gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/mcp-app-debug/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this touches

Connects to an MCP server you point it at and renders its app locally. Headers you pass are sent to that server and nowhere else.

- **It starts the MCP server you name.** With `--stdio` that is arbitrary local process execution, by design. Point it only at servers you would run anyway.
- **Headers you pass with `--header`** go to the target server and nowhere else. They are not logged.
- **Rendered app content is untrusted.** It comes from the server under test. The host renders it in a sandboxed frame; report anything that escapes.

## Scope

In scope: anything that leaks a credential, reads data belonging to someone else, or lets untrusted input reach code execution.

Out of scope: findings that require an attacker to already control the machine it runs on.
