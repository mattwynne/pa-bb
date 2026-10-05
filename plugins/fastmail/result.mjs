// BB accepts text and image only. Keep supported parts intact; render other
// MCP parts and structured content as text without exposing protocol metadata.
export function resultFor(result) {
  const visible = ({ _meta, ...part }) => part;
  return {
    content: [
      ...result.content.map(part => part.type === 'text' ? { type: 'text', text: part.text }
        : part.type === 'image' ? { type: 'image', data: part.data, mimeType: part.mimeType }
        : { type: 'text', text: JSON.stringify(visible(part)) }),
      ...(result.structuredContent === undefined ? [] : [{ type: 'text', text: `Fastmail structuredContent: ${JSON.stringify(result.structuredContent)}` }]),
    ],
    isError: result.isError,
  };
}
