export function resultFor(result) {
  return {
    content: [
      ...(result.content || []).map(({ _meta, ...part }) => part.type === 'text' ? { type: 'text', text: part.text }
        : part.type === 'image' ? { type: 'image', data: part.data, mimeType: part.mimeType }
        : { type: 'text', text: JSON.stringify(part) }),
      ...(result.structuredContent === undefined ? [] : [{ type: 'text', text: JSON.stringify(result.structuredContent) }]),
    ],
    isError: result.isError,
  };
}
