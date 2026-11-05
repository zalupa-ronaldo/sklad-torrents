import { register } from "node:module";

// Lets the PC agent run TypeScript with Node's type stripper and extensionless imports.
register(new URL("./loader.mjs", import.meta.url), import.meta.url);
