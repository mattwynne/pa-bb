// Authoring source, serialized by scripts/generate-bank-rec-source.mjs, not imported by the server bundle.
// Keep functions self-contained and avoid // comments inside: bookmark managers may remove newlines.
export function browserCapture(tenantId, accounts, extract) {
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const url = new URL(globalThis.location.href);
  if (url.protocol !== 'https:' || url.hostname !== 'go.xero.com' || url.port || url.username || url.password || url.pathname !== '/BankRec/BankRec.aspx') throw new Error('Open the Xero Bank Reconciliation page first.');
  const ids = Array.from(url.searchParams.entries()).filter(([key]) => key.toLowerCase() === 'accountid').map(([, value]) => value);
  if (ids.length !== 1 || !guid.test(ids[0])) throw new Error('No recognized bank account is selected.');
  const account = accounts.find(item => item.AccountID.toLowerCase() === ids[0].toLowerCase());
  if (!account) throw new Error('This bank account is not in the installer catalog.');
  const doc = globalThis.document;
  function visible(node) {
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = globalThis.getComputedStyle(current);
      if (current.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }
  const tabText = node => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
  if (!Array.from(doc.querySelectorAll('h1,h2,h3,[role="tab"],a')).some(node => visible(node) && /^Reconcile(?:\s*\(\d+\))?$/i.test(tabText(node)))) throw new Error('The Reconcile view is not visible.');
  for (const tab of doc.querySelectorAll('[role="tab"], [role="tablist"] a, .nav-tabs a, .tabs a')) {
    if (!visible(tab)) continue;
    const selected = tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('aria-current') === 'page' || /(?:^|\s)(?:active|selected)(?:\s|$)/i.test(tab.className || '') || /(?:^|\s)(?:active|selected)(?:\s|$)/i.test(tab.parentElement?.className || '');
    if (selected && /^(?:Bank statements|Account transactions)(?:\s*\(\d+\))?$/i.test(tabText(tab))) throw new Error('Select the Reconcile tab first.');
  }
  const lines = extract(doc);
  if (!Array.isArray(lines) || !lines.length || lines.length > 2500) throw new Error('No usable visible statement lines were found.');
  for (const line of lines) {
    if (typeof line.date !== 'string' || !/^\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}$/.test(line.date) ||
        (line.spent == null) === (line.received == null) ||
        (line.spent != null && (typeof line.spent !== 'string' || !/^[\d,]+\.\d{2}$/.test(line.spent))) ||
        (line.received != null && (typeof line.received !== 'string' || !/^[\d,]+\.\d{2}$/.test(line.received)))) throw new Error('Some lines have incomplete dates or amounts.');
  }
  const selectedAccount = { AccountID: account.AccountID, Name: account.Name, CurrencyCode: account.CurrencyCode };
  if (account.Code !== undefined) selectedAccount.Code = account.Code;
  const payload = { format: 'xero-bank-rec-capture', version: 2, tenantId, capturedAt: new Date().toISOString(), coverage: { visibleOnly: true, complete: false }, account: selectedAccount,
    url: `https://go.xero.com/BankRec/BankRec.aspx?accountId=${account.AccountID}`, lines };
  const json = JSON.stringify(payload);
  if (new TextEncoder().encode(json).byteLength > 1_000_000) throw new Error('The capture exceeds the size limit.');
  const slug = account.Name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'account';
  const objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  try {
    const anchor = doc.createElement('a'); anchor.href = objectUrl; anchor.download = `xero-bank-rec-${slug}-${payload.capturedAt.replace(/[:.]/g, '-')}.json`;
    anchor.style.display = 'none'; doc.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  } finally { globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000); }
}
