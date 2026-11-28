const messages = {
  busy: 'An operation is already running. Wait for it to finish, then try again.',
  limit: 'The service returned more data than BB can display. Use a narrower Grain tool request.',
  cancelled: 'The connection changed or the request was cancelled. Try again.',
  timeout: 'The service did not respond in time. Try again for reads and verify any changes before retrying.',
  unconfigured: 'Connect this service in Photos settings first.',
  grain_auth: 'Grain rejected the credentials. Check the endpoint and access token.',
  grain_transport: 'BB could not complete a request to Grain. Check the endpoint and server. Verify any changes before retrying.',
  grain_protocol: 'Grain did not return a usable MCP tool catalog or result. Check the server configuration.',
  grain_tool: 'The Grain tool reported an error. Verify any changes before retrying.',
  grain_missing: 'This tool is unavailable on the configured Grain server. List the tools again.',
  grain_secrets: 'Grain returned a response that BB could not display safely.',
  storage: 'BB could not update the connection. Check the plugin logs and refresh the settings.',
} as const;

export type Category = keyof typeof messages;
export class PhotosError extends Error {
  readonly category: Category;

  constructor(category: Category) {
    super(messages[category]);
    this.category = category;
  }
}

export function failure(error: unknown, fallback: Category) {
  if (error instanceof PhotosError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') return new PhotosError('timeout');
  if (error instanceof DOMException && error.name === 'AbortError') return new PhotosError('cancelled');
  return new PhotosError(fallback);
}
