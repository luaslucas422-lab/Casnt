# Casnt

Cast your **Meta Quest 3** to your **Windows PC**, with a cartoony gold UI.
By calm.chasm.

## What's in Stage 1
- **Pairing:** the PC shows a 6-digit code (it changes every 10 minutes and after each pairing). Type it on the Quest, answer **"Is this PC yours? <PC name>"**, and you're paired. One Quest can pair with several PCs.
- **Greetings:** "Good morning / afternoon / evening, <name>". The PC uses its own name, and the Quest uses the name you type on first launch. You can hide the greeting in Settings.
- **Cast to PC:** a big button on the Quest. You choose **Everything** (menus included) or **Just an app** (Horizon OS hides the Meta menus, and it needs the Android 14-based Horizon OS). Then the PC asks **"Meta Quest 3 (Name) is trying to cast to you. Do you accept?"**
- **Works while the window is closed:** Casnt starts with Windows and waits in the tray, so the accept popup still shows up.
- **PC viewer:** windowed or fullscreen, with game audio and mic audio from the Quest, mute buttons and a Stop button.
- **Connection:** Wi-Fi, or USB. When the Quest is plugged in and adb is found (SideQuest's adb works), Casnt forwards its port over the cable.
- **TikTok LIVE button:** asks "Do you have TikTok LIVE Studio installed?", then checks the PC for it and offers the download if it's missing.
- **Look:** cartoony gold with black outlines, or a clean dark/light look picked in Settings.

## New in 0.2.0
- **Quality:** Potato / Medium / Good / Custom. Good is "Set resolution" (1440p) or "Max" (up to 4K72). Quality can be switched live from the Quest or the PC.
- **FOV and Smoothness** on the PC. FOV zooms into the view. Smoothness is a stabilizer that steadies head shake.
- **Audio:** game audio and mic toggles on both sides, plus volume up to 200% on the PC.
- **Stats:** battery, ping, FPS and bitrate, all off by default.
- **More:** recording to webm, and a settings panel beside the cast when it isn't fullscreen.
- **USB instant connect** (on by default): plug the Quest in and it pairs with no code. Casnt bundles its own adb.
- **Updaters:** the PC updates itself from GitHub releases. The Quest can update itself, or the PC can install the new Quest app over USB.
- **More settings:** popup position, auto-accept, auto-decline time, default cast mode, start quality, sound effects, animations, and an Experimental section.
- **Fixes:** Quest screens now shrink to fit the panel, so nothing goes off-screen.

## Coming next
- **Stage 3:** the TikTok LIVE area (a Tikfinity-style toolkit): TTS (all chat / !tts / gifters), gift and follow alerts, goals and counters, chat overlay, gift actions, browser-source overlays, and a lighter Quest panel.

## Install
1. Download the build from **Releases**: `Casnt-Quest.apk` and `Casnt-Setup-x.y.z.exe`.
2. **PC:** run the installer.
3. **Quest:** turn on developer mode, then sideload the APK with SideQuest (or `adb install Casnt-Quest.apk`). It shows up under **Library → Unknown sources**.
4. Open Casnt on both devices, tap **Cast to PC** on the Quest, and type the code from the PC.

The PC and the Quest must be on the same Wi-Fi, or connected by USB. Allow Casnt through Windows Firewall when Windows asks, because it uses TCP 47820 and UDP 47821.

## Building
- PC: `cd pc && npm install && npm start` (tests: `npm test`)
- Quest: `gradle -p quest assembleRelease` (JDK 17 + Android SDK)

## Notes
- The Quest APK is signed with the key in the `CASNT_KEYSTORE_B64` / `CASNT_KEYSTORE_PASSWORD` repo secrets. Without them, CI uses a throwaway key and updates won't install over the old app.
- The TikTok LIVE button uses a generic "LIVE" badge, not TikTok's logo.
