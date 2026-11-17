export function memoryStore() {
  const accounts = new Map(), pending = new Map();
  return {
    accounts: async () => [...accounts.values()].map(r => structuredClone(r)),
    byEmail: async email => structuredClone([...accounts.values()].find(r => r.email.toLowerCase() === email.toLowerCase())),
    bySubject: async subject => structuredClone(accounts.get(subject)),
    saveAccount: async record => { accounts.set(record.subject, structuredClone(record)); },
    removeAccount: async subject => accounts.delete(subject),
    savePending: async record => { pending.set(record.stateHash, structuredClone(record)); },
    consumePending: async hash => { const record = pending.get(hash); pending.delete(hash); return structuredClone(record); },
  };
}
