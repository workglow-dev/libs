import { defineConfig } from "vite";

// A WebContainer is built on SharedArrayBuffer, which a page gets only when it
// is cross-origin isolated. The same two headers must reach whatever serves the
// built app, or the container will not boot.
const isolation = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig({
  resolve: { mainFields: ["browser", "import", "module", "main"] },
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: "esnext" },
});
