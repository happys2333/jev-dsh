/**
 * The MCP surface: tool advertisement and call dispatch, with the one distinction the protocol
 * requires and implementations most often get wrong — a malformed request is a JSON-RPC error,
 * while a well-formed request whose judgement failed is a tool result carrying `isError`.
 *
 * @module
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { MCP_TOOL_NAMES, TOOL_DESCRIPTIONS, TOOL_INPUT_SCHEMAS, TOOL_OUTPUT_SCHEMAS, type McpToolName } from './schema.ts'
import { runTool, type McpRuntime } from './tools.ts'

function isToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name)
}

export function createJeyServer(runtime: McpRuntime): Server {
  const server = new Server(
    { name: 'jey', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Jey answers judgement questions about work you describe. It never executes '
        + 'anything, never changes your policy or your credentials, and labels a synthetic or '
        + 'declined answer instead of presenting it as a verdict.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_NAMES.map(name => ({
      name,
      title: name,
      description: TOOL_DESCRIPTIONS[name],
      // The same objects the handler validates against, published verbatim.
      inputSchema: TOOL_INPUT_SCHEMAS[name] as Tool['inputSchema'],
      outputSchema: TOOL_OUTPUT_SCHEMAS[name] as Tool['outputSchema'],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name
    if (!isToolName(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${JSON.stringify(name)}`)
    }
    const outcome = await runTool(runtime, name, request.params.arguments ?? {}, extra.signal)
    if (outcome.kind === 'protocol') {
      throw new McpError(ErrorCode.InvalidParams, outcome.message)
    }
    if (outcome.kind === 'tool') {
      // No structuredContent here: the output schema describes an answer, and a failed
      // judgement is not one. The text is still JSON so either channel reads the same.
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({ error: { code: outcome.code, retryable: outcome.retryable, message: outcome.message } }),
        }],
      }
    }
    return {
      content: [{ type: 'text', text: outcome.text }],
      structuredContent: outcome.structured,
    }
  })

  return server
}
