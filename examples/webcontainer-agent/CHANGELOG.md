# Changelog

## 0.6.14

### Features

#### webcontainer

- promote the sandbox core to the @workglow/webcontainer package

#### examples

- add webcontainer-agent, an AgentTask coding agent sandboxed in a WebContainer

### Bug Fixes

#### webcontainer-agent

- stop_servers also stops background starts still in flight
- serialize background server startups
- exact truncation flag, race-free server slots, tolerant tree refresh
- bound the page's file-tree walk like list_files
- report previews from shared tools, honour cancel during spawn
- keep preview servers alive across follow-up turns

### Chores

- update deps

#### webcontainer

- record the typecheck budget, drop the example's test script
