#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();

// stdout carries the protocol, so diagnostics go to stderr.
server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error("catalog-mcp failed to start:", error);
  process.exit(1);
});
