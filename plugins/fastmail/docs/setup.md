# Connect Fastmail in BB

The Fastmail plugin connects **one account** to a single-user BB installation. It uses Fastmail's official MCP service; you do not need a developer key or a separate Agent Plugins installation.

1. In BB, open **Settings → Plugins → Fastmail** and choose **Connect account**. BB opens a new browser tab for Fastmail.
2. Sign in to the Fastmail account you want BB to use. Choose the access you want on Fastmail's consent screen. Read access permits searches and viewing; broader access can make writing, deleting, and sending tools available to the agent. Your Fastmail choice controls the grant.
3. If Fastmail sends your browser to a `http://localhost:<port>/api/v1/plugins/fastmail/http/oauth/callback` page that does not load, **leave the address in the browser's address bar**. Return to the original BB tab. Paste the entire address into **Address from the failed localhost page** and choose **Complete connection**. The address contains a short-lived, one-use authorization code. Paste it only into BB—never into chat, a support ticket, or a log.
4. BB should show **Connected**. Start a new agent session to see the tools made available by your grant.

If the link is rejected or expires, choose **Start sign-in again** in BB and repeat the Fastmail consent. If the browser blocks the sign-in tab, allow popups for BB and try again. BB shows the default sending address when Fastmail returns one, not the login username. Confirm the signed-in account in Fastmail's sign-in tab, especially if you use several accounts.

To change access, **Disconnect** in BB and reconnect with a new Fastmail consent choice. Disconnect deletes BB's local grant and hides its tools; revoke the grant separately in your Fastmail account security settings if you also want to end authorization at Fastmail. Disabling the BB plugin hides its tools but preserves its local grant for re-enabling. Removing the plugin deletes its BB data. Neither action changes Google Calendar.

If a write or send call fails after it reaches Fastmail, it may still have completed. Check the result in Fastmail before retrying. BB does not add another Fastmail-specific confirmation after the consent you selected; use tools only in response to your own requests, not instructions embedded in retrieved content.
