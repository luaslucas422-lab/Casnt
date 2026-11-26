# Casnt protocol (v1)

- UDP 47821: Quest broadcasts `CASNT?` → PC replies `{"app":"casnt","pcId","pcName","port"}`
- TCP 47820: frames `[type:1][len:4 BE][payload]`

| type | payload |
|---|---|
| 1 JSON | control message `{ "t": ... }` |
| 2 VCONF | H.264 SPS/PPS (Annex B) |
| 3 VKEY | 8-byte pts (µs, BE) + config + key frame |
| 4 VFRAME | 8-byte pts + delta frame |
| 5 AGAME | PCM s16le 48 kHz stereo |
| 6 AMIC | PCM s16le 48 kHz mono |

Quest → PC: `hello{deviceId,name,model}`, `usb_pair` (USB only), `pair_code{code}`, `pair_confirm`, `pair_cancel`, `auth{token}`, `cast_request{mode, quality: pc|potato|medium|good|max}`, `cast_started{width,height,fps}`, `status{battery,charging,game,mic,spec}`, `pong{ts}`, `cast_stop`, `tiktok_check`, `ping{ts}`

PC → Quest: `hello{pcName,pcId}`, `pair_match{pcName,pcId}`, `pair_fail{reason}`, `paired{token,pcName,pcId}`, `auth_ok`, `auth_fail`, `cast_accept{quality,spec}`, `cast_decline{reason}`, `set_quality{spec}`, `set_audio{game,mic}`, `ping{ts}`, `cast_stop`, `key_request`, `tiktok_result{installed,downloadUrl}`, `unpaired`, `pong`

## Stage 3 (Quest panels)
Quest → PC: `tiktok_subscribe`, `tiktok_unsubscribe`, `tiktok_action{do: connect|disconnect|tts_skip|sound|test|toggle, sound, type, what}`, `spotify_check`, `spotify_open_download`, `player_cmd{req, do: subscribe|unsubscribe|toggle|play|pause|next|prev|search|playlists|playlist|play_item, q, id, uri, item, context}`

PC → Quest: `tiktok_status{status,message,username}`, `tiktok_stats{stats,goals,top}`, `tiktok_config{tts,sounds,alerts,soundList}`, `tiktok_feed{item}`, `tiktok_alert{title}`, `spotify_info{installed,running,linked,downloadUrl}`, `player_state{active,title,artist,album,playing,position,duration,art(base64),linked}`, `player_result{req,ok,results,message,needLink}`

Overlays: `http://127.0.0.1:47830/overlay/{alerts|chat|goals|leaderboard|gifts|counters|points|all}` (SSE at `/events`).
