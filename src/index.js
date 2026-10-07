const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_MUSIC_CLIENT_VERSION = "1.20260928.13.00";
const requestCache = new Map();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithRetries(input, init = {}, options = {}) {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelay ?? 250;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        return response;
      }
      lastError = new Error(`Request returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts - 1) await sleep(baseDelay * 2 ** attempt);
  }

  throw lastError || new Error("Request failed");
}

function emptyLyrics() {
  return { meta: null, syncedLyrics: null, plainLyrics: null };
}

function hasSyncedLyricTimestamps(syncedLyrics) {
  return String(syncedLyrics || "")
    .split(/\r?\n/)
    .some((line) => /^\[\d+:\d+(?:\.\d+)?\]/.test(line));
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function buildLyricsFile({ title, artist, album, duration, instrumental, plainLyrics, syncedLyrics }) {
  const durationMs = Math.max(0, Math.round(Number(duration || 0) * 1000));
  const parsedLines = [];
  const timestampPattern = /\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/;

  for (const line of String(syncedLyrics || "").split(/\r?\n/)) {
    const match = line.match(timestampPattern);
    if (!match) continue;
    parsedLines.push({
      text: match[3],
      startMs: Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000),
    });
  }

  const lines = parsedLines.map((line, index) => ({
    ...line,
    endMs: parsedLines[index + 1]?.startMs ?? durationMs,
  }));
  const output = [
    "version: '1.0'",
    "metadata:",
    `  title: ${yamlString(title)}`,
    `  artist: ${yamlString(artist)}`,
    `  album: ${yamlString(album)}`,
    `  duration_ms: ${durationMs}`,
    `  instrumental: ${Boolean(instrumental)}`,
    "lines:",
  ];

  for (const line of lines) {
    output.push(`- text: ${yamlString(line.text)}`);
    output.push(`  start_ms: ${line.startMs}`);
    output.push(`  end_ms: ${line.endMs}`);
  }

  output.push("plain: |-");
  for (const line of String(plainLyrics || "").split(/\r?\n/)) {
    output.push(`  ${line}`);
  }
  return output.join("\n");
}

function toLyricsSchema({ title, artist, lyrics, durationOverride }) {
  const meta = lyrics?.meta || {};
  const trackName = meta.trackName || title;
  const artistName = meta.artistName || artist;
  const albumName = meta.albumName || "";
  const plainLyrics = lyrics?.plainLyrics ?? meta.plainLyrics ?? null;
  const syncedLyrics = lyrics?.syncedLyrics ?? meta.syncedLyrics ?? null;
  const duration = durationOverride ?? Number(meta.duration || 0);
  const instrumental = Boolean(meta.instrumental);

  return {
    id: meta.id ?? null,
    name: meta.name || trackName,
    trackName,
    artistName,
    albumName,
    duration,
    instrumental,
    hasWordSync: meta.hasWordSync ?? false,
    plainLyrics,
    syncedLyrics,
    lyricsfile: buildLyricsFile({
      title: trackName,
      artist: artistName,
      album: albumName,
      duration,
      instrumental,
      plainLyrics,
      syncedLyrics,
    }),
  };
}

function getMusicAuthorUrl(authorUrl) {
  if (!authorUrl) return "";

  try {
    const url = new URL(authorUrl);
    if (url.hostname === "www.youtube.com" || url.hostname === "youtube.com") {
      url.hostname = "music.youtube.com";
    }
    return url.toString();
  } catch {
    return authorUrl;
  }
}

async function getPlayerMetadata(videoId) {
  const response = await fetchWithRetries(
    "https://music.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            hl: "en-GB",
            gl: "IN",
            clientName: "WEB_REMIX",
            clientVersion: YOUTUBE_MUSIC_CLIENT_VERSION,
          },
        },
      }),
    },
  );
  const data = await response.json();
  return {
    title: data.videoDetails?.title ?? null,
    artist: data.videoDetails?.author ?? null,
  };
}

async function getOEmbedMetadata(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://youtube.com/watch?v=${videoId}`)}&format=json`;
  const response = await fetchWithRetries(url);
  return response.json();
}

async function getLyricsFromTrackInfo(videoId, title, artist, expectedDuration) {
  let hasMadeLrclibRequest = false;
  const fetchLrclib = async (input) => {
    if (hasMadeLrclibRequest) await sleep(200);
    hasMadeLrclibRequest = true;
    return fetchWithRetries(input);
  };

  const search = async (query) => {
    const url = `https://lrclib.net/api/search?${new URLSearchParams({ q: query })}`;
    const response = await fetchLrclib(url);
    return response.json();
  };

  try {
    let results = await search(`${title} ${artist}`);

    // This is Loop's fallback: retry with the title alone when the artist query misses.
    if (!results?.[0] && artist.trim()) {
      results = await search(title);
    }

    let lyricResults = results?.filter((result) => result?.id) || [];
    if (expectedDuration !== undefined) {
      lyricResults = lyricResults.filter((result) => {
        const resultDuration = Number(result.duration);
        return Number.isFinite(resultDuration) && resultDuration <= expectedDuration;
      });
    }
    if (!lyricResults.length) return emptyLyrics();

    let firstResultLyrics = null;
    for (const [resultIndex, result] of lyricResults.entries()) {
      const response = await fetchLrclib(`https://lrclib.net/api/get/${result.id}`);
      const meta = await response.json();
      const syncedLyrics = meta?.syncedLyrics || result.syncedLyrics || null;
      const plainLyrics = meta?.plainLyrics || result.plainLyrics || null;
      const lyrics = {
        meta,
        syncedLyrics: meta?.instrumental && !syncedLyrics && !plainLyrics
          ? "[00:00.00] Instrumental only\n[99:99.99] ♫"
          : syncedLyrics,
        plainLyrics,
      };

      firstResultLyrics ||= lyrics;
      if (hasSyncedLyricTimestamps(lyrics.syncedLyrics) || meta?.instrumental) {
        return lyrics;
      }

      if ((meta?.hasWordSync ?? result.hasWordSync) === false) continue;
      void resultIndex;
    }

    return firstResultLyrics || emptyLyrics();
  } catch {
    return null;
  }
}

async function resolveTrack(videoId, expectedDuration) {
  const cacheKey = `${videoId}:${expectedDuration ?? "default"}`;
  if (requestCache.has(cacheKey)) return requestCache.get(cacheKey);

  const pending = (async () => {
    const details = await getOEmbedMetadata(videoId);
    let playerMetadata = null;
    try {
      playerMetadata = await getPlayerMetadata(videoId);
    } catch {
      // oEmbed remains the metadata fallback if the player endpoint is unavailable.
    }

    const authorName = String(details.author_name || "")
      .replace(/\s*[-–—]\s*Topic$/i, "")
      .trim();
    const title = details.title || playerMetadata?.title || "Unknown track";
    const artist = playerMetadata?.artist || authorName || details.author_name || "Unknown artist";
    const lyrics = await getLyricsFromTrackInfo(videoId, title, authorName || artist, expectedDuration);

    return toLyricsSchema({
      title,
      artist,
      lyrics: lyrics || emptyLyrics(),
      durationOverride: expectedDuration,
    });
  })();

  requestCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    requestCache.delete(cacheKey);
    throw error;
  }
}

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...init.headers,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, environment: env.ENVIRONMENT });
    }

    if (url.pathname === "/api" && request.method === "GET") {
      return json({ name: "groove-api", version: "0.1.0" });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({ message: "Welcome to the Groove API! usage documentation available at https://github.com/loop-mp3/groove/blob/main/docs/USAGE.md" });
    }
    const trackMatch = url.pathname.match(/^\/api\/v1\/track\/([^/]+)$/);
    if (trackMatch && request.method === "GET") {
      const videoId = decodeURIComponent(trackMatch[1]);
      if (!YOUTUBE_ID_PATTERN.test(videoId)) {
        return json({ error: "Invalid YouTube video ID" }, { status: 400 });
      }

      const durationParam = url.searchParams.get("duration");
      const expectedDuration = durationParam === null ? undefined : Number(durationParam);
      if (
        expectedDuration !== undefined &&
        (!Number.isFinite(expectedDuration) || expectedDuration < 0)
      ) {
        return json({ error: "Invalid duration" }, { status: 400 });
      }

      try {
        return json(await resolveTrack(videoId, expectedDuration));
      } catch (error) {
        return json({ error: "Could not resolve track metadata" }, { status: 502 });
      }
    }

    return json({ error: "Not found" }, { status: 404 });
  },
};
