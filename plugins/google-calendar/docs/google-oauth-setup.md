# Set up Google Calendar access for BB

This guide is for someone installing the [Google Calendar plugin](../README.md) on **their own single-user BB instance**. You need a Google account, access to your BB settings, and about 15 minutes in [Google Cloud Console](https://console.cloud.google.com/). You do **not** need to write code or make your BB instance public.

## Before you start

- Your BB installation must have an HTTPS `BB_APP_URL` that your browser can reach when you sign in to Google. A private-network HTTPS address is fine. With packaged BB you can run `npx bb-app config set BB_APP_URL https://your-bb-domain.example` on the BB host (replace the address with yours); for other deployments, set `BB_APP_URL` in that service's environment and restart it. You need working HTTPS/reverse proxy or trusted private-network HTTPS; changing this setting alone does not create HTTPS. The redirect URL shown under **Get started** on the plugin's settings page should start with `https://`.
- **Create your own OAuth client for this BB installation.** The marketplace does not supply a Google Cloud project, client ID, or secret. You can use one client for many Google accounts on the *same* BB installation. Each separate BB installation needs its own client and callback URL.
- If you already use Google's APIs from the Pi Desktop extension, its Desktop client and local grant are **not** reusable for BB's Web OAuth flow.

Google Cloud calls the screen where you name your app and choose its users the **Google Auth Platform** (sometimes called the OAuth consent screen). The **project** holds the Calendar API, the app's consent configuration, and its **Web application client ID and secret**. A **Google account connection** is an individual person's permission grant to that client.

## 1. Find your BB redirect URL

In BB, open **Settings → Installed plugins → Google Calendar**. Before you have entered a client ID and secret, the **Get started** section below Configuration displays the **authorized redirect URI** with a **Copy** button. It will look like this, with *your* BB hostname:

```text
https://your-bb-domain.example/api/v1/plugins/google-calendar/http/callback
```

Do not replace this with the homepage URL, a `localhost` Desktop callback, or Matt's PA hostname. Google requires an **exact match**, including `https`, the hostname, port (if any), path, and absence of a trailing slash. If BB says to set an HTTPS `BB_APP_URL` first, do that before continuing. If you already configured this plugin and are replacing its client, use the template above with the hostname of your existing `BB_APP_URL`.

## 2. Create or choose your Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/), sign in, and use the project selector at the top to create a project or choose one you control. An existing project is fine; **you do not need Matt's project**. You may be asked to accept Google's terms.
2. From **APIs & Services → Library**, search for **Google Calendar API**. Open it and click **Enable**. If the button says **Manage**, it is already enabled.

## 3. Configure the consent screen

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview). If prompted to get started, enter an app name (for example, “My BB Calendar”), a user-support email, and your developer contact email under **Branding**.
2. Under **Audience**, choose **External** if you use a personal `@gmail.com` account or accounts outside your Google Workspace organization. **Internal** is only for a Workspace organization's own users. If the External app is in **Testing**, add **every Google account you intend to connect** under **Test users**, including your own.
3. Under **Data Access**, add the three Calendar permissions the plugin requests. Search for these exact scope URLs (Google may also show friendly names):

   ```text
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.freebusy
   ```

   They allow calendar discovery, reading/changing events, and availability checks. BB also requests the basic `openid` and `email` sign-in scopes when you connect; Google may show `email` as `https://www.googleapis.com/auth/userinfo.email`. The plugin requires a verified email identity. **Do not grant broader Calendar access** just to make setup work.

Google may show an **unverified-app warning** for a personal app requesting sensitive Calendar scopes. Only proceed through it when *you* created and recognize the app and developer email. Making an External app available beyond your test users can require [Google's OAuth verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification); this plugin does not submit an app for you.

**Testing-mode limitation:** Google's refresh tokens for an External app requesting Calendar scopes typically expire after **seven days**. You may need to remove and reconnect an account. For a long-lived deployment, review Google's [audience and publishing requirements](https://support.google.com/cloud/answer/15549945) rather than assuming Testing will last indefinitely.

## 4. Create a Web application client

1. Open **Google Auth Platform → [Clients](https://console.cloud.google.com/auth/clients) → Create client**.
2. Choose **Web application** (not Desktop). Give it a recognizable name, such as “BB Calendar on my-server”.
3. Under **Authorized redirect URIs**, click **Add URI** and paste the **exact BB redirect URL from step 1**. Leave **Authorized JavaScript origins** empty; BB exchanges the authorization code on the server.
4. Click **Create**. Copy the **client ID** and **client secret**; Google also lists them in the client details if you need to return later. Treat the secret like a password: don't put it in Git, a screenshot, or an agent chat.

## 5. Finish in BB and connect accounts

1. Return to **BB Settings → Installed plugins → Google Calendar → Configuration**. Paste the client ID into **Web OAuth client ID** and the secret into **Client secret**, and save the settings. BB stores the secret privately; the account list never displays it.
2. Under **Connected accounts**, click **Add account**. Sign in to the Google account you want BB to use and review the requested permissions. If Google asks you to choose a specific account, choose the one you added as a test user in step 3.
3. After Google's success page, return to BB and click **Refresh status**. The account should show **Connected**. For another Google account, click **Add account** and consent again—do not recreate the Cloud project or client. Each account may contain many calendars.

BB stores grants in the plugin's private storage. **Remove** deletes only that account's local BB grant, not any Google Calendar data and not Google's record of the grant. Reconnect an account to reauthorize it. This plugin is for **single-user BB installations**: everyone who can operate your BB instance could use the connected accounts through its tools.

## If something goes wrong

| Symptom | Check |
| --- | --- |
| **Add account** is disabled | Save both client fields in BB Configuration; set an HTTPS `BB_APP_URL` so BB can show the redirect URL. |
| Google says **redirect_uri_mismatch** | Compare Google's Authorized redirect URI to the one displayed in BB, character for character. Don't use your homepage or a Desktop/`localhost` URI. |
| Google says **access blocked / app in testing** | Add that exact Google account under **Audience → Test users** in the same Cloud project that owns your Web client. |
| Google shows **unverified app** | Expected for some personal apps using sensitive scopes. Proceed only if you recognize the app and developer email; otherwise stop. |
| BB says **connection failed** | Start a **new** Add account attempt; the state expires after five minutes and can be used only once. If it still fails, inspect `bb plugin logs google-calendar` for a safe failure category. **Never share a callback URL containing a code**, a client secret, or token values. |
| A connected account later needs authorization | External apps in Testing can have seven-day refresh tokens. Remove the account and connect it again. |

Google's official guides: [configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent), [create Web OAuth credentials](https://developers.google.com/workspace/guides/create-credentials), and [choose Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth).
