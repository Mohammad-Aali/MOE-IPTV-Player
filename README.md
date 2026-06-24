# 📺 MOE IPTV Player

A powerful, serverless IPTV web player powered entirely by Cloudflare Workers. It acts as a proxy to bypass CORS issues, manages M3U playlists using Cloudflare KV, and includes a built-in dead-link cleaner!

## ✨ Features
* **100% Serverless:** Runs purely on Cloudflare Workers edge network.
* **CORS Bypass:** Proxies video streams and M3U8 files so they play seamlessly in the browser.
* **Password Protected:** Built-in cookie-based authentication.
* **Source Management:** Add, edit, and manage multiple M3U URLs directly from the UI (saved to Cloudflare KV).
* **Dead Link Cleaner:** Built-in tool to scan your playlists and permanently remove offline channels.
* **Favorites System:** Star your favorite channels (saved locally to your browser).

---

## 🚀 Deployment Guide

You can deploy this to your own Cloudflare account for free in just a few minutes.

### 1. Create a Cloudflare Worker
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Workers & Pages** -> **Overview** from the left sidebar.
3. Click **Create Application**, then **Start with Hello World!**.
4. Name your worker (e.g., `moe-iptv`) and click **Deploy**.
5. Click **Edit code**. Clear the default code, paste the contents of `worker.js` from this repository, and click **Save and deploy**.

### 2. Setup Cloudflare KV (Storage)
To save your custom M3U sources and cleaned playlists, you must bind a KV namespace.
1. Go back to your Cloudflare Dashboard.
2. Navigate to **Storage & Databases** -> **Workers KV**.
3. Click **Create Instance** and name it `IPTV_KV_STORE` (or whatever you like).
4. Go back to **Workers & Pages** and click on your newly created Worker.
5. Go to the **Bindings** tab.
6. Click **Add binding**, select **KV namespace**, and click **Add Binding**.
7. Set the **Variable name** to exactly: `IPTV_KV`
8. Select the KV namespace you created in step 3 and click **Add Binding**.

### 3. Setup Environment Variables (Security)
By default, the player uses `Admin@123` as the password. For security, it is **highly recommended** to change this by creating environment variables.
1. Navigate to your Worker's **Settings** tab, **Variables & Secrets** section.
2. Click **+ Add** and create the following two environment variables (keep them encrypted as secrets):
   * Variable Name: `LOGIN_PASSWORD` | Type: Secret | Value: *Your_Secure_Password*
   * Variable Name: `COOKIE_SECRET` | Type: Secret | Value: *A_Random_Secret_String* (e.g., `super-secret-key-998`)
3. Click **Deploy**.

🎉 **You're done!** Open your Worker's URL, log in (the default password is `Admin@123` if you didn't change it), and start watching!

---

## 📂 Managing Playlists

By default, the player loads a sample `default-playlist.m3u` file hosted in this repository. 

**The Easiest Way (UI):**
You don't need to edit any code to use your own playlists! Once you log into the player, simply click the **Settings (Gear Icon)** in the left sidebar. From there, you can add, edit, or remove as many remote M3U URLs as you want. These changes are saved directly to your Cloudflare KV and will override the default playlist.

**Advanced (Hardcoding a Default):**
If you prefer to permanently hardcode a different default playlist so it loads instantly without using the UI settings, you can edit the `DEFAULT_M3U_URL` variable at the top of the `worker.js` file to point to your own raw `.m3u` link.