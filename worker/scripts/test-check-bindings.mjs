// check-bindings — the preflight that stops a deploy into placeholder storage.
import { isPlaceholderId, bindingsForEnv, PLACEHOLDER_RE } from "./check-bindings.mjs";
import { readFileSync } from "node:fs";

let failures = 0;
const expect = (cond, label) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
};

console.log("\nplaceholder ids are recognised, real ids are not\n");

for (const id of [
  "00000000-0000-0000-0000-00000000stg1",
  "0000000000000000000000000000stg1",
  "00000000-0000-0000-0000-000000000000",
  "0000000000000000000000000000000000",
]) expect(isPlaceholderId(id), `placeholder: ${id}`);

for (const id of [
  "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  "0a1b2c3d4e5f60718293a4b5c6d7e8f9",   // starts with a zero, but is real
  "",
]) expect(!isPlaceholderId(id), `real or empty: ${id || "(empty)"}`);

console.log("\nbindings are read from the environment's own blocks\n");

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const prod = bindingsForEnv(toml, "production");
const staging = bindingsForEnv(toml, "staging");

expect(prod.length >= 3, `production declares ${prod.length} binding id(s)`);
expect(prod.every((b) => !isPlaceholderId(b.value)),
  "…and none of them is a placeholder — production is real");
expect(staging.length >= 3, `staging declares ${staging.length} binding id(s)`);
expect(staging.some((b) => isPlaceholderId(b.value)),
  "…and staging still carries placeholders, which is why the gate exists");
expect(staging.some((b) => b.binding === "SESSIONS") && staging.some((b) => b.binding === "DB"),
  "each id is attributed to the binding NAME it belongs to, not just a section");

// The parser must not bleed one environment's bindings into another's, or the
// gate would pass staging on production's ids.
expect(!prod.some((b) => staging.some((s) => s.value === b.value)),
  "production and staging share no id — the sections are read separately");

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all check-bindings tests passed\x1b[0m\n");
  process.exit(0);
}
console.log(`\x1b[31m  ${failures} check-bindings test(s) failed\x1b[0m\n`);
process.exit(1);
