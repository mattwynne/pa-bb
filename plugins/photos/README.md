# Photos for BB

Browse iCloud Photos and download selected originals. Connect a Grain MCP server to use its photo tools in BB conversations.

## Install

In a PA for BB checkout, run `npm ci` in `plugins/photos`, then `bb plugin install .` from that directory. Open **Settings → Installed plugins → Photos**. BB 0.50.1 or later is required.

### iCloud Photos

1. Enable the [iCloud plugin](../icloud/README.md) version 0.3.3 or later.
2. If needed, connect your Apple account in **iCloud** settings. On a trusted Apple device, enable **Access iCloud Data on the Web** and follow any approval prompt.
3. Return to **Photos** and choose **Browse library** to open a personal or shared library and its albums.

Photos uses the Apple session managed by iCloud. The iCloud plugin provides read-only album listings and streams individual originals to the browser. JPEG, PNG, GIF and WebP files up to 20 MiB can be previewed. Other files are available as original downloads. Each Live Photo component that rclone returns is shown separately. If Apple expires the session or browsing stops working, open **iCloud** settings to reconnect.

### Journal

Open **Journal** from BB’s navigation to see the whole library, newest first. On your first visit, iCloud gathers the library in the background and Journal shows photos as they arrive. Scroll to browse, jump to a month using the date picker or timeline, or open **Albums**.

Journal requires the iCloud plugin’s indexed Photos library and image versions. It loads Apple’s previews and keeps a bounded cache in this browser. The original download and preview controls are available in Photos settings.

Select photos in order and choose **Make a gallery** to add a title and a few words. Choose the Grain group under **Journal sharing** in Photos settings. The compose sheet shows the intended audience. Posting is still pending integration.

### Grain MCP

In Photos settings, enter the full HTTPS URL of your instance's Streamable HTTP MCP endpoint and its bearer token if required. **Connect Grain** verifies MCP tool discovery before saving. The URL can point to a private instance reachable by the BB server. BB connects to the exact configured URL, uses standard TLS certificate verification and refuses redirects. Endpoints accepting anonymous or bearer-token requests are supported.

In a conversation, the assistant can use `grain_list_tools` to discover the connected server's tools and `grain_call_tool` to call a discovered tool. The endpoint determines which photo operations are available. Use **Check connection** to verify tool discovery again, or **Manage Grain connection** to change or disconnect the endpoint.

## Verification

Run `npm run typecheck`, `npm run build` and `npm test`. The test suite uses generated files and synthetic Apple and MCP responses. The iCloud tests cover the shared session and stream generated files through its private rclone socket. Run the rendered review against BB with `BB_REVIEW_BASE=http://127.0.0.1:PORT node test/rendered-review.mjs`. Live Apple sign-in and private Grain authentication must be verified with the respective account owner.
