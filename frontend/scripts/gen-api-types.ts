import openapiTS, { astToString } from "openapi-typescript";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const yaml = resolve(__dirname, "../../backend/openapi.yaml");
const out = resolve(__dirname, "../src/api/generated.ts");

const ast = await openapiTS(new URL(`file://${yaml}`));
writeFileSync(
  out,
  "// AUTO-GENERATED — do not edit. Run `pnpm types:gen`.\n" + astToString(ast),
);
console.log("Wrote", out);
