/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Standalone stdio MCP server for fleet (remote-server) tools.
 *
 * Spawned by the agent engine as a stdio MCP server; forwards every tool call
 * over a local 127.0.0.1 TCP socket to the main-process FleetMcpServer (which
 * holds the DB + decrypted SSH secrets). Configured via FLEET_MCP_PORT /
 * FLEET_MCP_TOKEN env vars.
 *
 * TCP protocol: 4-byte big-endian length header + UTF-8 JSON body.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendTcpRequest } from '../../team/mcp/tcpHelpers';

const FLEET_MCP_PORT = parseInt(process.env.FLEET_MCP_PORT || '0', 10);
const FLEET_MCP_TOKEN = process.env.FLEET_MCP_TOKEN || undefined;

if (!FLEET_MCP_PORT || !FLEET_MCP_TOKEN) {
  process.stderr.write('FLEET_MCP_PORT and FLEET_MCP_TOKEN environment variables are required\n');
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createFleetTool(server: McpServer, toolName: string, description: string, schema: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(toolName, description, schema, async (args: Record<string, unknown>) => {
    try {
      const response = await sendTcpRequest(FLEET_MCP_PORT, { tool: toolName, args, auth_token: FLEET_MCP_TOKEN });
      if (response.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: response.result || '' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  });
}

const server = new McpServer({ name: 'wayland-fleet', version: '1.0.0' }, { capabilities: { tools: {} } });

createFleetTool(
  server,
  'fleet_list_hosts',
  'List the managed server fleet: each host\'s name, ssh target, reachability status, and tags. Call this first to discover what you can operate on.',
  {}
);

createFleetTool(
  server,
  'fleet_run_command',
  `Run a shell command on one or more fleet hosts over SSH and return their output.

The "host" selector accepts a host name, an IP/hostname, a tag (runs on every host with that tag), or "*"/"all" for the whole fleet. Prefer the least-privileged command; treat destructive commands with care and confirm with the user first.`,
  {
    host: z.string().describe('Target: a host name, a tag, or "*"/"all" for every host'),
    command: z.string().describe('The shell command to run on the target host(s)'),
  }
);

createFleetTool(
  server,
  'fleet_health',
  'Probe every fleet host for reachability and report online/offline/error per host. Use this for a quick "is everything up?" check.',
  {}
);

createFleetTool(
  server,
  'fleet_reboot',
  'Reboot one or more fleet hosts (host name, tag, or "*"/"all"). Destructive — confirm with the user before rebooting production machines.',
  {
    host: z.string().describe('Target: a host name, a tag, or "*"/"all"'),
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Best-effort readiness ping so the main process can confirm the bridge is up.
  sendTcpRequest(FLEET_MCP_PORT, { type: 'mcp_ready', auth_token: FLEET_MCP_TOKEN }).catch(() => {
    /* the main process falls back to its own timeout */
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`[fleet-mcp-stdio] Fatal error: ${err}\n`);
  process.exit(1);
});
