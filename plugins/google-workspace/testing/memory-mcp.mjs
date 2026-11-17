// In-memory implementation of the MCP port, for application tests.
// Behaviour is supplied by each test; it does not simulate Google editing logic.
export class MemoryMcp {
  constructor({ tools = [], handler = () => ({ content: [] }) } = {}) {
    this.tools = structuredClone(tools); this.handler = handler; this.calls = []; this.closed = false;
  }
  check(signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('MCP connection closed');
  }
  async listTools(token, { signal } = {}) {
    this.check(signal); this.calls.push({ method: 'listTools', token });
    return structuredClone(this.tools);
  }
  async callTool(token, call, { signal } = {}) {
    this.check(signal);
    this.calls.push({ method: 'callTool', token, call: structuredClone(call) });
    return structuredClone(await this.handler(structuredClone(call), `Bearer ${token}`));
  }
  async close() { this.closed = true; }
}
