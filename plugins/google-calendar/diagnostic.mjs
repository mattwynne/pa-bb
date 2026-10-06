// Only local, bounded categories cross into BB logs. Never serialize an exception:
// its message, cause and response body may contain account data or OAuth secrets.
export function failureCategory(error) {
  if (error?.code === 'invalid_grant' || error?.code === 'reauthentication_required') return 'reauthentication_required';
  const status = error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `http_status=${status}`;
  return 'unknown';
}
