import express from 'express';
import { spawn } from 'child_process';
import { exchangeCode as spotifyExchange, generatePKCE, getAuthUrl as spotifyAuthUrl } from './spotify-auth.js';
import { exchangeCode as youtubeExchange, getAuthUrl as youtubeAuthUrl } from './youtube-auth.js';

const AUTH_PORT = parseInt(process.env.AUTH_PORT ?? '8888');

// Start the OAuth callback server, open the given service's auth URL, return tokens
export async function runOAuthFlow(service) {
  return new Promise((resolve, reject) => {
    const app = express();
    let pkceVerifier = null;

    const server = app.listen(AUTH_PORT, async () => {
      let authUrl;
      try {
        if (service === 'spotify') {
          const { verifier, challenge } = generatePKCE();
          pkceVerifier = verifier;
          authUrl = spotifyAuthUrl(challenge);
        } else if (service === 'youtube') {
          authUrl = youtubeAuthUrl();
        } else {
          server.close();
          return reject(new Error(`Unknown service: ${service}`));
        }
        console.log(`\n[Auth] Opening browser for ${service} OAuth...\n${authUrl}\n`);
        openBrowser(authUrl);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    app.get(`/callback/${service}`, async (req, res) => {
      const { code, error } = req.query;
      if (error) {
        res.send(`<h2>Auth failed: ${error}</h2>`);
        server.close();
        return reject(new Error(`OAuth error: ${error}`));
      }
      try {
        let tokens;
        if (service === 'spotify') tokens = await spotifyExchange(code, pkceVerifier);
        else if (service === 'youtube') tokens = await youtubeExchange(code);

        res.send(`<h2>✓ ${service} connected!</h2><p>You can close this tab.</p><script>window.close()</script>`);
        server.close();
        resolve(tokens);
      } catch (err) {
        res.send(`<h2>Error: ${err.message}</h2>`);
        server.close();
        reject(err);
      }
    });

    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (5 min)')); }, 300_000);
  });
}

function openBrowser(url) {
  const proc = spawn('open', [url]);
  proc.on('error', () => console.log('Could not open browser automatically. Visit the URL above.'));
}
