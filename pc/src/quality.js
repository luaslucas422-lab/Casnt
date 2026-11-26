// Cast quality presets. The PC sends the chosen spec to the Quest, which encodes with it
// (and steps down by itself if its encoder can't do it).
'use strict';

const PRESETS = {
  potato: { preset: 'potato', width: 854, height: 480, fps: 30, bitrate: 2_500_000 },
  medium: { preset: 'medium', width: 1280, height: 720, fps: 60, bitrate: 8_000_000 },
  // Good with "Set resolution": capped at 1440p.
  good: { preset: 'good', width: 2560, height: 1440, fps: 60, bitrate: 20_000_000 },
  // Good with "Max": uses everything the Quest can manage.
  max: { preset: 'max', width: 3840, height: 2160, fps: 72, bitrate: 50_000_000 },
};

const CUSTOM_HEIGHTS = [480, 720, 1080, 1440, 2160];
const CUSTOM_FPS = [30, 60, 72, 90];

function customSpec(c) {
  const height = CUSTOM_HEIGHTS.includes(Number(c.height)) ? Number(c.height) : 1080;
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const fps = CUSTOM_FPS.includes(Number(c.fps)) ? Number(c.fps) : 60;
  const mbps = Math.min(80, Math.max(1, Number(c.mbps) || 15));
  return { preset: 'custom', width, height, fps, bitrate: Math.round(mbps * 1_000_000) };
}

/** Turn a preset name + settings into a concrete spec. */
function specFor(name, settings) {
  if (name === 'custom') return customSpec(settings.custom || {});
  if (name === 'good' && settings.goodMode === 'max') return { ...PRESETS.max, preset: 'good' , max: true };
  return { ...(PRESETS[name] || PRESETS.good) };
}

function describe(spec) {
  if (!spec) return '';
  return `${spec.height}p · ${spec.fps} fps · ${Math.round(spec.bitrate / 1e6)} Mbps`;
}

module.exports = { PRESETS, CUSTOM_HEIGHTS, CUSTOM_FPS, specFor, customSpec, describe };
