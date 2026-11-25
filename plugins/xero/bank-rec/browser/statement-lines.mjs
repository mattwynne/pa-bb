// Keep this function self-contained: its source is evaluated in the signed-in page.
export function extractVisibleStatementLines(doc = globalThis.document) {
  function visible(node) {
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (current.hidden) return false;
    }
    return true;
  }
  function clean(text) { return text.replace(/\s+/g, " ").trim(); }
  function parseLine(text) {
    const date = text.match(/^(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/)?.[1] ?? null;
    const reference = text.match(/\b(CARD-[A-Za-z0-9-]+|[A-Z0-9]{4,}-[A-Z0-9-]+)\b/)?.[1] ?? null;
    const spent = text.match(/\bSpent\s+([\d,]+\.\d{2})/)?.[1] ?? null;
    const received = text.match(/\bReceived\s+([\d,]+\.\d{2})/)?.[1] ?? null;
    let payee = null;
    if (date) {
      const rest = text.slice(date.length).trim();
      payee = rest.split(/\b(?:Card transaction|Direct Credit|Direct Debit|E-Transfer|More details|Spent|Received|CARD-)\b/i)[0].trim() || null;
    }
    return { date, payee, spent, received, reference, text };
  }
  const candidates = [];
  for (const node of doc.querySelectorAll(".bank-statement-line-details")) {
    if (!visible(node)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 40) continue;
    const spans = node.querySelectorAll(".line-details > span");
    const date = clean(spans[0]?.innerText || "") || null;
    const payee = clean(spans[1]?.innerText || "") || null;
    const spent = clean(node.querySelector(".amount-spent span")?.innerText || "") || null;
    const received = clean(node.querySelector(".amount-received span")?.innerText || "") || null;
    const text = clean(node.innerText || "");
    const reference = text.match(/\b(CARD-[A-Za-z0-9-]+|[A-Z0-9]{4,}-[A-Z0-9-]+)\b/)?.[1] ?? null;
    candidates.push({ date, payee, spent, received, reference, text, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  }
  for (const node of doc.querySelectorAll("body *")) {
    if (!visible(node) || node.closest(".bank-statement-line-details") || node.querySelector(".bank-statement-line-details")) continue;
    const text = clean(node.innerText || "");
    if (!/^\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\b/.test(text)) continue;
    if (!/\b(Spent|Received)\b/i.test(text) || text.length > 300) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 40) continue;
    candidates.push({ ...parseLine(text), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  }
  const rows = [];
  for (const item of candidates.sort((a, b) => a.y - b.y || a.x - b.x || a.text.length - b.text.length)) {
    const index = rows.findIndex(row => Math.abs(row.x - item.x) <= 8 && Math.abs(row.y - item.y) <= 8);
    if (index < 0) rows.push(item);
    else if (item.text.length < rows[index].text.length) rows[index] = item;
  }
  return rows.sort((a, b) => a.y - b.y || a.x - b.x);
}
