# Changelog

## 0.6.8

### Bug Fixes

#### providers

- stop four run-fns accumulating on finish, and keep v3's reasoning off the text port

## 0.6.7

### Features

- add support for Needle v3 model in Cactus

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

_No changes in this package._

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

### Features

#### pricing

- enhance model pricing structure and update cost estimation logic

## 0.4.7

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.4.5

## 0.4.4

## 0.4.3

## 0.4.2

## 0.4.1

### Bug Fixes

- restore cactus build with legacy catalog typing
- address PR review feedback for cactus v2 paths

### Refactors

- enhance Cactus model loading and tool calling functionality

### Chores

- fix tests

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

#### ai

- require explicit ModelPricing rates and make the type assertion enforceable

### Tests

- discover test files instead of enumerating sections

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

## 0.3.26

## 0.3.25

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.23

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

### Chores

- comment review pass across packages and providers

## 0.3.11

## 0.3.10

## 0.3.9

## 0.3.8

### Features

- add provider runtime metadata: supportsServer and isAvailable() (#538)

## 0.3.7

## 0.3.6

### Features

#### cactus

- SHA-256 integrity verification for fetched model assets (#530)

### Bug Fixes

#### cactus,chrome-ai

- security and correctness fixes from review (#531)

### Refactors

#### cli

- replace execSync with spawnSync for editor command execution and add command parsing functionality

## 0.3.5

### Features

#### cactus

- enhance Cactus_ModelInfo to report cache status and file sizes

### Bug Fixes

- Chrome-ai (#514)

## 0.3.4

### Features

#### cactus

- add browser-specific AI provider classes and registration functions

## 0.3.3

### Refactors

- update cactus AI runtime exports and consolidate entry points

## 0.3.2

### Features

- add Cactus (needle-rs) local tool-calling provider (#524)
