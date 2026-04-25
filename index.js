const http = require("http");

const PORT = Number(process.env.PORT || 7021);
const HOST = process.env.HOST || "0.0.0.0";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const TMDB_API_KEY =
  process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c";
const TG_ARCHIVE_API = "https://tga-hd.api.hashhackers.com";
const GRAMA_WEB_BASE = "https://bollywood.eu.org/#";
const AUTH_TOKEN =
  process.env.GRAMA_BEARER_TOKEN ||
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjIwMjI4LCJlbWFpbCI6ImFiZHVsbGFob21pcmEyN0BnbWFpbC5jb20iLCJleHAiOjE3Nzc3Mjg5OTMsImlhdCI6MTc3NzEyNDE5M30.ep7jCxXWcv_Z4rQHwP4pFGuKL1fKEPmeJxJviFYeZDs";
const LINK_CACHE_TTL = 1000 * 60 * 60 * 8;
const linkCache = new Map();
const LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="MiX 1.5">
  <defs>
    <linearGradient id="mixBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <linearGradient id="mixAccent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f97316"/>
      <stop offset="100%" stop-color="#ef4444"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#mixBg)"/>
  <rect x="84" y="96" width="344" height="320" rx="56" fill="#0b1220" stroke="#1f2937" stroke-width="8"/>
  <path d="M152 188h42l37 62 37-62h42v136h-36v-75l-30 50h-26l-30-50v75h-36V188z" fill="#f8fafc"/>
  <path d="M337 188h37l29 43 29-43h37l-46 66 50 70h-38l-32-47-32 47h-38l50-70-46-66z" fill="url(#mixAccent)"/>
  <rect x="124" y="350" width="264" height="14" rx="7" fill="#334155"/>
  <text x="256" y="397" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="700" fill="#e5e7eb">1.5</text>
</svg>`;

const manifest = {
  id: "org.codex.mix",
  version: "1.5.0",
  name: "MiX 1.5",
  description: "Curated Stremio direct streams from Gram Cinema with clean quality selection.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

const simpleManifest = {
  ...manifest,
  id: "org.codex.mix.simple",
  version: "1.5.0-simple",
  name: "MiX Simple",
  description: "Minimal Stremio test manifest for MiX direct streams.",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(body);
}

function getPublicBaseUrl(req) {
  const forwardedProto = req?.headers?.["x-forwarded-proto"];
  const forwardedHost = req?.headers?.["x-forwarded-host"];
  const host = forwardedHost || req?.headers?.host || `127.0.0.1:${PORT}`;
  const proto =
    forwardedProto ||
    (String(host).includes("127.0.0.1") || String(host).includes("localhost")
      ? "http"
      : "https");
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function buildManifest(baseUrl, sourceManifest) {
  return {
    ...sourceManifest,
    logo: `${baseUrl}/logo.svg`,
  };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json,text/plain,*/*",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Request failed for ${url}: ${response.status}${body ? ` ${body}` : ""}`
    );
  }

  return response.text();
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, options));
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...extra,
  };
}

function parseSeriesResourceId(rawId) {
  const decoded = decodeURIComponent(rawId);
  const match = decoded.match(/^(.+):(\d+):(\d+)$/);
  if (!match) return null;
  return {
    id: match[1],
    season: Number(match[2]),
    episode: Number(match[3]),
  };
}

async function resolveTmdbDetails(inputId, mediaType) {
  if (/^\d+$/.test(String(inputId || ""))) {
    const numericId = String(inputId);
    const path = mediaType === "movie" ? "movie" : "tv";
    const data = await fetchJson(
      `https://api.themoviedb.org/3/${path}/${encodeURIComponent(
        numericId
      )}?api_key=${TMDB_API_KEY}`
    );

    return buildMediaContextFromTmdb(data, mediaType, null);
  }

  if (!/^tt\d+$/.test(String(inputId || ""))) {
    throw new Error(`Unsupported id format: ${inputId}`);
  }

  const payload = await fetchJson(
    `https://api.themoviedb.org/3/find/${encodeURIComponent(
      inputId
    )}?external_source=imdb_id&api_key=${TMDB_API_KEY}`
  );
  const list =
    mediaType === "movie" ? payload?.movie_results : payload?.tv_results;
  const result = Array.isArray(list) ? list[0] : null;

  if (!result?.id) {
    throw new Error(`TMDB ${mediaType} not found for ${inputId}`);
  }

  const path = mediaType === "movie" ? "movie" : "tv";
  const details = await fetchJson(
    `https://api.themoviedb.org/3/${path}/${encodeURIComponent(
      result.id
    )}?api_key=${TMDB_API_KEY}`
  );

  return buildMediaContextFromTmdb(details, mediaType, inputId);
}

function buildMediaContextFromTmdb(details, mediaType, imdbId) {
  const title =
    mediaType === "movie"
      ? details.title || details.original_title
      : details.name || details.original_name;
  const originalTitle =
    mediaType === "movie"
      ? details.original_title || details.title
      : details.original_name || details.name;
  const date =
    mediaType === "movie"
      ? details.release_date || null
      : details.first_air_date || null;

  return {
    imdbId,
    tmdbId: String(details.id),
    mediaType,
    title: title || "",
    originalTitle: originalTitle || title || "",
    year: Number(String(date || "").slice(0, 4)) || null,
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildMovieQueries(ctx) {
  const queries = [];
  const titles = unique([ctx.title, ctx.originalTitle]);

  for (const title of titles) {
    queries.push(`${title} ${ctx.year || ""}`.trim());
    queries.push(title);
  }

  return unique(queries);
}

function buildSeriesQueries(ctx, season, episode) {
  const queries = [];
  const titles = unique([ctx.title, ctx.originalTitle]);
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");

  for (const title of titles) {
    queries.push(`${title} S${s}E${e}`);
    queries.push(`${title} ${ctx.year || ""} S${s}E${e}`.trim());
    queries.push(`${title} ${season}x${episode}`);
    queries.push(`${title} season ${season} episode ${episode}`);
  }

  return unique(queries);
}

async function searchFiles(query, page = 1) {
  return fetchJson(
    `${TG_ARCHIVE_API}/files/search?q=${encodeURIComponent(query)}&page=${page}`,
    {
      headers: authHeaders(),
    }
  );
}

async function generateLink(fileId) {
  const cached = linkCache.get(fileId);
  if (cached && Date.now() - cached.timestamp < LINK_CACHE_TTL) {
    return cached.payload;
  }

  const payload = await fetchJson(
    `${TG_ARCHIVE_API}/genLink?type=files&id=${encodeURIComponent(fileId)}`,
    {
      headers: authHeaders(),
    }
  );
  if (payload?.success && payload?.url) {
    linkCache.set(fileId, {
      timestamp: Date.now(),
      payload,
    });
  }
  return payload;
}

function isVideoFilename(filename) {
  return /\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts)$/i.test(String(filename));
}

function isJunkFilename(filename) {
  const value = String(filename || "").toLowerCase();
  return (
    !isVideoFilename(value) ||
    /\bsample\b/.test(value) ||
    /\btrailer\b/.test(value) ||
    /\.part\d{2,4}\b/.test(value) ||
    /\bpart[_ .-]?\d{2,4}\b/.test(value)
  );
}

function parseQuality(filename) {
  const value = String(filename || "").toLowerCase();
  if (/(^|[^a-z0-9])(2160p|4k|uhd)([^a-z0-9]|$)/.test(value)) return 2160;
  if (/(^|[^a-z0-9])1440p([^a-z0-9]|$)/.test(value)) return 1440;
  if (/(^|[^a-z0-9])1080p([^a-z0-9]|$)/.test(value)) return 1080;
  if (/(^|[^a-z0-9])900p([^a-z0-9]|$)/.test(value)) return 900;
  if (/(^|[^a-z0-9])720p([^a-z0-9]|$)/.test(value)) return 720;
  if (/(^|[^a-z0-9])576p([^a-z0-9]|$)/.test(value)) return 576;
  if (/(^|[^a-z0-9])480p([^a-z0-9]|$)/.test(value)) return 480;
  if (/(^|[^a-z0-9])360p([^a-z0-9]|$)/.test(value)) return 360;
  return 0;
}

function formatBytes(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(num) / Math.log(1024)), units.length - 1);
  return `${(num / 1024 ** power).toFixed(power === 0 ? 0 : 2)} ${units[power]}`;
}

function parseCodec(filename) {
  const value = String(filename || "").toLowerCase();
  if (/\b(av1)\b/.test(value)) return "AV1";
  if (/\b(x265|hevc|h265)\b/.test(value)) return "HEVC";
  if (/\b(x264|h264|avc)\b/.test(value)) return "H.264";
  return null;
}

function parseBitDepth(filename) {
  const value = String(filename || "").toLowerCase();
  if (/\b10bit\b/.test(value)) return "10-bit";
  if (/\b12bit\b/.test(value)) return "12-bit";
  return null;
}

function parseSource(filename) {
  const value = String(filename || "").toLowerCase();
  if (/\b(remux)\b/.test(value)) return "REMUX";
  if (/\b(bluray|blu-ray|brrip|bdrip)\b/.test(value)) return "BluRay";
  if (/(^|[^a-z0-9])web[- _.]?dl([^a-z0-9]|$)|(^|[^a-z0-9])webdl([^a-z0-9]|$)/.test(value)) {
    return "WEB-DL";
  }
  if (/(^|[^a-z0-9])web[- _.]?rip([^a-z0-9]|$)|(^|[^a-z0-9])webrip([^a-z0-9]|$)/.test(value)) {
    return "WEBRip";
  }
  if (/\b(hdtv)\b/.test(value)) return "HDTV";
  if (/\b(dvdrip)\b/.test(value)) return "DVDRip";
  return null;
}

function parseAudioTags(filename) {
  const value = String(filename || "").toLowerCase();
  const tags = [];
  if (/\b(dual[ ._-]?audio)\b/.test(value)) tags.push("Dual Audio");
  if (/\b(multi[ ._-]?\d+|multi)\b/.test(value)) tags.push("Multi Audio");
  if (/\b(ddp?5[ ._-]?1|dd5[ ._-]?1|5[ ._-]?1)\b/.test(value)) tags.push("5.1");
  if (/\b(aac)\b/.test(value)) tags.push("AAC");
  if (/\b(opus)\b/.test(value)) tags.push("Opus");
  if (/\b(dts)\b/.test(value)) tags.push("DTS");
  return unique(tags);
}

function parseLanguageTags(filename) {
  const value = String(filename || "").toLowerCase();
  const tags = [];
  if (/\benglish|eng\b/.test(value)) tags.push("EN");
  if (/\bhindi\b/.test(value)) tags.push("HI");
  if (/\btamil\b/.test(value)) tags.push("TA");
  if (/\btelugu\b/.test(value)) tags.push("TE");
  return unique(tags);
}

function isHindiFile(filename) {
  const value = String(filename || "").toLowerCase();
  return (
    /(^|[^a-z0-9])hindi([^a-z0-9]|$)|(^|[^a-z0-9])hin([^a-z0-9]|$)/.test(value) ||
    /dual audio|multi audio/.test(value)
  );
}

function formatEpisodeCode(season, episode) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function makePrettySpacing(value) {
  return String(value || "")
    .replace(/\.[A-Za-z0-9]{2,4}$/i, "")
    .replace(/[._()[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTitlePhrase(filename, ctx) {
  const title = normalizeText(ctx.title || ctx.originalTitle);
  const normalizedFilename = normalizeText(filename);
  if (!title || !normalizedFilename) return false;
  const pattern = new RegExp(`\\b${escapeRegex(title)}\\b`, "i");
  return pattern.test(normalizedFilename);
}

function titleCoverageScore(filename, ctx) {
  const normalizedTitle = normalizeText(ctx.title || ctx.originalTitle);
  const normalizedFilename = normalizeText(filename);
  if (!normalizedTitle || !normalizedFilename) return 0;
  const titleTokens = normalizedTitle.split(/\s+/).filter((token) => token.length > 2);
  if (!titleTokens.length) return 0;
  const fileTokens = new Set(normalizedFilename.split(/\s+/).filter(Boolean));
  const matched = titleTokens.filter((token) => fileTokens.has(token)).length;
  return matched / titleTokens.length;
}

function hasForbiddenExtraMarkers(filename) {
  const value = normalizeText(filename);
  return /\b(look back|behind the scenes|documentary|featurette|interview|extras|bonus)\b/.test(
    value
  );
}

function buildPrettyTitle(ctx, extra = {}) {
  const parts = [ctx.title, ctx.year || null];
  if (ctx.mediaType === "series" && extra.season && extra.episode) {
    parts.push(formatEpisodeCode(extra.season, extra.episode));
  }
  return parts.filter(Boolean).join(" ").trim();
}

function buildCandidateMetadata(candidate) {
  const filename = candidate.rawFilename || candidate.file_name || "";
  const quality = parseQuality(filename);
  const size = formatBytes(candidate.file_size);
  const codec = parseCodec(filename);
  const bitDepth = parseBitDepth(filename);
  const source = parseSource(filename);
  const audio = parseAudioTags(filename);
  const languages = parseLanguageTags(filename);

  return {
    quality,
    qualityLabel: quality ? `${quality}p` : "Auto",
    size,
    codec,
    bitDepth,
    source,
    audio,
    languages,
    ext: String(filename).split(".").pop()?.toUpperCase() || null,
  };
}

function formatCandidateTitle(candidate) {
  const meta = buildCandidateMetadata(candidate);
  return [
    candidate.file_name,
    meta.qualityLabel !== "Auto" ? meta.qualityLabel : null,
    meta.size,
    meta.source,
    meta.ext,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatCandidateName(candidate) {
  const meta = buildCandidateMetadata(candidate);
  const parts = ["MiX"];
  if (meta.qualityLabel && meta.qualityLabel !== "Auto") parts.push(meta.qualityLabel);
  return parts.join(" ");
}

function buildWebFallbackStream(ctx, extra = {}) {
  const mediaPath =
    ctx.mediaType === "movie"
      ? `/movie/${ctx.tmdbId}`
      : `/tv/${ctx.tmdbId}`;
  const chosenTitle = ctx.title || ctx.originalTitle || "this title";
  const title = `Open ${chosenTitle} in Web`;

  return {
    name: "MiX Web",
    title,
    externalUrl: `${GRAMA_WEB_BASE}${mediaPath}`,
    behaviorHints: {
      bingeGroup: extra.bingeGroup || undefined,
    },
  };
}

function titleTokenScore(filename, titles) {
  const fileTokens = new Set(tokenize(filename));
  let best = 0;

  for (const title of titles) {
    const tokens = tokenize(title).filter((token) => token.length > 1);
    if (!tokens.length) continue;
    const matches = tokens.filter((token) => fileTokens.has(token)).length;
    const ratio = matches / tokens.length;
    best = Math.max(best, ratio);
  }

  return best;
}

function yearScore(filename, year) {
  if (!year) return 0;
  return String(filename).includes(String(year)) ? 1 : 0;
}

function seriesEpisodeScore(filename, season, episode) {
  const value = String(filename || "");
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");

  if (new RegExp(`S${s}E${e}`, "i").test(value)) return 1;
  if (new RegExp(`\\b${season}x${episode}\\b`, "i").test(value)) return 0.9;
  if (
    new RegExp(`season[ ._-]?${season}.*episode[ ._-]?${episode}`, "i").test(value)
  ) {
    return 0.75;
  }
  return 0;
}

function buildMovieScore(file, ctx) {
  const filename = file.file_name || "";
  const titles = unique([ctx.title, ctx.originalTitle]);
  const titleScore = titleTokenScore(filename, titles);
  const quality = parseQuality(filename);

  let score = 0;
  score += titleScore * 100;
  score += yearScore(filename, ctx.year) * 20;
  score += Math.min(quality, 2160) / 100;

  if (/\b(hevc|x265|10bit)\b/i.test(filename)) score += 2;
  if (/\b(cam|hdcam|ts|telesync)\b/i.test(filename)) score -= 25;

  return score;
}

function buildSeriesScore(file, ctx, season, episode) {
  const filename = file.file_name || "";
  const titles = unique([ctx.title, ctx.originalTitle]);
  const titleScore = titleTokenScore(filename, titles);
  const episodeScore = seriesEpisodeScore(filename, season, episode);
  const quality = parseQuality(filename);

  let score = 0;
  score += titleScore * 100;
  score += episodeScore * 120;
  score += yearScore(filename, ctx.year) * 10;
  score += Math.min(quality, 2160) / 100;

  if (episodeScore <= 0) score -= 80;
  if (/\b(cam|hdcam|ts|telesync)\b/i.test(filename)) score -= 25;

  return score;
}

function getSourceRank(filename) {
  const source = parseSource(filename);
  if (source === "REMUX") return 5;
  if (source === "BluRay") return 4;
  if (source === "WEB-DL") return 3;
  if (source === "WEBRip") return 2;
  if (source === "HDTV") return 1;
  return 0;
}

function isOriginalAudioOnly(file) {
  const filename = file.file_name || "";
  if (isHindiFile(filename)) return false;
  const audio = parseAudioTags(filename);
  if (audio.includes("Dual Audio") || audio.includes("Multi Audio")) return false;
  const langs = parseLanguageTags(filename);
  if (langs.includes("HI")) return false;
  return true;
}

function dedupeByRelease(candidates) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate.file.rawFilename || candidate.file.file_name || "")
      .replace(/\b(2160p|1080p|720p|480p|360p|hevc|x265|x264|10bit|webrip|web dl|webdl|bluray|brrip|bdrip|mkv|mp4)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const key = `${candidate.file.file_name}|${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }

  return output;
}

function chooseBestByQuality(candidates, targetQuality) {
  const filtered = candidates.filter(
    (candidate) => parseQuality(candidate.file.rawFilename || candidate.file.file_name) === targetQuality
  );
  if (!filtered.length) return null;
  return filtered.sort((a, b) => {
    const sourceDiff =
      getSourceRank(b.file.rawFilename || b.file.file_name) -
      getSourceRank(a.file.rawFilename || a.file.file_name);
    if (sourceDiff !== 0) return sourceDiff;
    return b.score - a.score;
  })[0];
}

function chooseSmallestCandidate(candidates, selected) {
  const selectedIds = new Set(selected.filter(Boolean).map((item) => item.file.id));
  const leftovers = candidates.filter(
    (candidate) => !selectedIds.has(candidate.file.id) && candidate.score >= 200
  );
  if (!leftovers.length) return null;
  return leftovers.sort((a, b) => {
    const sizeDiff = Number(a.file.file_size || 0) - Number(b.file.file_size || 0);
    if (sizeDiff !== 0) return sizeDiff;
    return b.score - a.score;
  })[0];
}

function curateCandidates(candidates) {
  const clean = dedupeByRelease(candidates).filter((candidate) => isOriginalAudioOnly(candidate.file));
  const picked = [
    chooseBestByQuality(clean, 2160),
    chooseBestByQuality(clean, 1080),
    chooseBestByQuality(clean, 720),
  ].filter(Boolean);

  const smallest = chooseSmallestCandidate(clean, picked);
  if (smallest) picked.push(smallest);

  return dedupeByRelease(picked).slice(0, 4);
}

function isMovieCandidateAllowed(file, ctx) {
  const filename = file.file_name || "";
  if (isHindiFile(filename)) return false;
  if (hasForbiddenExtraMarkers(filename)) return false;
  if (!containsTitlePhrase(filename, ctx)) return false;
  if (titleCoverageScore(filename, ctx) < 0.8) return false;
  if (ctx.year && !String(filename).includes(String(ctx.year))) return false;
  return true;
}

function isSeriesCandidateAllowed(file, ctx, season, episode) {
  const filename = file.file_name || "";
  const normalized = normalizeText(filename);
  if (isHindiFile(filename)) return false;
  if (hasForbiddenExtraMarkers(filename)) return false;
  if (!containsTitlePhrase(filename, ctx)) return false;
  if (titleCoverageScore(filename, ctx) < 0.75) return false;
  if (seriesEpisodeScore(filename, season, episode) <= 0) return false;
  if (/\bpresents diabolical\b/i.test(normalized)) return false;
  return true;
}

async function collectCandidates(queries) {
  const all = [];
  const seenIds = new Set();

  for (const query of queries.slice(0, 4)) {
    try {
      const result = await searchFiles(query, 1);
      for (const file of result?.files || []) {
        if (!file?.id || seenIds.has(file.id) || isJunkFilename(file.file_name)) {
          continue;
        }
        seenIds.add(file.id);
        all.push(file);
      }
    } catch (error) {
      console.error(`[Grama] search failed for "${query}"`, error.message);
    }
  }

  return all;
}

async function buildStreamsFromCandidates(candidates) {
  const streams = [];
  const usedUrls = new Set();

  for (const candidate of candidates) {
    try {
      const link = await generateLink(candidate.file.id);
      const url = link?.url;
      if (!link?.success || !url || usedUrls.has(url)) continue;
      usedUrls.add(url);

      streams.push({
        name: formatCandidateName(candidate.file),
        title: formatCandidateTitle(candidate.file),
        url,
        behaviorHints: {
          bingeGroup: candidate.group || undefined,
        },
      });
    } catch (error) {
      console.error(`[Grama] genLink failed for ${candidate.file.id}`, error.message);
    }
  }

  return streams;
}

function toSimpleStreams(streams) {
  return streams.slice(0, 1).map((stream) => ({
    name: stream.name,
    title: stream.title,
    url: stream.url,
  }));
}

async function getMovieStreams(rawId) {
  const ctx = await resolveTmdbDetails(rawId, "movie");
  const queries = buildMovieQueries(ctx);
  const candidates = await collectCandidates(queries);
  const ranked = candidates
    .filter((file) => isMovieCandidateAllowed(file, ctx))
    .map((file) => ({
      file: {
        ...file,
        rawFilename: file.file_name,
        file_name: buildPrettyTitle(ctx),
      },
      score: buildMovieScore(file, ctx),
      group: `movie-${ctx.tmdbId}`,
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item);

  const curated = curateCandidates(ranked);

  const streams = await buildStreamsFromCandidates(curated);
  if (streams.length) return streams;
  return [buildWebFallbackStream(ctx, { reason: "Direct links temporarily limited" })];
}

async function getSeriesStreams(rawId) {
  const parsed = parseSeriesResourceId(rawId);
  if (!parsed) return [];

  const ctx = await resolveTmdbDetails(parsed.id, "series");
  const queries = buildSeriesQueries(ctx, parsed.season, parsed.episode);
  const candidates = await collectCandidates(queries);
  const ranked = candidates
    .filter((file) => isSeriesCandidateAllowed(file, ctx, parsed.season, parsed.episode))
    .map((file) => ({
      file: {
        ...file,
        rawFilename: file.file_name,
        file_name: buildPrettyTitle(ctx, {
          season: parsed.season,
          episode: parsed.episode,
        }),
      },
      score: buildSeriesScore(file, ctx, parsed.season, parsed.episode),
      group: `series-${ctx.tmdbId}-s${parsed.season}e${parsed.episode}`,
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item);

  const curated = curateCandidates(ranked);

  const streams = await buildStreamsFromCandidates(curated);
  if (streams.length) return streams;
  return [
    buildWebFallbackStream(ctx, {
      reason: `S${parsed.season}E${parsed.episode} • Direct links temporarily limited`,
      bingeGroup: `series-${ctx.tmdbId}`,
    }),
  ];
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;

    if (pathname === "/" || pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        addon: manifest.name,
        tgArchiveApi: TG_ARCHIVE_API,
        linkCacheSize: linkCache.size,
      });
    }

    if (pathname === "/logo.svg") {
      return sendText(res, 200, LOGO_SVG, "image/svg+xml; charset=utf-8");
    }

    if (pathname === "/manifest.json") {
      return sendJson(res, 200, buildManifest(getPublicBaseUrl(req), manifest));
    }

    if (pathname === "/simple/manifest.json") {
      return sendJson(res, 200, buildManifest(getPublicBaseUrl(req), simpleManifest));
    }

    const match = pathname.match(/^(\/simple)?\/stream\/(movie|series)\/(.+)\.json$/);
    if (!match) {
      return sendJson(res, 404, { streams: [] });
    }

    const [, simplePrefix, type, rawId] = match;
    const streams =
      type === "movie"
        ? await getMovieStreams(rawId)
        : await getSeriesStreams(rawId);
    const payload = simplePrefix ? { streams: toSimpleStreams(streams) } : { streams };

    return sendJson(res, 200, payload);
  } catch (error) {
    console.error("[Grama]", error);
    return sendJson(res, 200, { streams: [] });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MiX addon listening on http://${HOST}:${PORT}/manifest.json`);
});
