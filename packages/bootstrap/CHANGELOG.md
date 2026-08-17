# @workglow/bootstrap

## 0.3.45

### Features

#### bootstrap

- Initial release. `registerAllDefaults`, `bootstrapWorkglow`, and
  `createOrchestrationContext` moved here from the `workglow` meta-package and
  from the test harness's private `bootstrapTestRegistry`, which had drifted
  into two copies of the same 14 registration calls.
- `registerAllDefaults(registry)` takes a **required** registry. It mutates
  whichever container it is handed, so the target is always stated at the call
  site rather than defaulting to the global one.
- The vitest harness now installs the `image` input resolver on the MAIN
  global registry. The removed `bootstrapTestRegistry` called each registrar
  with no argument, so `registerImageDefaults()` defaulted to the
  `@workglow/util/media` bundle's own `globalServiceRegistry` — a separate
  module instance under dist resolution — and the map `resolveSchemaInputs`
  reads never received it. Consequence: a `format: "image"` port fed a plain
  string id now throws `resolver received an unsupported string` instead of
  passing the string through. Object-valued image ports are unaffected.
