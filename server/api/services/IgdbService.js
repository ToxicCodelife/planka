const { request } = require('undici');

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_URL = 'https://api.igdb.com/v4/covers';

let accessToken;
let tokenExpiresAt = 0;

module.exports = {
  async getCoverUrl(gameName) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!clientId || !clientSecret || !gameName) {
      return null;
    }

    const token = await this.getAccessToken(clientId, clientSecret);
    const response = await request(IGDB_URL, {
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: `search ${JSON.stringify(gameName)}; fields url; limit 1;`,
    });

    if (response.statusCode >= 400) {
      throw new Error(`IGDB cover lookup failed with status ${response.statusCode}`);
    }

    const [cover] = await response.body.json();
    if (!cover || !cover.url) {
      return null;
    }

    const coverUrl = cover.url.replace('t_thumb', 't_cover_big');
    return coverUrl.startsWith('//') ? `https:${coverUrl}` : coverUrl;
  },

  async getAccessToken(clientId, clientSecret) {
    if (accessToken && tokenExpiresAt > Date.now() + 60000) {
      return accessToken;
    }

    const response = await request(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }).toString(),
    });

    if (response.statusCode >= 400) {
      throw new Error(`Twitch token request failed with status ${response.statusCode}`);
    }

    const tokenData = await response.body.json();
    accessToken = tokenData.access_token;
    tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
    return accessToken;
  },
};
