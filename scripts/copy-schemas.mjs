import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "tools", "schemas");
const published = join(root, "schemas");
mkdirSync(published, { recursive: true });
for (const name of readdirSync(source)) {
  if (!name.endsWith(".schema.json")) continue;
  copyFileSync(join(source, name), join(published, name));
}
