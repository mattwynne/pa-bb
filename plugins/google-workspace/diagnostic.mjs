const kinds = ['account_missing', 'configuration', 'authorization', 'authorization_transport', 'oauth_state', 'scope_required', 'identity',
  'runtime_missing', 'runtime_exit', 'runtime_timeout', 'provider_error', 'schema_unsupported', 'tool_unavailable'];
export function category(error) {
  if (kinds.includes(error?.workspaceCategory)) return error.workspaceCategory;
  if (error?.status === 401 || error?.status === 403) return 'authorization';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'cancelled_or_timeout';
  return 'unavailable';
}
export function fail(workspaceCategory) { throw Object.assign(new Error('Google Workspace unavailable'), { workspaceCategory }); }
export function message(error) {
  switch (category(error)) {
    case 'account_missing': return 'This Workspace account is unavailable. Check connected accounts in Settings.';
    case 'tool_unavailable': return 'This Workspace tool is unavailable. Refresh tools in Workspace settings or start a fresh agent session.';
    case 'configuration': return 'Check the Web OAuth client settings and HTTPS BB address. Existing accounts may need their original client settings restored.';
    case 'authorization': case 'identity': return 'Google authorization is unavailable. Reconnect the selected account in Workspace settings.';
    case 'scope_required': return 'Google did not grant all required Workspace permissions. Reconnect and approve the requested services.';
    case 'oauth_state': return 'Google authorization was cancelled, expired or already used. Start again in Workspace settings.';
    case 'runtime_missing': return 'Workspace MCP could not start. Install uv on the BB server and make uvx available to the BB service.';
    case 'runtime_timeout': return 'Workspace MCP did not become ready. First startup downloads its pinned runtime; check server network access and choose Refresh.';
    default: return 'Google Workspace could not complete the call. Check the connection and current Google state before retrying a write.';
  }
}
