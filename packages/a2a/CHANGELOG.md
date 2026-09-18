# Changelog

## 0.6.6

_No changes in this package._

## 0.6.5

_No changes in this package._

## 0.6.4

_No changes in this package._

## 0.6.3

### Bug Fixes

#### a2a

- declare A2AAgentTask's network reach, and stop a peer binding undeclared ports

## 0.6.2

_No changes in this package._

## 0.6.1

### Features

- serve one agent over A2A, loopback and authenticated by default
- run an AgentTask behind the A2A executor, opaquely
- call a remote A2A agent as a task
- describe a servable agent, and derive a card that states its auth
- bind A2A parts to named ports, and refuse to guess
- add the @workglow/a2a workspace

### Bug Fixes

#### a2a

- keep a peer inside its declared ports, end a turn exactly once, and remember the context
- mark the client task's execute as an override, and lock the CLI dependency

### Documentation

- keep the A2A package's notes in its own README, not CLAUDE.md

#### a2a

- describe the package, and log a failed turn where the operator can read it

### Chores

#### a2a

- version the workspace in lockstep with the root
