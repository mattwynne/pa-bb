// Harmless discovery fixture; no Google access or credentials.
export default function (pi) {
  pi.registerCommand("pa-bb-discovery-spike", {
    description: "Confirms that the BB-installed Pi package was discovered",
    handler: async (_args, ctx) => ctx.ui.notify("PA BB Pi extension loaded", "info"),
  });
}
