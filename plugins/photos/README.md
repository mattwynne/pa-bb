# Photos for BB

Browse iCloud Photos and download selected originals. Connect a Grain MCP server to use its photo tools in BB conversations.

## Install

In a PA for BB checkout, run `npm ci` in `plugins/photos`, then `bb plugin install .` from that directory. Open **Settings → Installed plugins → Photos**. BB 0.50.1 or later is required.

### iCloud Photos

1. Enable the [iCloud plugin](../icloud/README.md) version 0.3.3 or later.
2. If needed, connect your Apple account in **iCloud** settings. On a trusted Apple device, enable **Access iCloud Data on the Web** and follow any approval prompt.
3. Return to **Photos** and choose **Browse library** to open a personal or shared library and its albums.

Photos uses the Apple session managed by iCloud. The iCloud plugin provides read-only album listings and streams individual originals to the browser. JPEG, PNG, GIF and WebP files up to 20 MiB can be previewed. Other files are available as original downloads. Each Live Photo component that rclone returns is shown separately. If Apple expires the session or browsing stops working, open **iCloud** settings to reconnect.

### Journal (prototype)

Open **Journal** from BB's navigation to see your photos as a full-page grid, grouped by day or month. Journal starts with the newest photos in **All Photos**, treating the end of the album listing as the most recent. If a library is too large for iCloud to list within BB's 75-second plugin request limit, Journal shows **Favorites** instead. You can open another album from **Albums** and load older photos with **Show earlier photos**. Videos and Live Photo movie files are skipped.

Photos are downloaded one at a time, then reduced to small JPEG thumbnails that are stored in this browser for faster later visits. Safari decodes HEIC itself. Other browsers load the bundled [libheif-js](https://github.com/catdad-experiments/libheif-js) decoder (LGPL-3.0) from the Photos plugin the first time they need it. Dates come from each photo's EXIF data.

Tap photos to select them in order, then choose **Make a gallery** to add a title and a few words. Choose the Grain group to share with under **Journal sharing** in Photos settings. Posting is not connected yet. **Share** does not send anything and explains this.

### Grain MCP

In Photos settings, enter the full HTTPS URL of your instance's Streamable HTTP MCP endpoint and its bearer token if required. **Connect Grain** verifies MCP tool discovery before saving. The URL can point to a private instance reachable by the BB server. BB connects to the exact configured URL, uses standard TLS certificate verification and refuses redirects. Endpoints accepting anonymous or bearer-token requests are supported.

In a conversation, the assistant can use `grain_list_tools` to discover the connected server's tools and `grain_call_tool` to call a discovered tool. The endpoint determines which photo operations are available. Use **Check connection** to verify tool discovery again, or **Manage Grain connection** to change or disconnect the endpoint.

## Verification

Run `npm run typecheck`, `npm run build` and `npm test`. The test suite uses generated files and synthetic Apple and MCP responses. The iCloud tests cover the shared session and stream generated files through its private rclone socket. Run the rendered review against BB with `BB_REVIEW_BASE=http://127.0.0.1:PORT node test/rendered-review.mjs`. Live Apple sign-in and private Grain authentication must be verified with the respective account owner.
