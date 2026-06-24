export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      
      // ==========================================
      // 1. CONFIGURATION
      // ==========================================
      const LOGIN_PASSWORD = env.LOGIN_PASSWORD || "Admin@123"; 
      const COOKIE_SECRET = env.COOKIE_SECRET || "s3t-th1s-1n-env-v4rs";
      const AUTH_COOKIE_NAME = "iptv_auth_token";
      const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; 
      const DEFAULT_M3U_URL = "https://raw.githubusercontent.com/Mohammad-Aali/MOE-IPTV-Player/main/default-playlist.m3u";
	  
      // ==========================================
      // 2. AUTH HELPERS
      // ==========================================
      async function generateToken(password, salt) {
        const data = new TextEncoder().encode(password + salt);
        const hash = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      }

      async function isAuthenticated(req) {
        const cookieHeader = req.headers.get("Cookie") || "";
        const cookies = Object.fromEntries(
          cookieHeader.split(";").map(c => {
            const parts = c.trim().split("=");
            return [decodeURIComponent(parts[0] || ''), decodeURIComponent(parts.slice(1).join("=") || '')];
          })
        );
        const token = cookies[AUTH_COOKIE_NAME];
        if (!token) return false;
        const expectedToken = await generateToken(LOGIN_PASSWORD, COOKIE_SECRET);
        return token === expectedToken;
      }

      const action = url.searchParams.get('action');
      const targetUrl = url.searchParams.get('url');
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

      // ==========================================
      // 3. LOGIN / LOGOUT
      // ==========================================
      if (action === 'logout') {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': url.pathname,
            'Set-Cookie': `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
          }
        });
      }

      if (request.method === 'POST' && action === 'login') {
        const formData = await request.formData();
        const password = formData.get('password') || '';
        if (password === LOGIN_PASSWORD) {
          const token = await generateToken(LOGIN_PASSWORD, COOKIE_SECRET);
          return new Response(JSON.stringify({ status: 'success' }), {
            headers: {
              'Content-Type': 'application/json',
              'Set-Cookie': `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${AUTH_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax`,
            }
          });
        } else {
          return new Response(JSON.stringify({ status: 'error', message: 'Incorrect password' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      const authenticated = await isAuthenticated(request);
      if (!authenticated) {
        return new Response(getLoginHTML(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      // ==========================================
      // 4. KV: GET / SAVE M3U SOURCES
      // ==========================================
      if (action === 'get-sources') {
        let sources = [];
        if (env.IPTV_KV) {
          try {
            const raw = await env.IPTV_KV.get('m3u_sources');
            if (raw) sources = JSON.parse(raw);
          } catch(e) { console.error("KV Read Error", e); }
        }
        if (sources.length === 0) sources = [{ id: 'default', name: 'Default', url: DEFAULT_M3U_URL }];
        return new Response(JSON.stringify(sources), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (request.method === 'POST' && action === 'save-sources') {
        if (!env.IPTV_KV) {
          return new Response(JSON.stringify({ status: 'error', message: 'KV not configured in Cloudflare Dashboard' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
          });
        }
        const body = await request.json();
        await env.IPTV_KV.put('m3u_sources', JSON.stringify(body.sources));
        return new Response(JSON.stringify({ status: 'success' }), { headers: { 'Content-Type': 'application/json' } });
      }

      // ==========================================
      // 5. VIDEO & M3U8 STREAM PROXY
      // ==========================================
      if (action === 'proxy' && targetUrl) {
        try {
          const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8')) {
            let text = await response.text();
            const baseUrl = new URL('.', targetUrl).href;
            const rewritten = text.split('\n').map(line => {
              line = line.trim();
              if (!line || line.startsWith('#')) return line;
              let absoluteUri = line.startsWith('http') ? line : new URL(line, baseUrl).href;
              return `${url.origin}${url.pathname}?action=proxy&url=${encodeURIComponent(absoluteUri)}`;
            }).join('\n');
            return new Response(rewritten, { headers: { ...corsHeaders, 'Content-Type': 'application/vnd.apple.mpegurl' } });
          }
          return new Response(response.body, { headers: { ...corsHeaders, 'Content-Type': contentType } });
        } catch (e) {
          return new Response("Proxy Error: " + e.message, { status: 500, headers: corsHeaders });
        }
      }

      // ==========================================
      // 6. LOGO PROXY
      // ==========================================
      if (action === 'logo' && targetUrl) {
        try {
          const response = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          return new Response(response.body, {
            headers: { ...corsHeaders, 'Content-Type': response.headers.get('content-type') || 'image/png', 'Cache-Control': 'max-age=2592000, public' }
          });
        } catch (e) {
          return new Response(null, { status: 404 });
        }
      }

      // ==========================================
      // 7. CLEANER BACKEND LOGIC
      // ==========================================
      if (action === 'cleaner') {
          return new Response(getCleanerHTML(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      if (action === 'test-stream' && request.method === 'POST') {
          const formData = await request.formData();
          const target = formData.get('url');
          if (!target) return new Response("DEAD", { status: 404, headers: corsHeaders });

          try {
              const res = await fetch(target, {
                  method: 'GET',
                  headers: { 
                      'Range': 'bytes=0-200', 
                      'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16' 
                  },
                  cf: { cacheTtl: 0 }
              });
              if (res.ok || res.status === 206 || res.status < 400) {
                  return new Response("ALIVE", { status: 200, headers: corsHeaders });
              }
          } catch(e) {}
          return new Response("DEAD", { status: 404, headers: corsHeaders });
      }

      if (action === 'save-cleaned-source' && request.method === 'POST') {
          if (!env.IPTV_KV) return new Response(JSON.stringify({error: 'No KV'}), {status: 500});
          const body = await request.json(); 
          const id = 'clean_' + Date.now();
          
          await env.IPTV_KV.put('m3u_file_' + id, body.content);
          
          const rawSources = await env.IPTV_KV.get('m3u_sources');
          let sources = rawSources ? JSON.parse(rawSources) : [];
          const internalUrl = `${url.origin}${url.pathname}?action=serve-m3u&id=${id}`;
          sources.push({ id, name: body.name, url: internalUrl });
          await env.IPTV_KV.put('m3u_sources', JSON.stringify(sources));
          
          return new Response(JSON.stringify({status: 'success'}), {headers: {'Content-Type': 'application/json'}});
      }

      if (action === 'serve-m3u') {
          const id = url.searchParams.get('id');
          if (env.IPTV_KV && id) {
              const content = await env.IPTV_KV.get('m3u_file_' + id);
              if (content) {
                  return new Response(content, { headers: { ...corsHeaders, 'Content-Type': 'audio/x-mpegurl' } });
              }
          }
          return new Response("Not found", {status: 404});
      }

      // ==========================================
      // 8. CHANNELS
      // ==========================================
      if (action === 'channels') {
        let sources = [];
        if (env.IPTV_KV) {
          try {
            const raw = await env.IPTV_KV.get('m3u_sources');
            if (raw) sources = JSON.parse(raw);
          } catch(e) { console.error("KV Read Error", e); }
        }
        if (sources.length === 0) sources = [{ id: 'default', name: 'Default', url: DEFAULT_M3U_URL }];
        
        // Process sources, checking if they are internal KV files or external URLs
        const results = await Promise.allSettled(
          sources.map(async src => {
            let text = '';
            if (src.url.includes('action=serve-m3u&id=')) {
              try {
                const urlObj = new URL(src.url);
                const id = urlObj.searchParams.get('id');
                if (env.IPTV_KV && id) {
                  text = await env.IPTV_KV.get('m3u_file_' + id) || "";
                }
              } catch(e) { console.error("Internal KV Error", e); }
            } else {
              const r = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
              text = await r.text();
            }
            return { text, sourceName: src.name };
          })
        );

        let allChannels = [];
        for (const result of results) {
          if (result.status === 'fulfilled') {
            allChannels = allChannels.concat(parseM3U(result.value.text, result.value.sourceName));
          }
        }
        return new Response(JSON.stringify(allChannels), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // ==========================================
      // 9. SERVE HTML PLAYER
      // ==========================================
      return new Response(getHTML(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

    } catch (criticalError) {
      return new Response(`CRITICAL WORKER ERROR: ${criticalError.message}\n\nStack: ${criticalError.stack}`, { 
        status: 500, 
        headers: { 'Content-Type': 'text/plain' } 
      });
    }
  }
};

// ==========================================
// HELPERS
// ==========================================
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function parseM3U(m3uText, sourceName) {
  const lines = m3uText.split('\n');
  const channels = [];
  let currentChannel = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const nameParts = line.split(',');
      const name = nameParts[nameParts.length - 1].trim();
      let logo = ''; const logoMatch = line.match(/tvg-logo="(.*?)"/); if (logoMatch) logo = logoMatch[1];
      let group = 'Uncategorized'; const groupMatch = line.match(/group-title="(.*?)"/); if (groupMatch) group = groupMatch[1].trim();
      const prefixedGroup = sourceName ? `${sourceName} > ${group}` : group;
      let hasEpg = false; const epgMatch = line.match(/tvg-id="(.*?)"/); if (epgMatch && epgMatch[1].trim() !== '') hasEpg = true;
      const nameUpper = name.toUpperCase();
      const isHd = [' HD', '-HD', 'FHD', '4K', '1080', '720'].some(q => nameUpper.includes(q));
      currentChannel = { name, logo, group: prefixedGroup, is_hd: isHd, has_epg: hasEpg, source: sourceName };
    } else if (line.startsWith('http') && currentChannel) {
      currentChannel.url = line; currentChannel.id = 'ch_' + simpleHash(line);
      channels.push(currentChannel); currentChannel = null;
    }
  }
  return channels;
}

// ==========================================
// LOGIN HTML
// ==========================================
function getLoginHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login - MOE IPTV</title>
<meta name="robots" content="nofollow, noindex" />
<script src="https://cdn.tailwindcss.com"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
<style>
body { font-family: 'Inter', sans-serif; background-color: #12131C; color: white; }
.btn-loader { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin .7s linear infinite; margin: auto; }
@keyframes spin { to { transform: rotate(360deg); } }
.snackbar { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(100px); background: #272733; color: #fff; padding: 14px 18px; border-radius: 12px; opacity: 0; transition: 0.3s ease; z-index: 99999; }
.snackbar.show { opacity: 1; transform: translateX(-50%) translateY(0); }
input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus, input:-webkit-autofill:active {
transition: background-color 5000s ease-in-out 0s !important;
-webkit-text-fill-color: #ffffff !important;
caret-color: #ffffff !important;
}
input { border: none !important; box-shadow: none !important; outline: none !important; }
.mascot-eye { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
#iptv-mascot.is-hiding #eye-left { width: 10px; height: 2px; x: 36px; y: 46px; rx: 1px; fill: #FFB09E; }
#iptv-mascot.is-hiding #eye-right { width: 10px; height: 2px; x: 54px; y: 46px; rx: 1px; fill: #FFB09E; }
@keyframes headShake {
0% { transform: translateX(0); } 20% { transform: translateX(-8px) rotate(-4deg); }
40% { transform: translateX(8px) rotate(4deg); } 60% { transform: translateX(-8px) rotate(-4deg); }
80% { transform: translateX(8px) rotate(4deg); } 100% { transform: translateX(0); }
}
.mascot-shake { animation: headShake 0.4s cubic-bezier(.36,.07,.19,.97) both; }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-8">
<div class="bg-[#1C1D26] border border-[#2A2B36] p-10 rounded-xl shadow-2xl w-full max-w-md">
<div class="flex flex-col items-center mb-8 text-center">
<svg id="iptv-mascot" viewBox="0 0 100 100" class="w-24 h-24 drop-shadow-2xl mb-3">
<defs><linearGradient id="tv-grad" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="#FF7A55" /><stop offset="100%" stop-color="#E03115" />
</linearGradient></defs>
<line x1="38" y1="28" x2="25" y2="12" stroke="#FF7A55" stroke-width="4" stroke-linecap="round" />
<circle cx="25" cy="12" r="3" fill="#E03115" />
<line x1="62" y1="28" x2="75" y2="12" stroke="#E03115" stroke-width="4" stroke-linecap="round" />
<circle cx="75" cy="12" r="3" fill="#FF7A55" />
<line x1="35" y1="65" x2="28" y2="82" stroke="#9B2C2C" stroke-width="5" stroke-linecap="round" />
<line x1="65" y1="65" x2="72" y2="82" stroke="#9B2C2C" stroke-width="5" stroke-linecap="round" />
<rect x="15" y="28" width="70" height="46" rx="8" fill="url(#tv-grad)" />
<rect x="21" y="34" width="58" height="34" rx="4" fill="#12131C" />
<rect id="eye-left" x="38" y="44" width="6" height="6" rx="3" fill="#FFFFFF" class="mascot-eye" />
<rect id="eye-right" x="56" y="44" width="6" height="6" rx="3" fill="#FFFFFF" class="mascot-eye" />
</svg>
<h1 class="text-2xl font-semibold tracking-tight">MOE IPTV</h1>
<p class="text-sm text-gray-400 mt-2">Enter your password to access</p>
</div>
<form id="loginForm" class="space-y-5">
<div class="relative flex items-center">
<span class="material-icons absolute left-4 text-gray-400" style="font-size: 20px;">vpn_key</span>
<input type="password" id="password" name="password" placeholder="Password"
class="w-full bg-[#272733] rounded-xl pl-12 pr-12 py-3.5 text-white text-sm font-mono tracking-widest" required autofocus>
<button type="button" onclick="togglePass()" class="absolute right-4 text-gray-400 hover:text-white focus:outline-none transition-colors flex items-center justify-center">
<span class="material-icons" id="passwordVisibilityIcon" style="font-size: 20px;">visibility_off</span>
</button>
</div>
<button type="submit" id="loginBtn" class="w-full bg-white text-black hover:bg-gray-200 transition-all font-medium py-3.5 rounded-xl shadow-sm flex items-center justify-center gap-2">
<span id="btnText">Watch Now</span>
</button>
</form>
</div>
<div class="snackbar" id="snackbar"></div>
<script>
const passwordInput = document.getElementById("password");
const mascot = document.getElementById("iptv-mascot");
passwordInput.addEventListener("input", () => {
mascot.classList.toggle("is-hiding", passwordInput.value.length > 0);
});
document.getElementById("loginForm").addEventListener("submit", async function(e) {
e.preventDefault();
const btnText = document.getElementById("btnText");
const orig = btnText.innerHTML;
btnText.innerHTML = '<div class="btn-loader" style="border-top-color:#000;"></div>';
try {
const fd = new FormData(); fd.append('password', passwordInput.value);
const data = await fetch("?action=login", { method: "POST", body: fd }).then(r => r.json());
if (data.status === "success") { window.location.reload(); }
else {
showSnackbar(data.message); btnText.innerHTML = orig;
mascot.classList.remove("mascot-shake");
setTimeout(() => mascot.classList.add("mascot-shake"), 10);
}
} catch(e) { showSnackbar("Connection error"); btnText.innerHTML = orig; }
});
function showSnackbar(msg) {
const s = document.getElementById("snackbar"); s.innerText = msg; s.classList.add("show");
clearTimeout(s.hideTimer); s.hideTimer = setTimeout(() => s.classList.remove("show"), 3000);
}
function togglePass() {
const i = document.getElementById("password"), ic = document.getElementById("passwordVisibilityIcon");
i.type = i.type === "password" ? "text" : "password";
ic.innerText = i.type === "password" ? "visibility_off" : "visibility";
}
<\/script>
</body>
</html>`;
}

// ==========================================
// CLEANER HTML
// ==========================================
function getCleanerHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playlist Cleaner</title>
<meta name="robots" content="nofollow, noindex" />
<script src="https://cdn.tailwindcss.com"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
<style>body{font-family:'Inter',sans-serif;}</style>
</head>
<body class="bg-[#12131C] text-white min-h-screen flex flex-col items-center justify-center p-6">
<div class="bg-[#1C1D26] border border-[#2A2B36] p-10 rounded-2xl shadow-2xl w-full max-w-2xl">
<div class="flex items-center gap-4 mb-6 border-b border-[#2A2B36] pb-6">
<div class="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center text-red-500 shrink-0">
<span class="material-icons">cleaning_services</span>
</div>
<div>
<h1 class="text-xl font-bold tracking-tight">Dead Link Cleaner</h1>
<p class="text-sm text-gray-400">Scan your M3U and remove offline channels permanently.</p>
</div>
</div>
<div id="step-1">
<p class="text-sm text-gray-400 mb-4">Select how you want to provide your M3U playlist:</p>
<div class="flex gap-2 mb-6">
<button onclick="setTab('url')" id="tab-url" class="flex-1 py-2 rounded-lg bg-[#2D5BE3] text-white text-sm font-medium transition">URL</button>
<button onclick="setTab('file')" id="tab-file" class="flex-1 py-2 rounded-lg bg-[#272733] text-gray-400 text-sm font-medium transition hover:text-white">File Upload</button>
<button onclick="setTab('text')" id="tab-text" class="flex-1 py-2 rounded-lg bg-[#272733] text-gray-400 text-sm font-medium transition hover:text-white">Raw Text</button>
</div>
<div id="input-url" class="mb-6">
<input type="text" id="m3u-url" placeholder="https://..." class="w-full bg-[#272733] rounded-xl px-4 py-3.5 text-sm text-white placeholder-gray-500 border border-transparent focus:border-gray-600 focus:outline-none transition-colors">
</div>
<div id="input-file" class="mb-6 hidden">
<input type="file" id="m3u-file" accept=".m3u,.m3u8" class="w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#2D5BE3] file:text-white hover:file:bg-blue-600">
</div>
<div id="input-text" class="mb-6 hidden">
<textarea id="m3u-text" rows="5" placeholder="#EXTM3U..." class="w-full bg-[#272733] rounded-xl px-4 py-3.5 text-sm text-white placeholder-gray-500 border border-transparent focus:border-gray-600 focus:outline-none transition-colors font-mono text-xs resize-none"></textarea>
</div>
<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6 flex gap-3 text-yellow-200 text-sm">
<span class="material-icons shrink-0">warning</span>
<p><strong>Warning:</strong> Testing thousands of channels consumes worker limits and takes time. Please use reduced playlists when possible.</p>
</div>
<button id="fetch-btn" onclick="fetchAndParse()" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3.5 rounded-xl shadow-lg transition flex items-center justify-center gap-2">
<span class="material-icons" style="font-size: 20px;">radar</span> <span>Fetch & Prepare</span>
</button>
</div>
<div id="step-2" class="hidden">
<div id="status-area" class="bg-[#16161E] rounded-xl p-6 text-center border border-[#2A2B36] mb-6">
<span id="status-icon" class="material-icons text-gray-500 mb-2" style="font-size: 32px;">rule_folder</span>
<h2 id="status-title" class="text-lg font-semibold text-gray-300">Ready to Scan</h2>
<div class="flex justify-center gap-6 mt-4" id="stats-container">
<div class="text-center"><span class="block text-2xl font-bold text-blue-400" id="stat-total">0</span><span class="text-[10px] uppercase text-gray-500 tracking-wider">Total</span></div>
<div class="text-center"><span class="block text-2xl font-bold text-green-400" id="stat-alive">0</span><span class="text-[10px] uppercase text-gray-500 tracking-wider">Alive</span></div>
<div class="text-center"><span class="block text-2xl font-bold text-red-400" id="stat-dead">0</span><span class="text-[10px] uppercase text-gray-500 tracking-wider">Dead</span></div>
</div>
</div>
<div id="progress-container" class="hidden mb-6">
<div class="w-full bg-[#16161E] border border-[#2A2B36] rounded-full h-3 overflow-hidden">
<div id="progress-bar" class="bg-blue-500 h-3 rounded-full transition-all duration-300" style="width: 0%"></div>
</div>
</div>
<button id="scan-btn" onclick="startCleaning()" class="w-full bg-red-600 hover:bg-red-500 text-white font-semibold py-3.5 rounded-xl shadow-lg transition flex items-center justify-center gap-2">
<span class="material-icons" style="font-size: 20px;">delete_sweep</span> <span>Start Cleaner</span>
</button>
</div>
<div id="step-3" class="hidden">
<div class="bg-[#16161E] rounded-xl p-6 text-center border border-green-500/30 mb-6">
<span class="material-icons text-green-500 mb-2" style="font-size: 48px;">check_circle</span>
<h2 class="text-xl font-bold text-white mb-2">Scan Complete!</h2>
<p class="text-gray-400 text-sm mb-4">Removed <span id="final-dead" class="font-bold text-white">0</span> dead channels. <span id="final-alive" class="font-bold text-white">0</span> working channels remain.</p>
<div class="flex flex-col gap-3 mt-6">
<button onclick="downloadM3U()" class="w-full bg-[#272733] hover:bg-gray-600 text-white font-medium py-3 rounded-xl transition flex items-center justify-center gap-2"><span class="material-icons">download</span> Download .m3u File</button>
<div class="flex gap-2">
<input type="text" id="save-name" placeholder="Name for Panel Source" class="flex-1 bg-[#272733] rounded-xl px-4 py-3 text-sm text-white focus:outline-none">
<button onclick="saveToPanel()" class="bg-[#2D5BE3] hover:bg-blue-500 text-white font-medium px-6 py-3 rounded-xl transition">Save to Panel</button>
</div>
</div>
</div>
</div>
<button onclick="window.close()" class="block w-full text-center mt-4 text-sm text-gray-500 hover:text-white transition">Close Window</button>
</div>
<script>
let currentTab='url',channels=[],workingText="";
function setTab(tab){
currentTab=tab;
['url','file','text'].forEach(t=>{
document.getElementById('input-'+t).classList.add('hidden');
const b=document.getElementById('tab-'+t);
b.classList.remove('bg-[#2D5BE3]','text-white');
b.classList.add('bg-[#272733]','text-gray-400');
});
document.getElementById('input-'+tab).classList.remove('hidden');
const a=document.getElementById('tab-'+tab);
a.classList.remove('bg-[#272733]','text-gray-400');
a.classList.add('bg-[#2D5BE3]','text-white');
}
async function fetchAndParse(){
const btn=document.getElementById('fetch-btn');
btn.innerHTML='<span class="material-icons animate-spin">refresh</span> Preparing...';
btn.disabled=true;
try{
let text="";
if(currentTab==='url'){
const url=document.getElementById('m3u-url').value;
if(!url)throw new Error("Empty URL");
const res=await fetch('?action=proxy&url='+encodeURIComponent(url));
text=await res.text();
}else if(currentTab==='file'){
const file=document.getElementById('m3u-file').files[0];
if(!file)throw new Error("No file selected");
text=await file.text();
}else{
text=document.getElementById('m3u-text').value;
if(!text)throw new Error("Empty text");
}
parseContent(text);
document.getElementById('step-1').classList.add('hidden');
document.getElementById('step-2').classList.remove('hidden');
}catch(e){
alert("Error reading M3U: "+e.message);
btn.innerHTML='<span class="material-icons">radar</span> Fetch & Prepare';
btn.disabled=false;
}
}
function parseContent(text){
channels=[];
const lines=text.split('\\n');
let cb="";
for(let l of lines){
l=l.trim();
if(l===''||l.startsWith('#EXTM3U'))continue;
if(l.startsWith('#')){
cb+=l+"\\n";
}else if(l.startsWith('http')){
channels.push({extinf:cb,url:l});
cb="";
}
}
document.getElementById('stat-total').innerText=channels.length;
}
async function startCleaning(){
document.getElementById('scan-btn').classList.add('hidden');
document.getElementById('progress-container').classList.remove('hidden');
const title=document.getElementById('status-title'),icon=document.getElementById('status-icon');
title.innerText="Testing Streams... Do not close.";
icon.innerText="wifi_tethering";
icon.classList.add('text-blue-500','animate-pulse');
const total=channels.length;
let done=0,alive=0,dead=0;
const batchSize=8;
for(let i=0;i<total;i+=batchSize){
const batch=channels.slice(i,i+batchSize);
await Promise.all(batch.map(async c=>{
try{
const fd=new FormData();
fd.append('url',c.url);
const res=await fetch('?action=test-stream',{method:'POST',body:fd});
if(res.ok){
alive++;
document.getElementById('stat-alive').innerText=alive;
workingText+=c.extinf+c.url+"\\n";
}else{
dead++;
document.getElementById('stat-dead').innerText=dead;
}
}catch(e){
dead++;
document.getElementById('stat-dead').innerText=dead;
}finally{
done++;
document.getElementById('progress-bar').style.width=Math.round((done/total)*100)+'%';
}
}));
}
document.getElementById('step-2').classList.add('hidden');
document.getElementById('step-3').classList.remove('hidden');
document.getElementById('final-dead').innerText=dead;
document.getElementById('final-alive').innerText=alive;
}
function downloadM3U(){
const blob=new Blob(["#EXTM3U\\n"+workingText],{type:'text/plain'});
const a=document.createElement('a');
a.href=URL.createObjectURL(blob);
a.download='cleaned_playlist.m3u';
a.click();
}
async function saveToPanel(){
const name=document.getElementById('save-name').value.trim();
if(!name)return alert("Enter a name first.");
try{
const res=await fetch('?action=save-cleaned-source',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,content:"#EXTM3U\\n"+workingText})});
const data=await res.json();
if(data.status==='success'){
alert("Saved successfully! You can close this tab and refresh the player.");
window.close();
}else{
alert("Failed to save.");
}
}catch(e){
alert("Error saving: "+e.message);
}
}
<\/script>
</body>
</html>`;
}

// ==========================================
// MAIN PLAYER HTML
// ==========================================
function getHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MOE IPTV Player</title>
<meta name="robots" content="nofollow, noindex" />
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
<script>
tailwind.config = {
theme: {
extend: {
colors: {
tv: { bg: '#16161E', panel: '#1A1B26', card: '#242530', cardhover: '#2A2B38', active: '#2D2E3D', muted: '#8F93A2' }
},
fontFamily: { sans: ['Inter', 'sans-serif'] }
}
}
}
<\/script>
<style>
::-webkit-scrollbar { display: none; }
* { -ms-overflow-style: none; scrollbar-width: none; }
body { font-family: "Inter", sans-serif; }
.loader { border: 3px solid rgba(255,255,255,0.1); border-top-color: #fff; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.nav-btn { transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1); }
.nav-btn.is-active {
background: linear-gradient(145deg, rgba(255,255,255,0.15), rgba(255,255,255,0.02));
box-shadow: inset 0 1px 1px rgba(255,255,255,0.4), 0 8px 16px rgba(0,0,0,0.4);
color: #fff; transform: scale(1.1);
}
.category-row { position: relative; opacity: 0.4; transition: opacity 0.3s ease; }
.category-row:hover { opacity: 0.7; }
.category-row.is-active { opacity: 1; }
.category-row .cat-avatar { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 10; }
.category-row.is-active .cat-avatar { transform: scale(1.45) translateX(-5px); }
.category-row .cat-text-container { transition: transform 0.3s ease; }
.category-row.is-active .cat-text-container { transform: translateX(6px); }
.channel-card { position: relative; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 1; }
.channel-card.is-active {
background: linear-gradient(135deg, #363748 0%, #242530 100%);
transform: scale(1.04); z-index: 20;
}
.channel-card.is-active::before {
content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
height: 60%; width: 4px; background-color: #fff;
border-top-right-radius: 4px; border-bottom-right-radius: 4px;
box-shadow: 0 0 12px rgba(255,255,255,0.6);
}
#sidebar { width: 340px; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
#sidebar.collapsed { width: 80px; }
#category-panel { opacity: 1; transition: opacity 0.2s ease-in-out; pointer-events: auto; }
#sidebar.collapsed #category-panel { opacity: 0; pointer-events: none; }
#collapse-icon { transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
#sidebar.collapsed #collapse-icon { transform: rotate(180deg); }
#settings-modal { display: none; }
#settings-modal.open { display: flex; }
</style>
</head>
<body class="bg-tv-bg text-white h-screen overflow-hidden flex selection:bg-gray-700">
<div id="settings-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/70 backdrop-blur-sm p-4">
    <div class="bg-[#1C1D26] border border-[#2A2B36] rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[85vh]">
        <div class="flex items-center justify-between p-6 border-b border-[#2A2B36] shrink-0">
            <div>
                <h2 class="text-lg font-bold">M3U Sources</h2>
                <p class="text-xs text-gray-500 mt-0.5">Add, rename, or remove playlist sources</p>
            </div>
            <button onclick="closeSettings()" class="w-8 h-8 rounded-full bg-[#272733] hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
                <span class="material-icons" style="font-size: 18px;">close</span>
            </button>
        </div>
        
        <div id="sources-list" class="flex-1 overflow-y-auto p-6 space-y-4">
            <div class="flex justify-center py-6"><div class="loader"></div></div>
        </div>
        
        <div class="p-6 border-t border-[#2A2B36] shrink-0">
            <p class="text-[11px] text-gray-500 mb-3 font-semibold uppercase tracking-wider">Add New Source</p>
            <div class="flex flex-col gap-3">
                <input id="new-source-name" type="text" placeholder="Source name (e.g. My Provider)"
                    class="w-full bg-[#272733] rounded-xl px-4 py-3.5 text-sm text-white placeholder-gray-500 border border-transparent focus:border-gray-600 focus:outline-none transition-colors">
                <input id="new-source-url" type="text" placeholder="M3U URL (https://...)"
                    class="w-full bg-[#272733] rounded-xl px-4 py-3.5 text-sm text-white placeholder-gray-500 border border-transparent focus:border-gray-600 focus:outline-none transition-colors font-mono text-xs">
                <button onclick="addSource()" class="w-full bg-white text-black hover:bg-gray-200 transition-colors font-medium py-3.5 rounded-xl text-sm flex items-center justify-center gap-2 shadow-sm">
                    <span class="material-icons" style="font-size: 18px;">add</span> Add Source
                </button>
            </div>
        </div>
        
        <div class="px-6 pb-6 shrink-0">
            <button id="save-sources-btn" onclick="saveSources()" class="w-full bg-[#2D5BE3] hover:bg-blue-600 transition-colors font-medium py-3.5 rounded-xl text-sm flex items-center justify-center gap-2 shadow-sm">
                <span class="material-icons" style="font-size: 18px;">save</span>
                <span id="save-btn-text">Save & Reload Channels</span>
            </button>
        </div>
    </div>
</div>

<div id="sidebar" class="flex h-full shrink-0 bg-tv-bg z-20 overflow-hidden relative">
<div class="w-20 shrink-0 flex flex-col items-center py-10 gap-6 z-30 bg-tv-bg">
<button id="collapse-btn" class="w-10 h-10 rounded-full bg-[#272733] hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors mb-6">
<span id="collapse-icon" class="material-icons" style="font-size: 20px;">chevron_left</span>
</button>
<button id="nav-home" class="nav-btn is-active w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-white" title="Live TV">
<span class="material-icons">live_tv</span>
</button>
<button id="nav-fav" class="nav-btn w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-white" title="Favorites">
<span class="material-icons">star</span>
</button>
<button id="nav-settings" class="nav-btn w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-white" title="M3U Sources">
<span class="material-icons">settings</span>
</button>
<a href="?action=cleaner" target="_blank" class="nav-btn w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-white" title="Dead Link Cleaner">
<span class="material-icons">cleaning_services</span>
</a>
<a href="?action=logout" class="nav-btn mt-auto w-12 h-12 rounded-full flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-500/10" title="Logout">
<span class="material-icons">logout</span>
</a>
</div>
<div id="category-panel" class="w-[260px] min-w-[260px] shrink-0 flex flex-col py-10 px-4 relative z-10">
<div class="mb-6 px-4">
<h2 id="category-header" class="text-xl font-bold tracking-tight whitespace-nowrap">Live TV's</h2>
<p id="total-channels-count" class="text-xs text-gray-500 mt-1">Loading ...</p>
</div>
<div id="category-list" class="flex-1 overflow-y-auto space-y-3 pr-2 pb-4 pt-1 px-1">
<div class="flex justify-center mt-10"><div class="loader"></div></div>
</div>
</div>
</div>

<div class="w-[380px] shrink-0 bg-tv-panel flex flex-col py-10 px-6 z-10 relative">
<div class="relative mb-6">
<span class="material-icons absolute left-3 top-2.5 text-gray-500" style="font-size: 18px;">search</span>
<input type="text" id="search-bar" placeholder="Search channels..."
class="w-full bg-tv-card border border-transparent rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600 transition-colors">
</div>
<div id="channel-list" class="flex-1 overflow-y-auto flex flex-col gap-3 pr-2 pt-1 pb-4 px-1">
<div class="text-sm text-gray-500 mt-4 px-2">Select a category to view channels.</div>
</div>
</div>

<div class="flex-1 relative bg-black flex flex-col justify-end transition-all duration-300 z-0">
<video id="video-player" class="absolute inset-0 w-full h-full object-contain z-0" controls autoplay></video>
<div id="now-playing-container" class="absolute inset-0 z-10 flex flex-col justify-end opacity-0 transition-opacity duration-1000 pointer-events-none">
<div class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-0"></div>
<div class="relative z-10 p-12 pb-24 w-4/5">
<div class="flex items-center gap-3 mb-2 drop-shadow">
<p class="text-gray-400 text-sm font-semibold tracking-wider uppercase">Now Playing</p>
<span class="text-red-500 text-[10px] font-bold tracking-widest flex items-center gap-1.5 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20 shadow-sm">
<span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.8)]"></span> LIVE
</span>
</div>
<h1 id="np-title" class="text-4xl font-bold mb-3 text-white tracking-tight drop-shadow-lg">Select a channel</h1>
<p class="text-gray-300 text-sm leading-relaxed max-w-2xl drop-shadow-md">Enjoy premium live television. Select a channel from the list on the left to begin streaming immediately.</p>
</div>
</div>
</div>

<script>
const video = document.getElementById('video-player');
const categoryListEl = document.getElementById('category-list');
const channelListEl = document.getElementById('channel-list');
const categoryHeader = document.getElementById('category-header');
const searchInput = document.getElementById('search-bar');
const nowPlayingContainer = document.getElementById('now-playing-container');
const npTitle = document.getElementById('np-title');
const navHome = document.getElementById('nav-home');
const navFav = document.getElementById('nav-fav');
const navSettings = document.getElementById('nav-settings');
const sidebar = document.getElementById('sidebar');
const collapseBtn = document.getElementById('collapse-btn');
const settingsModal = document.getElementById('settings-modal');

let hls;
let globalChannelsData = [];
let categories = {};
let activeCategoryBtn = null;
let activeChannelBtn = null;
const channelNodeCache = {};

const getFavorites = () => JSON.parse(localStorage.getItem('iptv_favorites')) || [];
const saveFavorites = (f) => localStorage.setItem('iptv_favorites', JSON.stringify(f));

if (localStorage.getItem('iptv_sidebar_collapsed') === 'true') {
    sidebar.classList.add('collapsed');
}

collapseBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('iptv_sidebar_collapsed', sidebar.classList.contains('collapsed'));
});

loadChannels();

function loadChannels() {
    categoryListEl.innerHTML = '<div class="flex justify-center mt-10"><div class="loader"></div></div>';
    channelListEl.innerHTML = '<div class="text-sm text-gray-500 mt-4 px-2">Loading channels...</div>';
    document.getElementById('total-channels-count').innerText = 'Loading ...';
    fetch('?action=channels')
        .then(r => r.json())
        .then(channels => {
            globalChannelsData = channels;
            processData();
        });
}

function processData() {
    categories = {};
    globalChannelsData.forEach(ch => {
        const g = ch.group || 'Uncategorized';
        if (!categories[g]) categories[g] = [];
        categories[g].push(ch);
    });
    document.getElementById('total-channels-count').innerText = \`\${globalChannelsData.length} Channels\`;
    renderCategories();
    const firstBtn = categoryListEl.querySelector('button');
    if (firstBtn) firstBtn.click();
}

function renderCategories() {
    categoryListEl.innerHTML = '';
    const colors = ['bg-blue-500','bg-red-500','bg-green-500','bg-yellow-500','bg-purple-500','bg-pink-500','bg-indigo-500'];
    Object.keys(categories).forEach(groupName => {
        const groupChannels = categories[groupName];
        if (!groupChannels.length) return;
        const colorClass = colors[groupName.length % colors.length];
        const initial = groupName.charAt(0).toUpperCase();
        
        // Replace the " > " separator with a Material Icon
        const displayGroupName = groupName.replace(' > ', '<span class="material-icons align-middle text-gray-400" style="font-size: 16px; margin: -2px 2px 0 2px;">chevron_right</span>');
        
        const btn = document.createElement('button');
        btn.className = "category-row w-full text-left p-3 flex items-center gap-4 focus:outline-none cursor-pointer";
        btn.innerHTML = \`
        <div class="cat-avatar w-8 h-8 rounded-full \${colorClass} flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-inner">\${initial}</div>
        <div class="cat-text-container flex flex-col overflow-hidden">
            <span class="text-sm font-medium text-white truncate">\${displayGroupName}</span>
            <span class="text-[11px] text-gray-500 mt-0.5">\${groupChannels.length} Channels</span>
        </div>
        \`;
        
        btn.onclick = () => {
            if (activeCategoryBtn) activeCategoryBtn.classList.remove('is-active');
            btn.classList.add('is-active');
            activeCategoryBtn = btn;
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
            navHome.classList.add('is-active');
            categoryHeader.innerText = "Live TV's";
            document.getElementById('total-channels-count').innerText = \`\${globalChannelsData.length} Channels\`;
            searchInput.value = '';
            renderChannels(groupChannels);
        };
        categoryListEl.appendChild(btn);
    });
}

function renderFavorites() {
    if (activeCategoryBtn) activeCategoryBtn.classList.remove('is-active');
    activeCategoryBtn = null;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
    navFav.classList.add('is-active');
    categoryHeader.innerText = "Favorites";
    searchInput.value = '';
    const favChannels = globalChannelsData.filter(ch => getFavorites().includes(ch.id));
    document.getElementById('total-channels-count').innerText = \`\${favChannels.length} Channels\`;
    renderChannels(favChannels);
}

function renderChannels(channelsArray) {
    channelListEl.innerHTML = '';
    if (!channelsArray.length) {
        channelListEl.innerHTML = '<div class="text-sm text-gray-500 p-4 text-center">No channels found.</div>';
        return;
    }
    const fragment = document.createDocumentFragment();
    channelsArray.forEach(ch => {
        let btn;
        if (channelNodeCache[ch.id]) {
            btn = channelNodeCache[ch.id];
            if (activeChannelBtn && activeChannelBtn.dataset.id === ch.id) { btn.classList.add('is-active'); activeChannelBtn = btn; }
            else btn.classList.remove('is-active');
            
            const starEl = btn.querySelector('.star-btn');
            const isFav = getFavorites().includes(ch.id);
            if (isFav) {
                starEl.classList.remove('text-gray-600','hover:text-[#E87A31]');
                starEl.classList.add('text-[#E87A31]');
                starEl.innerHTML = '<span class="material-icons" style="font-size:18px;">star</span>';
            } else {
                starEl.classList.remove('text-[#E87A31]');
                starEl.classList.add('text-gray-600','hover:text-[#E87A31]');
                starEl.innerHTML = '<span class="material-icons" style="font-size:18px;">star_border</span>';
            }
        } else {
            btn = document.createElement('button');
            btn.className = "channel-card w-full text-left bg-tv-card hover:bg-tv-cardhover rounded-xl p-3 flex items-center gap-4 focus:outline-none cursor-pointer shadow-sm";
            if (activeChannelBtn && activeChannelBtn.dataset.id === ch.id) { btn.classList.add('is-active'); activeChannelBtn = btn; }
            btn.dataset.id = ch.id;
            
            const safeLogoUrl = ch.logo ? '?action=logo&url=' + encodeURIComponent(ch.logo) : '';
            const logoHtml = ch.logo
                ? \`<img src="\${safeLogoUrl}" loading="lazy" class="w-full h-full object-contain" onerror="this.outerHTML='<span class=\\'text-xs font-bold\\'>\${ch.name.charAt(0)}</span>'"/>\`
                : \`<span class="text-xs font-bold text-gray-400">\${ch.name.charAt(0)}</span>\`;
            
            const isFav = getFavorites().includes(ch.id);
            const starColor = isFav ? "text-[#E87A31]" : "text-gray-600 hover:text-[#E87A31]";
            const starIcon = isFav ? "star" : "star_border";
            
            let badgesHtml = '';
            if (ch.is_hd) badgesHtml += '<span class="text-[8px] flex items-center font-bold bg-white text-black px-1 rounded-sm shadow-sm">HD</span>';
            if (ch.has_epg) badgesHtml += '<span class="text-[8px] flex items-center font-bold bg-gray-600 text-white px-1 rounded-sm shadow-sm">EPG</span>';
            
            const sourceBadge = ch.source
                ? \`<span class="text-[8px] flex items-center font-bold bg-blue-900/60 text-blue-300 px-1 rounded-sm truncate max-w-[80px] shadow-sm">\${ch.source}</span>\`
                : '';
                
            btn.innerHTML = \`
            <div class="w-14 h-14 bg-[#1C1D26] border border-[#2D2E3D] rounded flex items-center justify-center shrink-0 overflow-hidden shadow-inner">\${logoHtml}</div>
            <div class="flex-1 flex flex-col overflow-hidden py-1">
                <span class="text-sm font-semibold text-white truncate">\${ch.name}</span>
                <span class="text-[10px] text-tv-muted mt-1 truncate">Live Stream</span>
                <div class="flex gap-1 mt-2 min-h-[16px] flex-wrap">\${badgesHtml}\${sourceBadge}</div>
            </div>
            <div class="star-btn p-2 shrink-0 \${starColor} transition-colors" data-id="\${ch.id}">
                <span class="material-icons" style="font-size: 18px;">\${starIcon}</span>
            </div>
            \`;
            
            let hideBannerTimeout;
            btn.onclick = (e) => {
                if (e.target.closest('.star-btn')) return;
                if (activeChannelBtn) activeChannelBtn.classList.remove('is-active');
                btn.classList.add('is-active'); activeChannelBtn = btn;
                npTitle.innerText = ch.name;
                nowPlayingContainer.classList.remove('opacity-0');
                clearTimeout(hideBannerTimeout);
                hideBannerTimeout = setTimeout(() => nowPlayingContainer.classList.add('opacity-0'), 4000);
                playStream(\`?action=proxy&url=\${encodeURIComponent(ch.url)}\`);
            };
            
            const starEl = btn.querySelector('.star-btn');
            starEl.onclick = (e) => {
                e.stopPropagation();
                let favs = getFavorites();
                if (favs.includes(ch.id)) {
                    favs = favs.filter(id => id !== ch.id);
                    if (navFav.classList.contains('is-active')) { 
                        btn.remove(); 
                        document.getElementById('total-channels-count').innerText = \`\${favs.length} Channels\`; 
                    } else { 
                        starEl.classList.remove('text-[#E87A31]'); 
                        starEl.classList.add('text-gray-600','hover:text-[#E87A31]'); 
                        starEl.innerHTML = '<span class="material-icons" style="font-size:18px;">star_border</span>'; 
                    }
                } else {
                    favs.push(ch.id);
                    starEl.classList.remove('text-gray-600','hover:text-[#E87A31]'); 
                    starEl.classList.add('text-[#E87A31]');
                    starEl.innerHTML = '<span class="material-icons" style="font-size:18px;">star</span>';
                }
                saveFavorites(favs);
            };
            channelNodeCache[ch.id] = btn;
        }
        fragment.appendChild(btn);
    });
    channelListEl.appendChild(fragment);
}

navFav.addEventListener('click', renderFavorites);
navHome.addEventListener('click', () => {
    if (activeCategoryBtn) activeCategoryBtn.click();
    else { const fb = categoryListEl.querySelector('button'); if (fb) fb.click(); }
});

searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (query === '') {
        if (navFav.classList.contains('is-active')) { renderFavorites(); }
        else if (activeCategoryBtn) { activeCategoryBtn.click(); }
        return;
    }
    const filtered = globalChannelsData.filter(ch => ch.name.toLowerCase().includes(query));
    categoryHeader.innerText = "Search Results";
    document.getElementById('total-channels-count').innerText = \`\${filtered.length} Channels found\`;
    renderChannels(filtered);
});

function playStream(url) {
    if (Hls.isSupported()) {
        if (hls) hls.destroy();
        hls = new Hls({ maxBufferSize: 0, maxBufferLength: 30, liveSyncDurationCount: 3 });
        hls.loadSource(url); 
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url; 
        video.play();
    }
}

// ==========================================
// SETTINGS MENU
// ==========================================
let sourcesData = [];
let previousNav = null;

navSettings.addEventListener('click', openSettings);

function openSettings() {
    previousNav = navFav.classList.contains('is-active') ? navFav : navHome;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
    navSettings.classList.add('is-active');
    settingsModal.classList.add('open');
    loadSources();
}

function closeSettings() {
    settingsModal.classList.remove('open');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('is-active'));
    if (previousNav === navFav) { navFav.classList.add('is-active'); } 
    else { navHome.classList.add('is-active'); }
}

settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeSettings(); });

async function loadSources() {
    document.getElementById('sources-list').innerHTML = '<div class="flex justify-center py-6"><div class="loader"></div></div>';
    const res = await fetch('?action=get-sources');
    sourcesData = await res.json();
    renderSources();
}

function renderSources() {
    const list = document.getElementById('sources-list');
    if (!sourcesData.length) {
        list.innerHTML = '<p class="text-sm text-gray-500 text-center py-4">No sources yet. Add one below.</p>';
        return;
    }
    list.innerHTML = '';
    sourcesData.forEach((src, idx) => {
        const item = document.createElement('div');
        const count = globalChannelsData.filter(ch => ch.source === src.name).length;
        item.className = "source-item flex items-start gap-3 p-3 rounded-xl";
        item.innerHTML = \`
        <div class="w-10 h-10 rounded-full bg-[#2D5BE3] flex items-center justify-center text-white text-sm font-bold shrink-0 mt-1 shadow-inner">\${idx + 1}</div>
        <div class="flex-1 min-w-0 flex flex-col gap-2">
            <div class="flex items-center gap-2">
                <input class="src-name w-full bg-[#272733] rounded-xl px-4 py-3 text-sm text-white font-medium border border-transparent focus:border-gray-600 focus:outline-none" 
                    value="\${escHtml(src.name)}" placeholder="Source name" data-idx="\${idx}">
                <span class="text-[11px] text-gray-400 bg-[#242530] border border-[#2A2B36] px-2.5 py-1.5 rounded-lg shrink-0 font-medium font-sans shadow-sm">\${count} Ch</span>
            </div>
            <input class="src-url w-full bg-[#272733] rounded-xl px-4 py-3 text-xs text-gray-400 font-mono border border-transparent focus:border-gray-600 focus:outline-none" 
                value="\${escHtml(src.url)}" placeholder="M3U URL" data-idx="\${idx}">
        </div>
        <button onclick="removeSource(\${idx})" class="w-10 h-10 rounded-full hover:bg-red-500/10 flex items-center justify-center text-gray-500 hover:text-red-400 transition-colors shrink-0 mt-1">
            <span class="material-icons" style="font-size:20px;">delete</span>
        </button>
        \`;
        item.querySelector('.src-name').addEventListener('input', e => { sourcesData[idx].name = e.target.value; });
        item.querySelector('.src-url').addEventListener('input', e => { sourcesData[idx].url = e.target.value; });
        list.appendChild(item);
    });
}

function addSource() {
    const nameEl = document.getElementById('new-source-name');
    const urlEl = document.getElementById('new-source-url');
    const name = nameEl.value.trim();
    const url = urlEl.value.trim();
    if (!name || !url) { alert('Please fill in both a name and a URL.'); return; }
    sourcesData.push({ id: 'src_' + Date.now(), name, url });
    nameEl.value = ''; urlEl.value = '';
    renderSources();
}

function removeSource(idx) {
    sourcesData.splice(idx, 1);
    renderSources();
}

async function saveSources() {
    for (const src of sourcesData) {
        if (!src.name.trim() || !src.url.trim()) { alert('All sources must have a name and URL.'); return; }
    }
    const btn = document.getElementById('save-sources-btn');
    const text = document.getElementById('save-btn-text');
    btn.disabled = true; text.innerText = 'Saving...';
    try {
        const res = await fetch('?action=save-sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: sourcesData })
        });
        const data = await res.json();
        if (data.status === 'success') {
            text.innerText = 'Saved! Reloading channels...';
            Object.keys(channelNodeCache).forEach(k => delete channelNodeCache[k]);
            setTimeout(() => {
                closeSettings();
                loadChannels();
                btn.disabled = false; text.innerText = 'Save & Reload Channels';
            }, 800);
        } else {
            alert('Save failed: ' + (data.message || 'Unknown error'));
            btn.disabled = false; text.innerText = 'Save & Reload Channels';
        }
    } catch(e) {
        alert('Network error while saving.');
        btn.disabled = false; text.innerText = 'Save & Reload Channels';
    }
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

<\/script>
</body>
</html>`;
}