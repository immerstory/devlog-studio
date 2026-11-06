import type { DevlogExtension, ExtensionBumper } from "devlog-studio/extension";

/** Seconds the backdrop and the text take to fade. */
const FADE_SECONDS = 0.5;
const FAMILY = "DevlogTitleCard";
const FALLBACK = "'Arial Black', Impact, sans-serif";
const fade = (value: number) => Math.max(0, Math.min(1, value));

const titleCard: ExtensionBumper = {
  id: "title-card",
  label: "Title card",
  description: "White text fades in on black, holds and fades out.",
  params: [
    { key: "text", label: "Title (one row per line)", type: "multiline", default: "", help: "Empty uses the project's public title." },
    { key: "font", label: "Font", type: "font", help: "Without a font, a bold system font is used." },
    { key: "holdSeconds", label: "Hold (s)", type: "number", default: 2, min: 0, max: 5, step: 0.1 },
  ],
  seconds: (params) => FADE_SECONDS * 2 + Math.max(0, Number(params.holdSeconds) || 0),
  animation: {
    async prepare({ platform, params, placement, durationInFrames, fps, width, height, title }) {
      // A font URL gives each font its own family, so an intro and an outro can differ.
      const fontUrl = params.font as string | undefined;
      const family = fontUrl ? `${FAMILY}-${[...fontUrl].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}` : undefined;
      if (fontUrl && family) await platform.loadFont(fontUrl, family);
      const lines = (String(params.text ?? "").trim() || title).split("\n");
      const fontOf = (size: number) => `bold ${size}px ${family ? `"${family}", ` : ""}${FALLBACK}`;
      const fadeFrames = FADE_SECONDS * fps;

      return (ctx, frame) => {
        const fadeIn = fade(frame / fadeFrames);
        const fadeOut = fade((durationInFrames - frame) / fadeFrames);
        // An intro uncovers the first segment at its end. An outro stays black, because the video ends with it.
        ctx.globalAlpha = placement === "intro" ? fadeOut : fadeIn;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);

        let size = Math.round(height * 0.09);
        ctx.font = fontOf(size);
        const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
        if (widest > width * 0.86) size = Math.floor((size * width * 0.86) / widest);
        ctx.font = fontOf(size);
        ctx.globalAlpha = Math.min(fadeIn, fadeOut);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lineHeight = size * 1.15;
        lines.forEach((line, i) => ctx.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * lineHeight));
        ctx.globalAlpha = 1;
      };
    },
  },
};

const extension: DevlogExtension = {
  id: "title-card",
  name: "Title card example",
  bumpers: [titleCard],
  themePresets: [
    {
      id: "night-paper",
      label: "Night paper",
      description: "Dark slides with a title card as the outro.",
      colors: { paper: "#26282e", paperLight: "#32353d", paperShade: "#1c1e22", wash: "#3f5e7a", ink: "#f2efe6", accent: "#f0a040", polaroid: "#f5f2ea" },
      outro: { style: "title-card" },
    },
  ],
};

export default extension;
