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

Quest → PC: `hello{deviceId,name,model}`, `pair_code{code}`, `pair_confirm`, `pair_cancel`, `auth{token}`, `cast_request{mode: everything|app}`, `cast_started{width,height,fps}`, `cast_stop`, `tiktok_check`, `ping{ts}`

PC → Quest: `hello{pcName,pcId}`, `pair_match{pcName,pcId}`, `pair_fail{reason}`, `paired{token,pcName,pcId}`, `auth_ok`, `auth_fail`, `cast_accept{quality}`, `cast_decline{reason}`, `cast_stop`, `key_request`, `tiktok_result{installed,downloadUrl}`, `unpaired`, `pong`
