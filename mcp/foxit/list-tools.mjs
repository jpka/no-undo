import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "node_modules",
  "@foxitsoftware",
  "foxit-pdf-api-mcp-server",
  "dist",
  "main.js",
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, "--transport", "stdio"],
  env: {
    FOXIT_CLOUD_API_CLIENT_ID:
      process.env.FOXIT_CLOUD_API_CLIENT_ID ?? process.env.FOXIT_CLIENT_ID,
    FOXIT_CLOUD_API_CLIENT_SECRET:
      process.env.FOXIT_CLOUD_API_CLIENT_SECRET ?? process.env.FOXIT_CLIENT_SECRET,
    FOXIT_CLOUD_API_HOST: process.env.FOXIT_CLOUD_API_HOST,
  },
});

const client = new Client({ name: "no-undo-foxit-lister", version: "0.1.0" });
await client.connect(transport);
try {
  const tools = (await client.listTools()).tools;
  console.log(`total_tools=${tools.length}`);
  for (const t of tools) {
    const firstLine = (t.description ?? "").split("\n")[0];
    console.log(`${t.name}\t${firstLine}`);
  }
} finally {
  await client.close();
}