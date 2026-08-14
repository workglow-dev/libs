# Changelog

## 0.3.39

### Features

#### bootstrap

- Initial release. `registerAllDefaults`, `bootstrapWorkglow`, and
  `createOrchestrationContext` moved here from the `workglow` meta-package and
  from the test harness's private `bootstrapTestRegistry`, which had drifted
  into two copies of the same 14 registration calls.
- `registerAllDefaults(registry)` takes a **required** registry. It mutates
  whichever container it is handed, so the target is always stated at the call
  site rather than defaulting to the global one.
