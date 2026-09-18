# Changelog

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

## 0.4.6

### Chores

- migrate from ESLint to oxlint; upgrade to TypeScript 7 (#884)

## 0.3.39

### Bug Fixes

#### test

- close the gaps the Turbo/projects wiring opened

### Refactors

#### job-queue

- collapse per-backend queue adapters onto wrapQueueStorage (#684)

### Chores

- upgrade to catalog for many deps and update the deps themselves
- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: catalog:

## 0.3.33

### Updated Dependencies

- `@cloudflare/workers-types`: ^5.20260801.1

## 0.3.31

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^5.20260731.1

## 0.3.29

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^5.20260730.1

## 0.3.27

### Chores

- update package.json scripts to include use-source and use-dist commands

### Updated Dependencies

- `@cloudflare/workers-types`: ^5.20260721.1

## 0.3.26

### Chores

#### deps

- update @cloudflare/workers-types to 5.x and tslog to 5.x

### Updated Dependencies

- `@cloudflare/workers-types`: ^5.20260715.1

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

## 0.3.22

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260702.1

## 0.3.20

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260624.1

## 0.3.17

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260621.1

## 0.3.16

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260619.1

## 0.3.15

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260612.1

## 0.3.12

### Chores

- update deps
- comment review pass across packages and providers
- update dependencies to latest versions

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260605.1

## 0.3.10

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260603.1

## 0.3.9

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260528.1

## 0.3.6

### Chores

- update deps, turn off preview libs for now

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260523.1

## 0.3.5

### Chores

- update @cloudflare/workers-types dependency to version 4.20260522.1 across multiple package.json files

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260522.1

## 0.3.2

### Bug Fixes

#### aws,cloudflare

- fall back when IJobStore omits markEnqueueDeferredMany
- retry JobStore writes in Claim.ack/fail to avoid stuck PROCESSING rows

#### cloudflare,aws

- validate delaySeconds in sendBatch before creating job rows
- clamp deferred re-delivery to original delaySeconds to avoid pulling delayed messages forward

#### job-queue,aws,cloudflare

- batch markEnqueueDeferred to avoid serial DB hits on batch failure

### Refactors

- remove pre-v1 backward-compat code paths (#523)

### Chores

- update deps

### Updated Dependencies

- `@cloudflare/workers-types`: ^4.20260521.1

## 0.3.0

### Features

#### cloudflare

- Cloudflare Queues message-queue adapter (@workglow/cloudflare)
