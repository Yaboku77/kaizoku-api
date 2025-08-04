const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const CryptoJS = require('crypto-js');

const app = express();

// Use CORS to allow cross-origin requests
app.use(cors({ origin: '*' }));

// --- CONFIGURATION ---
const ANIME_BASE_URL = 'https://hianime.bz';

// --- SOURCE EXTRACTOR (for VidCloud/MegaCloud) ---
// This is the most complex part. It handles decrypting the video sources.
const getSources = async (url) => {
    try {
        const res = await axios.get(url);
        const script = res.data.match(/sources = (\[.*?\])/);
        const sources = JSON.parse(script[1]);

        const a = res.data.match(/const a = '(.*?)'/)[1];
        const b = res.data.match(/const b = '(.*?)'/)[1];
        const c = res.data.match(/const c = '(.*?)'/)[1];

        const key = CryptoJS.enc.Utf8.parse(a);
        const iv = CryptoJS.enc.Utf8.parse(b);

        const decryptedSources = CryptoJS.AES.decrypt(sources, key, { iv }).toString(CryptoJS.enc.Utf8);
        const parsedSources = JSON.parse(decryptedSources);

        const subtitles = parsedSources.tracks.filter(track => track.kind === 'captions');
        const videoSources = parsedSources.sources.map(source => ({
            url: source.file,
            quality: source.label,
            isM3U8: source.file.includes('.m3u8'),
        }));

        return { subtitles, sources: videoSources };
    } catch (error) {
        console.error("Source Extraction Error:", error.message);
        throw new Error("Failed to extract sources.");
    }
};

// --- API ROUTES ---

// Root endpoint
app.get('/', (req, res) => {
    res.status(200).json({
        message: 'Welcome to Kaizoku-API!',
        routes: {
            search: '/search?q={query}',
            info: '/info?id={anime-id}',
            servers: '/servers?episodeId={episode-id}',
            sources: '/sources?id={server-id}',
            'recent-episodes': '/recent-episodes',
            'top-airing': '/top-airing',
        },
        author: 'Gemini',
    });
});

// Search for anime
app.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: 'Search query "q" is required.' });

        const { data } = await axios.get(`${ANIME_BASE_URL}/search?keyword=${encodeURIComponent(query)}`);
        const $ = cheerio.load(data);
        const results = [];

        $('.flw-item').each((i, el) => {
            const item = $(el);
            results.push({
                id: item.find('.film-poster-ahref').attr('href')?.split('?')[0].substring(1),
                title: item.find('.film-name a').attr('title'),
                image: item.find('.film-poster-img').attr('data-src'),
                type: item.find('.fdi-item').first().text().trim(),
                duration: item.find('.fdi-item.fdi-duration').text().trim(),
                rating: item.find('.fdi-item.fdi-rating').text().trim(),
            });
        });

        res.status(200).json(results);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch search results.' });
    }
});

// Get anime information
app.get('/info', async (req, res) => {
    try {
        const animeId = req.query.id;
        if (!animeId) return res.status(400).json({ error: 'Anime ID "id" is required.' });

        const { data } = await axios.get(`${ANIME_BASE_URL}/${animeId}`);
        const $ = cheerio.load(data);

        const internalId = $('#wrapper').attr('data-id');
        if (!internalId) return res.status(404).json({ error: 'Could not find internal ID.' });

        // Fetch episodes
        const episodesResponse = await axios.get(`${ANIME_BASE_URL}/ajax/v2/episode/list/${internalId}`);
        const $$ = cheerio.load(episodesResponse.data.html);
        const episodes = [];
        $$('.ss-list a').each((i, el) => {
            episodes.push({
                id: $$(el).attr('href')?.split('/').pop(),
                title: $$(el).attr('title'),
                number: $$(el).data('number'),
            });
        });

        const info = {
            id: animeId,
            title: $('.film-name.dynamic-name').text().trim(),
            image: $('.film-poster-img').attr('src'),
            description: $('.film-description .text').text().trim(),
            genres: $('.item-list a[href*="/genre/"]').map((i, el) => $(el).text().trim()).get(),
            status: $('.item-title:contains("Status:")').next().text().trim(),
            totalEpisodes: episodes.length,
            episodes: episodes.reverse(), // Often makes more sense to have episode 1 first
        };

        res.status(200).json(info);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch anime info.' });
    }
});

// Get episode servers
app.get('/servers', async (req, res) => {
    try {
        const episodeId = req.query.episodeId;
        if (!episodeId) return res.status(400).json({ error: 'Episode ID "episodeId" is required.' });

        const { data } = await axios.get(`${ANIME_BASE_URL}/ajax/v2/episode/servers?episodeId=${episodeId}`);
        const $ = cheerio.load(data.html);
        const servers = [];

        $('.server-item').each((i, el) => {
            servers.push({
                name: $(el).find('a').text().trim(),
                type: $(el).data('type'), // sub or dub
                serverId: $(el).data('id'),
            });
        });

        res.status(200).json(servers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch episode servers.' });
    }
});

// Get video sources and subtitles
app.get('/sources', async (req, res) => {
    try {
        const serverId = req.query.id;
        if (!serverId) return res.status(400).json({ error: 'Server ID "id" is required.' });

        const { data } = await axios.get(`${ANIME_BASE_URL}/ajax/v2/episode/sources?id=${serverId}`);
        const embedUrl = data.link;

        if (!embedUrl) return res.status(404).json({ error: 'Could not find embed URL.' });
        
        const result = await getSources(embedUrl);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch sources.' });
    }
});

// Get recent episodes
app.get('/recent-episodes', async (req, res) => {
    try {
        const { data } = await axios.get(`${ANIME_BASE_URL}/home`);
        const $ = cheerio.load(data);
        const results = [];

        $('#main-content .film_list-wrap .flw-item').each((i, el) => {
            const item = $(el);
            results.push({
                id: item.find('.film-poster-ahref').attr('href')?.substring(1),
                episodeId: item.find('.film-poster-ahref').attr('href')?.split('/').pop(),
                episodeNumber: parseInt(item.find('.tick-item.tick-sub').text().trim() || item.find('.tick-item.tick-dub').text().trim().replace('Ep', '')),
                title: item.find('.film-name a').attr('title'),
                image: item.find('.film-poster-img').attr('data-src'),
            });
        });
        res.status(200).json(results);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recent episodes.' });
    }
});

// Get top airing anime
app.get('/top-airing', async (req, res) => {
    try {
        const { data } = await axios.get(`${ANIME_BASE_URL}/top-airing`);
        const $ = cheerio.load(data);
        const results = [];

        $('.flw-item').each((i, el) => {
            const item = $(el);
            results.push({
                id: item.find('.film-poster-ahref').attr('href')?.substring(1),
                title: item.find('.film-name a').attr('title'),
                image: item.find('.film-poster-img').attr('data-src'),
                genres: item.find('.fd-infor .fdi-item').map((i, el) => $(el).text().trim()).get(),
            });
        });
        res.status(200).json(results);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch top airing anime.' });
    }
});

// --- SERVER INITIALIZATION ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Kaizoku-API is running on http://localhost:${PORT}`);
});

// Export the app for Vercel
module.exports = app;
      
