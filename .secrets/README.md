# Encrypted credentials

Provider API keys (Anthropic, OpenAI, Gemini, HuggingFace) are stored
**encrypted** as one JSON file per key in `./credentials/`. Each file contains
AES-256-GCM ciphertext plus IV and metadata, derived from a single master
passphrase. The ciphertext files are safe to commit and are required for CI.

The only sensitive value is the passphrase, exported as
`WORKGLOW_SECRETS_PASSPHRASE`. Plaintext API keys never touch disk and never
land in shell history or `.env` files.

> **Threat model.** "No plaintext on disk, in argv, or in CI secret slots" —
> not "no plaintext anywhere." Once the test process starts, decrypted values
> live in `process.env` and the V8 heap, so they're recoverable by anything
> with debugger / core-dump access to that process (other test code, postinstall
> scripts, native addons, …). Treat decrypted values as you would any other
> in-memory secret in a Node/Bun process.

## Local setup

1. Pick a strong passphrase and store it in your OS keyring (macOS Keychain,
   `secret-tool` on Linux, Windows Credential Manager). A simple shell wrapper:

       export WORKGLOW_SECRETS_PASSPHRASE="$(security find-generic-password -s workglow-secrets -w)"   # macOS
       export WORKGLOW_SECRETS_PASSPHRASE="$(secret-tool lookup service workglow-secrets)"             # Linux

2. Add credentials. You can import keys you already have exported in the
   current shell, import them from a `.env` file, or set them one-by-one.
   The interactive prompt disables terminal echo so the value isn't visible
   as you type; for scripted use, pipe the value via stdin (the CLI rejects
   positional value arguments to keep secrets out of shell history):

       # bulk-import from current shell env vars:
       bun scripts/credentials.ts import-env
       # bulk-import from a .env-format file (only known keys are imported):
       bun scripts/credentials.ts import-dot-env path/to/.env
       # interactive (TTY, echo off):
       bun scripts/credentials.ts set anthropic-api-key
       # or piped:
       printf '%s\n' "$ANTHROPIC_API_KEY" | bun scripts/credentials.ts set anthropic-api-key

   `import-dot-env` accepts the standard `.env` syntax: blank lines, `#`
   comments, optional `export ` prefix, and unquoted / single-quoted /
   double-quoted values (double-quoted values support `\n`, `\r`, `\t`,
   `\\`, `\"` escapes). Env vars not in the credential map (e.g.
   `UNKNOWN_KEY=…`) are reported as skipped, not silently dropped.

3. Run tests as usual. `vitest.setup.ts` and `bunfig.toml`'s test preload will
   decrypt the store and hydrate `process.env.ANTHROPIC_API_KEY` (etc.) for the
   duration of the test process only.

       bun run test

If `WORKGLOW_SECRETS_PASSPHRASE` is unset, the encrypted layer stays locked and
integration tests skip via their existing `!!process.env.*_API_KEY` guards.
Unit tests run unaffected.

## CI setup

1. Configure a single repository secret named `WORKGLOW_SECRETS_PASSPHRASE`.
2. Commit ciphertext from `.secrets/credentials/*.json` to the repo.
3. Export the secret in the test job:

       env:
         WORKGLOW_SECRETS_PASSPHRASE: ${{ secrets.WORKGLOW_SECRETS_PASSPHRASE }}

That replaces having to configure `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
as separate CI secrets.

## Known credential keys

| Credential key       | Env var hydrated     |
| -------------------- | -------------------- |
| `anthropic-api-key`  | `ANTHROPIC_API_KEY`  |
| `openai-api-key`     | `OPENAI_API_KEY`     |
| `google-api-key`     | `GOOGLE_API_KEY`     |
| `gemini-api-key`     | `GEMINI_API_KEY`     |
| `hf-token`           | `HF_TOKEN`           |
| `xai-api-key`        | `XAI_API_KEY`        |
| `openrouter-api-key` | `OPENROUTER_API_KEY` |
| `deepseek-api-key`   | `DEEPSEEK_API_KEY`   |
| `typesafe-api-key`   | `TYPESAFE_API_KEY`   |

To add another, edit `CREDENTIAL_TO_ENV` in `scripts/lib/test-credentials.ts`.

## Rotating the passphrase

    WORKGLOW_NEW_SECRETS_PASSPHRASE="<new>" bun scripts/credentials.ts rotate

This decrypts every credential under `$WORKGLOW_SECRETS_PASSPHRASE`, re-encrypts
under `$WORKGLOW_NEW_SECRETS_PASSPHRASE`, and writes the result back to
`.secrets/credentials/`. Update the keychain/CI secret to the new value and
commit the changed ciphertext files. The new passphrase is read from an env
var (not argv) so it doesn't end up in shell history.

## Decrypt errors during tests

If the test preload prints `Failed to decrypt …`, the passphrase you exported
doesn't match the ciphertext on disk. Either:

- Fix the env var (e.g. re-export from your keychain), or
- Wipe `.secrets/credentials/*.json` and re-add keys via `import-env` / `set`.

Tests will continue to run with the encrypted layer marked locked, so unit
tests are unaffected; only integration tests that need provider keys will
skip.
