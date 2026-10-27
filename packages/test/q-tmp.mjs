import { RE2JS } from "re2js";
for (const n of [16384, 32768, 65536]) {
  const p = RE2JS.compile("a[^z]*z|a");
  const m = p.matcher("a".repeat(n));
  const t = performance.now(); let c = 0; while (m.find()) c++;
  console.log(n, c, Math.round(performance.now() - t), "ms");
}
