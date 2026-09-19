# Changelog

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

- `@aws-sdk/client-sqs`: catalog:
- `aws-sdk-client-mock`: catalog:

## 0.3.33

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1101.0

## 0.3.31

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1100.0

## 0.3.29

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1098.0

## 0.3.27

### Chores

- update package.json scripts to include use-source and use-dist commands

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1092.0

## 0.3.26

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1088.0

## 0.3.24

### Features

- add updateWhere method for atomic conditional updates across all storage backends (#616)

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1084.0

## 0.3.23

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1084.0

## 0.3.22

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1079.0

## 0.3.20

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1075.0

## 0.3.19

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1074.0

## 0.3.16

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1073.0

## 0.3.15

### Build

- make timings easier to spot trouble

### Chores

- add homepage

## 0.3.14

### Features

- add bugs URL to package.json files across all packages and providers

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1068.0

## 0.3.12

### Chores

- update deps
- comment review pass across packages and providers
- update dependencies to latest versions

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1063.0

## 0.3.10

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1060.0

## 0.3.9

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1055.0

## 0.3.6

### Chores

- update deps, turn off preview libs for now

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1053.0

## 0.3.2

### Bug Fixes

#### aws,cloudflare

- fall back when IJobStore omits markEnqueueDeferredMany
- retry JobStore writes in Claim.ack/fail to avoid stuck PROCESSING rows

#### cloudflare,aws

- clamp deferred re-delivery to original delaySeconds to avoid pulling delayed messages forward

#### job-queue,aws,cloudflare

- batch markEnqueueDeferred to avoid serial DB hits on batch failure

### Refactors

- remove pre-v1 backward-compat code paths (#523)

### Chores

- update deps

### Updated Dependencies

- `@aws-sdk/client-sqs`: ^3.1052.0

## 0.3.0

### Features

#### aws

- SQS message-queue adapter (@workglow/aws)
