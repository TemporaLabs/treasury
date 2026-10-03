import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Both src/ and dist/ sit one level below package.json.
const PACKAGE_JSON_URL = new URL("../package.json", pathToFileURL(realpathSync(fileURLToPath(import.meta.url))));
export const PACKAGE_VERSION: string = JSON.parse(readFileSync(fileURLToPath(PACKAGE_JSON_URL), "utf8")).version;
