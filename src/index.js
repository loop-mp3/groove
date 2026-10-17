const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_MUSIC_CLIENT_VERSION = "1.20260928.13.00";
const requestCache = new Map();
const cachedAt = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

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
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const retryAfterDate = retryAfterHeader ? Date.parse(retryAfterHeader) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : Number.isFinite(retryAfterDate)
          ? Math.max(0, retryAfterDate - Date.now())
          : 0;
      lastError = new Error(`Request returned ${response.status}`);
      lastError.status = response.status;
      lastError.retryAfterMs = retryAfterMs;
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts - 1) {
      const retryAfterMs = Number(lastError?.retryAfterMs) || 0;
      const delay = retryAfterMs > 0
        ? Math.min(retryAfterMs, options.maxRetryAfter ?? 2000)
        : baseDelay * 2 ** attempt;
      await sleep(delay);
    }
  }

  throw lastError || new Error("Request failed");
}

function emptyLyrics() {
  return { meta: null, syncedLyrics: null, plainLyrics: null };
}

function pruneRequestCache() {
  const now = Date.now();

  for (const [key, timestamp] of cachedAt.entries()) {
    if (now - timestamp > CACHE_TTL_MS) {
      requestCache.delete(key);
      cachedAt.delete(key);
    }
  }

  while (requestCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = requestCache.keys().next().value;
    requestCache.delete(oldestKey);
    cachedAt.delete(oldestKey);
  }
}

function instrumentalLyrics() {
  return {
    syncedLyrics: `[00:00.00] Instrumental only\n[99:99.99] `,
    plainLyrics: `Instrumental only\n `,
  };
}

async function getGrooveOverride(videoId, overridesApiUrl) {
  const baseUrl = String(overridesApiUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
  const response = await fetchWithRetries(`${baseUrl}/overrides/${encodeURIComponent(videoId)}`);
  if (response.status === 404) return null;
  return response.json();
}

async function getOverrideLyrics(override) {
  if (String(override?.provider || "").toLowerCase() !== "lrclib") {
    throw new Error(`Unsupported override provider: ${override?.provider || "unknown"}`);
  }

  if (override.instrumental) {
    const lyrics = instrumentalLyrics();
    return {
      meta: { instrumental: true },
      ...lyrics,
    };
  }

  const response = await fetchWithRetries(
    `https://lrclib.net/api/get/${encodeURIComponent(override.lyricsId)}`,
  );
  const meta = await response.json();
  return {
    meta: {
      ...meta,
      instrumental: Boolean(override.instrumental) || Boolean(meta.instrumental),
    },
    syncedLyrics: meta.syncedLyrics || null,
    plainLyrics: meta.plainLyrics || null,
  };
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

function lyricsDurationExceedsTrack(lyricsMeta, lyricsQueryResult, trackDurationInSeconds, syncedLyrics) {
  if (!Number.isFinite(trackDurationInSeconds)) return false;
  const duration = Number(lyricsMeta?.duration ?? lyricsQueryResult?.duration);
  const durationExceeds = Number.isFinite(duration) && Math.round(duration + 30) > trackDurationInSeconds;
  if (!durationExceeds) return false;

  const lastNonEmptyLine = String(syncedLyrics || "")
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.replace(/\[\d{1,3}:\d{2}(?:\.\d+)?\]/g, "").trim());
  const lastLyricTimestamp = lastNonEmptyLine?.match(/\[(\d{1,3}):(\d{2})(?:\.(\d+))?\]/);
  if (!lastLyricTimestamp) return durationExceeds;

  const lyricEnd = Number(lastLyricTimestamp[1]) * 60 + Number(lastLyricTimestamp[2]) +
    Number(`0.${lastLyricTimestamp[3] || 0}`);
  return lyricEnd > trackDurationInSeconds;
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
    if (!response.ok) throw new Error(`LRCLIB search returned HTTP ${response.status}`);
    return response.json();
  };

  try {
    let results = await search(`${title} ${artist}`);

    // Second attempt: use the YouTube oEmbed author without the "- Topic" suffix.
    if (!results?.[0] && videoId) {
      try {
        const oEmbed = await getOEmbedMetadata(videoId);
        const oEmbedArtist = String(oEmbed.author_name || "")
          .replace(/\s*[-–—]\s*Topic$/i, "")
          .trim();

        if (oEmbedArtist) {
          results = await search(`${title} ${oEmbedArtist}`);
        }
      } catch (error) {
        console.warn("[groove] LRCLIB oEmbed artist retry failed; trying title only.", error);
      }
    }

    // Final attempt: search using only the title.
    if (!results?.[0]) {
      results = await search(title);
    }

    const lyricResults = results?.filter((result) => result?.id) || [];
    if (!lyricResults.length) return emptyLyrics();

    let firstResultLyrics = null;
    for (const [resultIndex, result] of lyricResults.entries()) {
      // Search payloads already include lyrics. Avoid an extra detail request for the common case;
      // it both reduces LRCLIB traffic and avoids triggering its rate limit while switching tracks.
      const searchHasLyrics = Boolean(result.syncedLyrics || result.plainLyrics || result.instrumental);
      const response = searchHasLyrics
        ? null
        : await fetchLrclib(`https://lrclib.net/api/get/${result.id}`);
      if (response && !response.ok) {
        const syncedLyrics = result.syncedLyrics || null;
        const plainLyrics = result.plainLyrics || null;
        if ([429, 500, 502, 503, 504].includes(response.status) && (syncedLyrics || plainLyrics)) {
          const fallbackLyrics = { meta: result, syncedLyrics, plainLyrics };
          firstResultLyrics ||= fallbackLyrics;
          if (hasSyncedLyricTimestamps(syncedLyrics) || result.instrumental) return fallbackLyrics;
          continue;
        }
        throw new Error(`LRCLIB lyrics detail returned HTTP ${response.status}`);
      }
      const meta = response ? await response.json() : result;
      const syncedLyrics = meta?.syncedLyrics || result.syncedLyrics || null;
      const plainLyrics = meta?.plainLyrics || result.plainLyrics || null;

      if (
        expectedDuration !== undefined &&
        lyricsDurationExceedsTrack(meta, result, expectedDuration, syncedLyrics)
      ) {
        console.log(`[groove] Skipping LRCLIB result ${resultIndex + 1} because its duration or final lyric exceeds the track duration.`, {
          trackDurationInSeconds: expectedDuration,
          lyricsDuration: meta?.duration ?? result.duration,
        });
        continue;
      }

      const lyrics = {
        meta,
        syncedLyrics: meta?.instrumental && !syncedLyrics && !plainLyrics
          ? "[00:00.00] Instrumental only\n[99:99.99] ♪"
          : syncedLyrics,
        plainLyrics,
      };

      firstResultLyrics ||= lyrics;
      if (hasSyncedLyricTimestamps(lyrics.syncedLyrics) || meta?.instrumental) {
        return lyrics;
      }

      if ((meta?.hasWordSync ?? result.hasWordSync) === false) continue;
    }

    return firstResultLyrics || emptyLyrics();
  } catch (error) {
    console.warn("[groove] LRCLIB resolution failed:", error);
    return null;
  }
}

async function resolveTrack(videoId, expectedDuration, useOverrides, overridesApiUrl) {
  const cacheKey = `${videoId}:${expectedDuration ?? "default"}:${useOverrides ? "overrides" : "automatic"}`;

  if (!useOverrides) {
    pruneRequestCache();
    const cached = requestCache.get(cacheKey);
    if (cached) return cached;
  }

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

    if (useOverrides) {
      try {
        const override = await getGrooveOverride(videoId, overridesApiUrl);
        if (override) {
          const lyrics = await getOverrideLyrics(override);
          return toLyricsSchema({
            title,
            artist,
            lyrics,
            durationOverride: expectedDuration,
          });
        }
      } catch (error) {
        console.warn(`[groove] Override lookup failed for ${videoId}; falling back to automatic lyrics resolution.`, error);
      }
    }

    const lyrics = await getLyricsFromTrackInfo(
      videoId,
      title,
      authorName || artist,
      expectedDuration,
    );

    return toLyricsSchema({
      title,
      artist,
      lyrics: lyrics || emptyLyrics(),
      durationOverride: expectedDuration,
    });
  })();

  if (!useOverrides) {
    requestCache.set(cacheKey, pending);
    cachedAt.set(cacheKey, Date.now());
    pruneRequestCache();
  }

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
      return json({
        message: "Welcome to the Groove API! usage documentation available at https://github.com/loop-mp3/groove/blob/main/docs/USAGE.md",
      });
    }

    const trackMatch = url.pathname.match(/^\/api\/v1\/track\/([^/]+)$/);

    if (trackMatch && request.method === "GET") {
      const videoId = decodeURIComponent(trackMatch[1]);

      if (!YOUTUBE_ID_PATTERN.test(videoId)) {
        return json({ error: "Invalid YouTube video ID" }, { status: 400 });
      }

      const durationParam = url.searchParams.get("duration");
      const expectedDuration = durationParam === null ? undefined : Number(durationParam);
      const useOverrides = url.searchParams.get("overrides") === "true";

      if (
        expectedDuration !== undefined &&
        (!Number.isFinite(expectedDuration) || expectedDuration < 0)
      ) {
        return json({ error: "Invalid duration" }, { status: 400 });
      }

      try {
        return json(await resolveTrack(
          videoId,
          expectedDuration,
          useOverrides,
          env.OVERRIDES_API_URL,
        ));
      } catch {
        return json({ error: "Could not resolve track metadata" }, { status: 502 });
      }
    }

    return json({ error: "Not found" }, { status: 404 });
  },
};
