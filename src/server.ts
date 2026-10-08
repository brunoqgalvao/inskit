// MCP server that Codex starts for each chat. Thin: forwards every tool call to the shared daemon.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { DaemonClient } from './client.ts';
import { BRAND, VERSION } from './brand.ts';
import { TOOLS, type ToolResult } from './tools.ts';

const cfg = loadConfig();
const client = new DaemonClient(cfg);
const session = randomUUID();

const INSTRUCTIONS = `${BRAND} gives you a Browser Use Cloud or local browser (check agent_status), with reusable website logins, a vault for cards, passwords and ID documents that you never see, and a purchase gate.
Use these browser_* tools for any task on the web that needs the user's accounts, forms, checkout or downloads. Never ask for passwords, card numbers, CVV or ID numbers in chat: use vault_request. Never pay without purchase_propose and the user's approval. Read the "inskit" skill for the full playbook.`;

const server = new McpServer({ name: 'inskit', title: BRAND, version: VERSION }, { instructions: INSTRUCTIONS });

// Diagnostics: which clients connect and whether they can show native approval prompts.
server.server.oninitialized = () => {
  try {
    mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
    const caps = server.server.getClientCapabilities() as any;
    appendFileSync(join(cfg.home, 'clients.log'), JSON.stringify({ at: new Date().toISOString(), client: server.server.getClientVersion(), elicitation: caps?.elicitation ?? null }) + '\n');
  } catch {}
};

function supportsElicitation() {
  if (process.env.INSTINCT_NATIVE_APPROVAL === '0') return false;
  return !!(server.server.getClientCapabilities() as any)?.elicitation;
}

/**
 * Native approval prompt inside Codex. true/false only for an explicit answer in the form;
 * undefined (decline, cancel, no UI, error) falls back to the approval page. Non-interactive
 * Codex runs auto-decline elicitations, so a decline is not proof the user said no.
 */
async function askApproval(orderId: string, summary: string): Promise<boolean | undefined> {
  try {
    const answer = await server.server.elicitInput({
      message: `Approve this purchase?\n\n${summary}\n\nNothing is charged unless you approve.`,
      requestedSchema: {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Buy it', description: 'Place this exact order' } },
        required: ['approve'],
      },
    } as any);
    if (answer.action === 'accept' && typeof (answer.content as any)?.approve === 'boolean') return (answer.content as any).approve;
    return undefined;
  } catch {
    return undefined;
  }
}

for (const tool of TOOLS) {
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input,
    annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: !!tool.destructive, openWorldHint: true },
  }, async (args: any): Promise<any> => {
    try {
      const timeoutMs = tool.waits ? ((args?.timeout_seconds ?? 180) + 30) * 1000 : 150_000;
      if (tool.name === 'purchase_propose' && supportsElicitation()) {
        const proposed = await client.call(session, tool.name, args, { nativeApproval: true });
        const orderId = proposed.structuredContent?.orderId as string | undefined;
        if (proposed.isError || !orderId) return proposed;
        const approved = await askApproval(orderId, String(proposed.structuredContent?.summary ?? ''));
        if (approved === undefined) {
          const next = await client.call(session, '__open_approval', { order_id: orderId });
          return withText(proposed, text(next));
        }
        await client.call(session, '__decide', { order_id: orderId, approve: approved, via: 'Codex approval prompt' });
        return withText(proposed, approved
          ? 'The user approved in Codex. Fill payment if needed, check the total is unchanged, then purchase_submit.'
          : 'The user declined. Do not buy. Ask what they want instead.');
      }
      return await client.call(session, tool.name, args, { timeoutMs });
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
}

function text(result: ToolResult) {
  return result.content.filter(c => c.type === 'text').map(c => (c as any).text).join('\n');
}

function withText(result: ToolResult, extra: string): ToolResult {
  return { ...result, content: [...result.content, { type: 'text', text: extra }] };
}

await server.connect(new StdioServerTransport());
