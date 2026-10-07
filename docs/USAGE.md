# Groove API Usage

Groove lrc lib wrapper which returns lyrics data from youtube track id

## Track endpoint

```text
GET /api/v1/track/:youtubeVideoId
```

Example:

```sh
curl https://groove.mizucode.qzz.io/api/v1/track/dQw4w9WgXcQ
```

PowerShell:

```powershell
Invoke-RestMethod https://groove.mizucode.qzz.io/api/v1/track/dQw4w9WgXcQ
```

The YouTube video ID must be the standard 11-character ID containing only letters, numbers, `_`, or `-`.

There is no separate lyrics endpoint. Track metadata, plain lyrics, synced lyrics, and the generated lyrics file are returned together by the track endpoint.

## Response

```json
{
  "id": 36778841,
  "name": "505",
  "trackName": "505",
  "artistName": "Arctic Monkeys",
  "albumName": "Favourite Worst Nightmare",
  "duration": 254,
  "instrumental": false,
  "hasWordSync": false,
  "plainLyrics": "I'm going back to 505\n...",
  "syncedLyrics": "[00:12.38] I'm going back to 505\n...",
  "lyricsfile": "version: '1.0'\nmetadata:\n  ..."
}
```

Field details:

| Field | Type | Description |
| --- | --- | --- |
| `id` | number or `null` | LRCLIB result ID. |
| `name` | string | LRCLIB display name. |
| `trackName` | string | Resolved track title. |
| `artistName` | string | Resolved artist name. |
| `albumName` | string | Album name returned by LRCLIB, or an empty string when unavailable. |
| `duration` | number | Track duration in seconds. |
| `instrumental` | boolean | Whether the track is instrumental. |
| `hasWordSync` | boolean | Whether word-level synchronization is available. |
| `plainLyrics` | string or `null` | Unsynchronized lyrics. |
| `syncedLyrics` | string or `null` | Timestamped LRC lyrics. |
| `lyricsfile` | string | Generated YAML lyric file content. |

## Resolution flow

For a track ID, Groove:

1. Fetches canonical title and artist information from YouTube oEmbed.
2. Enriches the artist/title using the YouTube Music player endpoint when available.
3. Searches LRCLIB using the title and artist.
4. Retries with the title alone when the first search has no results.
5. Checks LRCLIB candidates until it finds synced timestamps or an instrumental result.
6. Returns the selected LRCLIB metadata, lyrics, and generated `lyricsfile`.

Transient upstream failures are retried with exponential backoff. If lyrics cannot be found, the response still follows the same schema with nullable lyric fields.

## Errors

### Invalid video ID — `400`

```json
{
  "error": "Invalid YouTube video ID"
}
```

### Upstream resolution failure — `502`

```json
{
  "error": "Could not resolve track metadata"
}
```

### Unknown route — `404`

```json
{
  "error": "Not found"
}
```
