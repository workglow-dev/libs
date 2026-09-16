# Changelog

## 0.6.3

_No changes in this package._

## 0.6.2

_No changes in this package._

## 0.6.1

### Refactors

- share the HTTP server guards out of the MCP server

#### util,mcp

- share the JSON-RPC HTTP scaffolding, not just its predicates

## 0.6.0

### Breaking Changes

- **bug fixes(mcp)**: require the auth choice startMcpHttpServer serves under (#933)

### Bug Fixes

#### mcp

- require the auth choice startMcpHttpServer serves under (#933)

## 0.5.1

### Features

- chat agent utilities (#929)

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

- route human-in-the-loop tasks to the MCP client
- serve registered tasks over MCP, behind a bearer token

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

### Bug Fixes

- keep server-side failure detail off the wire
- make the bearer and tool-name parsers linear
- close the gaps a review of the MCP server turned up

### Chores

- revert version change not made by bunset

## 0.4.9

## 0.4.8

## 0.4.7

### Chores

- migrate from Prettier to oxfmt for code formatting

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

## 0.4.4

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.49

## 0.3.48

## 0.3.47

## 0.3.46

## 0.3.45

## 0.3.44

## 0.3.43

## 0.3.42

## 0.3.41

## 0.3.40

## 0.3.39

### Bug Fixes

#### test

- close the gaps the Turbo/projects wiring opened

### Tests

- run tests through Turbo and per-package vitest projects
- settle the Bun policy, close a CI gap, and pilot the __tests__ move

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

## 0.3.37

## 0.3.36

## 0.3.35

## 0.3.34

## 0.3.33

### Documentation

- fix workflow.add( -> workflow.addTask( in provider READMEs

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

## 0.3.28

## 0.3.27

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.23

### Chores

- format / lint

## 0.3.22

## 0.3.21

## 0.3.20

## 0.3.19

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

### Bug Fixes

- eslint fixes

#### mcp,supabase

- credential-leak fail-closed + vector dim validation (2 HIGH from code review) (#579)

### Refactors

- extract shared Postgres type mapping and vector storage logic (#586)

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

### Bug Fixes

#### mcp

- thread run-scoped registry through discoverSchemas (#577)
- resolve auth credentials through the run-scoped registry

## 0.3.13

## 0.3.12

### Chores

- comment review pass across packages and providers

## 0.3.11

## 0.3.10

## 0.3.9

## 0.3.8

## 0.3.7

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

### Features

- migrate tasks and example to cachePolicy + deprecate legacy cacheable

### Chores

- format

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

## 0.2.36

### Bug Fixes

- mcp

## 0.2.35

### Chores

- release 30 packages
- release 30 packages
- fixup some wrong links after rename

#### format

- organize-imports plugin + husky pre-commit hook (#488)

### CI

- empty commit to retrigger main Build & Test

## 0.2.34

## 0.2.33

### Chores

- fixup some wrong links after rename

## 0.2.32

### Features

#### test

- IHumanConnector contract conformance suite (#471)

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers

### Documentation

- add README files for new packages

### Chores

- format

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

### Chores

- update peer deps

## 0.2.29

## 0.2.28

### Bug Fixes

#### mcp

- tasks → util cross-subpath imports use package self-name

### Refactors

#### tasks

- strip MCP and browser-control auto-registration from runtime entries

#### mcp

- move MCP tasks and util from @workglow/tasks to @workglow/mcp

### Chores

- code-review fixes (round 2)
- code-review cleanup
