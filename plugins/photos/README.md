# Photos for BB

Browse iCloud Photos and download selected originals. Connect a Grain MCP server to use its photo tools in BB conversations.

## Install

In a PA for BB checkout, run `npm ci` in `plugins/photos`, then `bb plugin install .` from that directory. Open **Settings → Installed plugins → Photos**. BB 0.50.1 or later is required.

### iCloud Photos

1. Install rclone with the [iCloud Photos backend](https://rclone.org/iclouddrive/#icloud-photos) and util-linux `flock` on the BB Linux host. The PA host dependencies include rclone. The plugin looks for it in `/usr/local/bin`, `/usr/bin` and `/bin`.
2. On a trusted Apple device, open **Settings → Apple Account → iCloud** and enable **Access iCloud Data on the Web**. Approve a trusted-device request if Apple asks.
3. In Photos settings, enter your Apple account email and regular Apple password, then follow the verification prompt. Enter credentials and codes only in the settings form.
4. Choose **Browse library** to open a personal or shared library and its albums. Preview supported images on demand or choose **Download** for an original file. Each Live Photo component that rclone returns is shown separately.

The Apple sign-in belongs to Photos. It uses a separate encrypted rclone config and read-only remote. The plugin fetches album listings as you open them and streams selected originals to your browser. JPEG, PNG, GIF and WebP files up to 20 MiB can be previewed. Other files are available as original downloads. rclone can take longer to open a large album on the first visit.

If Apple expires the session or browsing stops working, use **Manage Apple connection → Reconnect**. **Disconnect** removes the Photos remote and its listing cache on the BB host.

### Grain MCP

In Photos settings, enter the full HTTPS URL of your instance's Streamable HTTP MCP endpoint and its bearer token if required. **Connect Grain** verifies MCP tool discovery before saving. The URL can point to a private instance reachable by the BB server. BB connects to the exact configured URL, uses standard TLS certificate verification and refuses redirects. Endpoints accepting anonymous or bearer-token requests are supported.

In a conversation, the assistant can use `grain_list_tools` to discover the connected server's tools and `grain_call_tool` to call a discovered tool. The endpoint determines which photo operations are available. Use **Check connection** to verify tool discovery again, or **Manage Grain connection** to change or disconnect the endpoint.

## Verification

Run `npm run typecheck`, `npm run build` and `npm test`. The test suite uses generated files and synthetic Apple and MCP responses. The native rclone test exercises retrieval through its private Unix socket with generated files. Run the rendered review against BB with `BB_REVIEW_BASE=http://127.0.0.1:PORT node test/rendered-review.mjs`. Live Apple sign-in and private Grain authentication must be verified with the respective account owner.
