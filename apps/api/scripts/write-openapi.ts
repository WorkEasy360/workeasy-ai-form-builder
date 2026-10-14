import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/contract/openapi.js";

const target = fileURLToPath(new URL("../../../contracts/openapi.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${target}`);
