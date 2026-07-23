/**
 * The one tool-result envelope every fsbrain MCP tool uses: a handler's return
 * value is serialized as pretty JSON, and a thrown error becomes a readable
 * `isError` result instead of a crash. Shared so the envelope cannot drift
 * between the core vault tools and optional integrations.
 */
export function wrapToolHandler<Args>(handler: (args: Args) => Promise<unknown>) {
  return async (args: Args) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
    }
  };
}
