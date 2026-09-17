# Changelog

## 0.6.4

_No changes in this package._

## 0.6.3

### Bug Fixes

- update stripAnsi function to handle control characters and enhance date parsing in publishedDate module

## 0.6.2

_No changes in this package._

## 0.6.1

### Tests

#### web-search

- hold all seven providers to the capability record they publish

## 0.6.0

### Bug Fixes

#### web-search

- reduce domain entries on every route, not just site: (#931)

## 0.5.1

_No changes in this package._

## 0.5.0

### Features

#### web-search

- add OpenAI, OpenRouter and Gemini grounded providers
- add runtime entries, registration and README
- add SearXNG provider with a keyless live test
- add Tavily provider with native filters and answers
- add Brave provider over an owned FetchUrlTask
- add WebSearchTask with pinned and routed provider selection
- add provider registry with capability routing
- translate domain filters to site: operators
- add provider interface and capability check

### Bug Fixes

#### web-search

- refuse a domain entry that names no domain
- address code review across the package and its adapters
- honour or refuse a named credential, stop registering providers on import, and keep two ports honest
- name a credential for a provider, fill Brave's open date bound, and thread abort
- let a provider declare that it takes one domain list, not both
- make maxResults mean the same thing for every provider
- resolve the search credential once, in the task that sends it
- make the instance entitlements reachable and fail closed
- keep test declarations out of the published tarball
- correct rate-limiter claim and gate the grounded answer
- remove quadratic backtracking from trailing-slash trim

### Documentation

- document @workglow/web-search in CLAUDE.md

### Chores

#### web-search

- bring the new package up to the workspace conventions

## 0.4.9

### Features

- initial release: `WebSearchTask` with a pluggable provider registry
