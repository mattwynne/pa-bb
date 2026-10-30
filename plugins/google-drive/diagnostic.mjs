// Only local, bounded categories cross into BB logs. Never serialize an exception:
// its message, cause and response body may contain account data or OAuth secrets.
export function failureCategory(error) {
  if (error?.code === 'docs_read_incomplete') return 'docs_read_incomplete';
  if (error?.code === 'docs_cursor_expired') return 'docs_cursor_expired';
  if (error?.code === 'docs_read_capacity') return 'docs_read_capacity';
  if (error?.code === 'response_too_large') return 'response_too_large';
  if (error?.code === 'invalid_grant' || error?.code === 'reauthentication_required') return 'reauthentication_required';
  const status = error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `http_status=${status}`;
  return 'unknown';
}
