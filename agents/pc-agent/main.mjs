import { startWindowsAgent } from "./server.mjs";

const port = Number(process.env.PC_AGENT_PORT || 3921);
const host = process.env.PC_AGENT_HOST || "0.0.0.0";
const mock = process.env.PC_AGENT_MOCK !== "0";
const dataDir = process.env.PC_AGENT_DATA_DIR || null;

const started = await startWindowsAgent({ port, host, mock, dataDir });
console.log(
  `pc-agent ${started.url} host=pc-agent mock=${started.mock} physicalDiscBurned=false`,
);
