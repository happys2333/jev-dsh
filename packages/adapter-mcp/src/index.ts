/**
 * The MCP adapter's public surface. Two boundaries are worth stating here rather than
 * assuming: this package may import `jev-core`, the provider packages and the MCP SDK, and
 * it may not import DSH or Cordis — an MCP client is not a DSH agent, and pretending
 * otherwise would let the same config be interpreted two different ways. `index.test.ts`
 * enforces both directions.
 *
 * @module
 */
export { createJeyServer, createJevServer } from './server.ts'
export { runTool, type McpRuntime, type ToolOutcome } from './tools.ts'
export { MCP_HOST_CAPABILITIES, log, runtimeFrom, serve } from './main.ts'
export { providerFor, resolveCredential } from './provider.ts'
export {
  LEGACY_TOOL_NAMES, MCP_TOOL_NAMES, TOOL_DESCRIPTIONS, TOOL_INPUT_SCHEMAS, TOOL_OUTPUT_SCHEMAS,
  DEFAULT_RANK_LEVELS, type McpToolName,
} from './schema.ts'
export { inputErrors } from './tools.ts'
