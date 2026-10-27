# Changelog

## 0.6.14

### Features

#### webcontainer

- list a huge directory's first entries without copying or sorting it
- lazySandboxPort and a coep option for bootWebContainer
- promote the sandbox core to the @workglow/webcontainer package

### Bug Fixes

#### webcontainer

- drain a background program's output before reporting its failure
- one watcher for both entries, validate listSandboxFiles' root
