# Casnt

Cast your **Meta Quest 3** to your **Windows PC**, with a cartoony gold UI.
By DarkerDawnFR.

## What's in Stage 1
- **Pairing:** the PC shows a 6-digit code (it changes every 10 minutes and after each pairing). Type it on the Quest, answer **"Is this PC yours? <PC name>"**, and you're paired. One Quest can pair with several PCs.
- **Greetings:** "Good morning / afternoon / evening, <name>". The PC uses its own name, and the Quest uses the name you type on first launch. You can hide the greeting in Settings.
- **Cast to PC:** a big button on the Quest. You choose **Everything** (menus included) or **Just an app** (Horizon OS hides the Meta menus, and it needs the Android 14-based Horizon OS). Then the PC asks **"Meta Quest 3 (Name) is trying to cast to you. Do you accept?"**
- **Works while the window is closed:** Casnt starts with Windows and waits in the tray, so the accept popup still shows up.
- **PC viewer:** windowed or fullscreen, with game audio and mic audio from the Quest, mute buttons and a Stop button.
- **Connection:** Wi-Fi, or USB. When the Quest is plugged in and adb is found (SideQuest's adb works), Casnt forwards its port over the cable.
- **TikTok LIVE button:** asks "Do you have TikTok LIVE Studio installed?", then checks the PC for it and offers the download if it's missing.
- **Look:** cartoony gold with black outlines, or a clean dark/light look picked in Settings.

## Coming next
- **Stage 2:** quality presets (Potato / Medium / Good + Custom, Good = 1440p by default, plus a "Max" mode), mic and game-audio toggles with volume sliders, battery/ping/FPS/bitrate stats (off by default), recording, and sound effects.
- **Stage 3:** the TikTok LIVE area (a Tikfinity-style toolkit): TTS (all chat / !tts / gifters), gift and follow alerts, goals and counters, chat overlay, gift actions (sounds, GIFs, key presses, TTS shoutouts), browser-source overlay links, and a lighter Quest panel.

## Install
1. Download the build from the **Actions** tab (or **Releases**): `Casnt-Quest.apk` and `Casnt Setup x.y.z.exe`.
2. **PC:** run the installer.
3. **Quest:** turn on developer mode, then sideload the APK with SideQuest (or `adb install Casnt-Quest.apk`). It shows up under **Library → Unknown sources**.
4. Open Casnt on both devices, tap **Cast to PC** on the Quest, and type the code from the PC.

The PC and the Quest must be on the same Wi-Fi, or connected by USB. Allow Casnt through Windows Firewall when Windows asks, because it uses TCP 47820 and UDP 47821.

## Building
- PC: `cd pc && npm install && npm start` (tests: `npm test`)
- Quest: `gradle -p quest assembleRelease` (JDK 17 + Android SDK)

## Notes
- CI signs the APK with a debug key that is new on each run, so uninstall the old APK before installing a new build. Stage 2 adds a fixed signing key.
- The TikTok LIVE button uses a generic "LIVE" badge, not TikTok's logo.
