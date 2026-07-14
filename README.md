# harbor-sub-sync

A draggable subtitle sync timeline for [Harbor](https://github.com/harborstremio/harbor), inspired by FastStream's resync tool. Drag the subtitle track against the playhead until the line you hear sits where it should — the offset applies instantly via mpv's `sub-delay`.

## Install

1. Open Harbor → **Settings → Advanced → Custom JS**
2. Paste the contents of [`harbor-sub-sync.js`](./harbor-sub-sync.js)
3. Save

A **⇄ CC sync** pill appears bottom-right whenever the native player is running. Requires the mpv engine (Harbor's default) — it does nothing in HTML5/web mode.

## Usage

Toggle the timeline with the pill or `Ctrl+Shift+Y`, then:

| Action | Effect |
|---|---|
| Drag timeline | Shift all subtitles (live) |
| `Shift`+click a cue | Align that line to the playhead — "I hear this line **now**" |
| Click a cue | Seek to ~1s before it |
| Double-click empty space | Seek there |
| `Alt`+drag | Pan the view without changing sync |
| Wheel | Zoom (10s–600s) |
| `Shift`+wheel | ±10 ms nudge |
| `Alt`+`←`/`→` | ±10 ms (`+Shift`: ±100 ms) |
| Buttons | ±0.5 s / ±50 ms, Reset, Reload cues |

The quickest workflow: wait for a line you can identify, `Shift`+click its box the moment you hear it spoken. Done.

## Where the cue boxes come from

- **External subtitles** (addon results, OpenSubtitles, local files): the full track loads in a second or two.
- **Embedded track, local file**: extracted with ffmpeg, loads fully.
- **Embedded track, remote stream** (debrid/torrent): a full extraction isn't feasible — instead the timeline builds itself in **live mode**. Boxes appear as lines display and as you seek around. Click **Scan +5min** to map the next five minutes automatically: playback pauses and mutes, steps through in 2.5 s hops collecting cues, then returns exactly where you were. Cancel anytime with **Stop scan**.

Note: scanning samples every 2.5 s, so very short lines can slip between steps. Playing or seeking near them fills the gaps.

## Persistence

- The sync offset is remembered **per title** and re-applied automatically on the next play (the pill flashes the restored value). Reset clears it.
- Cues collected in live mode are cached per title (last 12 titles), so mapping work carries over between sessions.
- Zoom level is remembered too.

## How it works

Harbor's custom JS runs in the app's own webview, so the script talks to the bundled mpv straight through Harbor's Tauri commands: `mpv_get_property` for the clock and track info, `mpv_set_property` for `sub-delay`, `mpv_command` for seeks, and `subtitle_extract` (Harbor's ffmpeg wrapper) to download and convert subtitle files without CORS restrictions. Live mode reads mpv's `sub-start` / `sub-end` / `sub-text` properties to log each displayed cue. No network calls beyond what Harbor itself already makes; everything is stored in localStorage.

## Uninstall

Clear the Custom JS field in Settings → Advanced. Saved offsets/cues live under `fss-` keys in localStorage if you want to purge those as well.

## License

MIT
