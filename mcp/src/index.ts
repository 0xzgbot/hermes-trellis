#!/usr/bin/env node
/**
 * index.ts — the Trellis MCP server (stdio transport).
 *
 * Instantiate an McpServer, register every Trellis tool from
 * tools.ts against a shared bridge client, and connect over
 * stdio. The client points at the local Trellis service on the
 * GPU machine via TRELLIS_API_URL (default http://127.0.0.1:8188).
 *
 * Register in ~/.hermes/config.yaml:
 *   mcp_servers:
 *     trellis:
 *       command: node
 *       args: ["/absolute/path/to/hermes-trellis/mcp/dist/index.js"]
 *       env:
 *         TRELLIS_API_URL: "http://<DGX-TAILNET-IP>:8188"
 *         TRELLIS_PYTHON: "python3"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TrellisBridgeClient } from "./bridge.js";
import {
  makeHealthTool,
  makeStartTool,
  makeImageTo3DTool,
  makeTaskStatusTool,
  makeWaitTool,
  makeDownloadTool,
  makeRenderTool,
  makeTexturizeTool,
  makeRemeshTool,
  makeGalleryTool,
  makeUsageTool,
  makeSlicerTool,
  type ToolContext,
  type ToolExtra,
} from "./tools.js";

function outDirFromEnv(): string {
  return process.env.TRELLIS_OUT_DIR || `${process.cwd()}/trellis-out`;
}

async function main(): Promise<void> {
  const defaultOutDir = outDirFromEnv();
  const client = new TrellisBridgeClient({
    baseUrl: process.env.TRELLIS_API_URL,
    log: () => {
      /* keep stdio clean for JSON-RPC; drop logs to stderr only if debugging */
    },
  });
  const ctx: ToolContext = { client, defaultOutDir };

  const server = new McpServer({
    name: "trellis-mcp",
    version: "0.2.0",
  });

  // Each make*Tool returns { name, desc, schema, handler }. Register with the SDK.
  for (const tool of [
    makeHealthTool(ctx),
    makeStartTool(ctx),
    makeImageTo3DTool(ctx),
    makeTaskStatusTool(ctx),
    makeWaitTool(ctx),
    makeDownloadTool(ctx),
    makeRenderTool(ctx),
    makeTexturizeTool(ctx),
    makeRemeshTool(ctx),
    makeGalleryTool(ctx),
    makeUsageTool(ctx),
    makeSlicerTool(ctx),
  ]) {
    server.registerTool(
      tool.name,
      {
        description: tool.desc,
        inputSchema: tool.schema,
      },
      async (args: Record<string, unknown> | undefined, extra: ToolExtra) =>
        tool.handler((args ?? {}) as Record<string, unknown>, extra),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is the JSON-RPC channel).
  // eslint-disable-next-line no-console
  console.error(`[trellis-mcp] connected. bridge=${client.base} out=${defaultOutDir}`);
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[trellis-mcp] fatal:", e);
  process.exit(1);
});
