import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [toolName, argsJson] = process.argv.slice(2);
if (!toolName) {
  console.error("usage: node call-tool.mjs <toolName> [argsJson]");
  process.exitCode = 1;
} else {
  const args = argsJson ? JSON.parse(argsJson) : {};

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

  const client = new Client({ name: "no-undo-foxit-call", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    const t = tools.find((x) => x.name === toolName);
    if (!t) {
      console.error(`tool not found: ${toolName}`);
      process.exitCode = 1;
    } else {
      console.log(`inputSchema: ${JSON.stringify(t.inputSchema, null, 2)}`);
      const result = await client.callTool({ name: toolName, arguments: args });
      console.log(`resultIsError=${result.isError}`);
      for (const c of result.content ?? []) {
        console.log(`${c.type}: ${String(c.text).slice(0, 2000)}`);
      }
    }
  } finally {
    await client.close();
  }
}