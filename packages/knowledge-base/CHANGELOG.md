# @workglow/knowledge-base

## 0.6.7

_No changes in this package._

## 0.6.6

_No changes in this package._

## 0.6.5

_No changes in this package._

## 0.6.4

_No changes in this package._

## 0.6.3

_No changes in this package._

## 0.6.2

_No changes in this package._

## 0.6.1

_No changes in this package._

## 0.6.0

_No changes in this package._

## 0.5.1

### Chores

- run format-check in CI, and turn on every staged-off lint rule

## 0.5.0

### Breaking Changes

- **features(storage)**: add join() to ITabularStorage with SQL pushdown (#893)

### Features

#### storage

- add join() to ITabularStorage with SQL pushdown (#893)

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

### Bug Fixes

#### knowledge-base

- stop re-expanding colspan the producer already placed

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

### Chores

#### eslint

- enforce consistent-type-imports and apply the repo-wide autofix (#683)

## 0.3.38

## 0.3.37

## 0.3.36

## 0.3.35

## 0.3.34

## 0.3.33

## 0.3.32

## 0.3.31

## 0.3.30

## 0.3.29

## 0.3.28

## 0.3.27

### Bug Fixes

#### knowledge-base

- route console.warn through structured logger

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.23

### Features

#### storage

- updateWhere on remaining backends and wrappers

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

### Refactors

- extract shared Postgres type mapping and vector storage logic (#586)

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

## 0.3.13

## 0.3.12

### Bug Fixes

#### knowledge-base

- close obfuscated-scheme bypass in escapeLinkDestination
- escape backslashes in escapeInlineText (CodeQL #136)
- escape attacker-controlled fields in renderMarkdown

### Refactors

- rework delete events

### Chores

- comment review pass across packages and providers

## 0.3.11

### Features

#### knowledge-base

- add table/list/image document node kinds, renderMarkdown (#547)

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

## 0.2.37

### Features

- Add pluggable disposal strategies to ResourceScope (#509)

## 0.2.36

### Features

#### kb

- pluggable strategy with model config, IRunConfig threading, and document tasks

## 0.2.35

### Features

#### knowledge-base

- hybrid search via RRF over BM25F text index (#478)

#### ai

- enhance AiChatWithKbTask and HierarchicalChunkerTask with section handling and slugification

### Bug Fixes

#### knowledge-base,storage,postgres

- cross-KB getBulk leak + restore Postgres-native hybrid search (#486)

### Performance

#### build

- optimize turbo task graph and add TS project references (#489)

### Documentation

- add design for storage getBulk plural-get (#480)

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

### Features

#### ai

- enhance AiChatWithKbTask and HierarchicalChunkerTask with section handling and slugification

### Chores

- fixup some wrong links after rename

## 0.2.32

### Bug Fixes

#### storage

- address Copilot review feedback on cursor pagination + transactions
- wrapper tx-handle forwarding + real-pool mutex bypass
- CI build + Copilot review feedback

#### knowledge-base

- reject cursors minted by a different KB scope

### Refactors

- finish renaming stuff for ai-provider now that ai-provider is in ai
- move packages with big third party libraries from packages to providers

#### storage

- restore real putBulk + add withTransaction

### Tests

#### contract

- implement worker-proxy contract conformance suite (#468)

### Chores

#### storage

- pre-merge polish from final review (easy minors)

### CI

- retrigger build
- retrigger after transient @sqlite.org/sqlite-wasm resolution failure

## 0.2.31

### Refactors

- introduce bootstrapWorkglow and createOrchestrationContext (#460)

## 0.2.30

## 0.2.29

## 0.2.28

## 0.2.27

## 0.2.26

### Features

#### storage

- IndexedDbTabularStorage.queryIndex via openKeyCursor

## 0.2.25

## 0.2.24

### Features

#### storage

- implement count method across storage backends

## 0.2.23

## 0.2.22

## 0.2.21

## 0.2.20

## 0.2.19

## 0.2.18

## 0.2.17

## 0.2.16

### Refactors

#### ai

- simplify and consolidate RAG tasks (#427)

### Chores

- release 12 packages

## 0.2.15

## 0.2.14

## 0.2.13

## 0.2.12

## 0.2.11

## 0.2.10

### Refactors

#### kb

- update KnowledgeBase constructor to accept options object

## 0.2.9

### Features

#### kb

- stable public API for vector search and lifecycle hooks

## 0.2.8

## 0.2.7

### Features

#### ai

- add KbToDocumentsTask and relax vector dimension check

## 0.2.6

### Refactors

- reorganize imports and clean up unused code across multiple… (#410)

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

### Features

- add lifecycle management across core infrastructure (#384)
- add pkg-pr-new for preview package publishing (#379)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### knowledge-base

- serialize concurrent registry operations per ID (#383)

#### tests

- update ScopedStorage tests for type safety

### Chores

- release 12 packages

## 0.1.3

### Features

- add lifecycle management across core infrastructure (#384)
- add pkg-pr-new for preview package publishing (#379)

#### knowledge-base

- implement shared-table mode for knowledge bases

#### ai

- ToolCallingTask and AgentTask

### Bug Fixes

#### di

- add reentrancy guard and atomic registerIfAbsent to Container (#387)

#### knowledge-base

- serialize concurrent registry operations per ID (#383)

#### tests

- update ScopedStorage tests for type safety

## 0.1.2

### Features

- implement input compactors for various registries

## 0.1.1

## 0.1.0

### Bug Fixes

#### ai,ai-provider

- improve security, robustness, and DX across AI packages (#340)

#### storage,knowledge-base

- security hardening, bug fixes, and robustness improvements (#341)

### Chores

- remove unnecessary comments that restate code or reference commits

## 0.0.126

### Features

- update TypeScript configurations and package exports for improved module resolution

#### storage

- move @workglow/sqlite package into @workglow/storage/sqlite and add @workglow/storage/postgresql

## 0.0.125

## 0.0.124

## 0.0.123

### Refactors

#### imports

- update imports to utilize @workglow/util/schema

## 0.0.122

### Features

#### schema

- introduce @workglow/schema package for schema validation utilities

### Refactors

- update package exports to use source files instead of dist

### Build

- no real point to splitting in the libs

### Chores

- add @typescript/native-preview package and make updates for tsgo

## 0.0.121

## 0.0.120

## 0.0.119

### Features

- add chrome web browser provider (#303)

### Refactors

- update KnowledgeBaseRepository to use ITabularStorage type

### Chores

- release 14 packages
- update tsconfig to avoid node_modules

## 0.0.118

### Features

- add chrome web browser provider (#303)

### Chores

- update tsconfig to avoid node_modules

## 0.0.117

### Chores

- update tsconfig to avoid node_modules

## 0.0.116

### Features

- add SqliteAiVectorStorage using @sqliteai/sqlite-vector extension (#291)

### Refactors

- clean up code formatting and imports across multiple files
- remove baseUrl from tsconfig and update exports in common-server.ts

## 0.0.115

## 0.0.114

## 0.0.113

## 0.0.112

## 0.0.110

### Features

- add build-js and watch-js scripts across packages

## 0.0.109

## 0.0.108

## 0.0.107

## 0.0.106

## 0.0.105

### Patch Changes

- Storage rename search to query
- Updated dependencies
  - @workglow/storage@0.0.105
  - @workglow/util@0.0.105

## 0.0.104

### Patch Changes

- Add credential storage and resolution handling
- Updated dependencies
  - @workglow/storage@0.0.104
  - @workglow/util@0.0.104

## 0.0.103

### Patch Changes

- Structured Outputs, Task timeouts, Error output ports, Fallback Task, Logger, IndexedDbVectorStorage, misc fixes
- Updated dependencies
  - @workglow/storage@0.0.103
  - @workglow/util@0.0.103

## 0.0.102

### Patch Changes

- Update types
- Updated dependencies
  - @workglow/storage@0.0.102
  - @workglow/util@0.0.102

## 0.0.101

### Patch Changes

- Promote task config to first class schema, remove old name prop in favor of title
- Updated dependencies
  - @workglow/storage@0.0.101
  - @workglow/util@0.0.101

## 0.0.100

### Patch Changes

- add count token task and fix streaming issues
- Updated dependencies
  - @workglow/storage@0.0.100
  - @workglow/util@0.0.100

## 0.0.99

### Patch Changes

- Update deps like hf inference
- Updated dependencies
  - @workglow/storage@0.0.99
  - @workglow/util@0.0.99

## 0.0.98

### Patch Changes

- Update storage for bulk paged reading, add hf dataset storage, add hf inference
- Updated dependencies
  - @workglow/storage@0.0.98
  - @workglow/util@0.0.98

## 0.0.97

### Patch Changes

- client mcp support via tasks
- Updated dependencies
  - @workglow/storage@0.0.97
  - @workglow/util@0.0.97

## 0.0.96

### Patch Changes

- fix missing include dep
- Updated dependencies
  - @workglow/storage@0.0.96
  - @workglow/util@0.0.96

## 0.0.95

### Patch Changes

- fix max tokens and update cli
- Updated dependencies
  - @workglow/storage@0.0.95
  - @workglow/util@0.0.95

## 0.0.94

### Patch Changes

- update to streaming port across grouped type tasks
- Updated dependencies
  - @workglow/storage@0.0.94
  - @workglow/util@0.0.94

## 0.0.93

### Patch Changes

- fix export and test
- Updated dependencies
  - @workglow/storage@0.0.93
  - @workglow/util@0.0.93

## 0.0.92

### Patch Changes

- Fix exports
- Updated dependencies
  - @workglow/storage@0.0.92
  - @workglow/util@0.0.92

## 0.0.91

### Patch Changes

- Add ai providers like openai; add streaming
- Updated dependencies
  - @workglow/util@0.0.91
  - @workglow/storage@0.0.91

## 0.0.90

### Patch Changes

- Introduce Loop tasks: Map, Reduce, and While
- Updated dependencies
  - @workglow/util@0.0.90
  - @workglow/storage@0.0.90

## 0.0.89

### Patch Changes

- Fix subgraph reactive
- Updated dependencies
  - @workglow/storage@0.0.89
  - @workglow/util@0.0.89

## 0.0.88

### Patch Changes

- Revert adding loop tasks, push other fixes
- Updated dependencies
  - @workglow/storage@0.0.88
  - @workglow/util@0.0.88

## 0.0.87

### Patch Changes

- bad version with loop not ready for prime time
- Updated dependencies
  - @workglow/storage@0.0.87
  - @workglow/util@0.0.87

## 0.0.86

### Patch Changes

- Add concept of Datasets, rename all storage class in storage to end in storage, added some RAG tasks
- Updated dependencies
  - @workglow/storage@0.0.86
  - @workglow/util@0.0.86
