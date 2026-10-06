// Small reference store for the core contract tests; production uses the BB storage adapter.
export function createMemoryStore() {
  const records = new Map();
  const pending = new Map();
  return {
    async accounts() { return [...records.values()].map(x => ({ ...x })); },
    async byEmail(email) { return [...records.values()].find(x => x.email.toLowerCase() === email.toLowerCase()) || null; },
    async bySubject(subject) { return records.get(subject) ? { ...records.get(subject) } : null; },
    async addAccount(record) {
      if (records.has(record.subject) || [...records.values()].some(x => x.email.toLowerCase() === record.email.toLowerCase())) throw new Error('Google account is already connected');
      records.set(record.subject, { ...record });
    },
    async removeAccount(subject) { return records.delete(subject); },
    async updateEmail(subject, email) {
      const previous = records.get(subject);
      if (!previous) return false;
      records.set(subject, { ...previous, email }); return true;
    },
    async mergeToken(subject, oldRefreshToken, update) {
      const current = records.get(subject);
      if (!current || current.refreshToken !== oldRefreshToken) return false;
      records.set(subject, { ...current, ...update, refreshToken: update.refreshToken || current.refreshToken }); return true;
    },
    async savePending(grant) { pending.set(grant.stateHash, { ...grant }); },
    async consumePending(hash) { const grant = pending.get(hash); pending.delete(hash); return grant || null; },
  };
}
