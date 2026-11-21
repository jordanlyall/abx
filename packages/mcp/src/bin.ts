#!/usr/bin/env node
/**
 * abx-mcp: the ABX MCP server over stdio. stdout carries the MCP protocol, so nothing else may
 * write to it; diagnostics go to stderr and never include environment values.
 */
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createServer} from './server.js';

const server = createServer();
await server.connect(new StdioServerTransport());

const shutdown = () => {
  void server.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
