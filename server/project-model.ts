import type { StudioConfig } from "./config.js";
import { ARTICLE_TEMPLATE, type GlobalSettings, type ProjectSettings } from "../shared/projects.js";

export function globalFromStudio(c: StudioConfig): GlobalSettings {
  return { port: c.port, agent: c.agent, elevenlabs: { apiKey: c.elevenlabs.apiKey }, render: c.render, statsIntervalHours: c.youtube.statsIntervalHours };
}
export function projectFromStudio(c: StudioConfig, sourceId: string, targetId: string, connectionId?: string): ProjectSettings {
  const { apiKey: _key, ...narration } = c.elevenlabs;
  const { clientId: _id, clientSecret: _secret, refreshToken: _token, channelTitle: _channel, statsIntervalHours: _interval, ...publishing } = c.youtube;
  return {
    name: c.gameTitle, publicTitle: c.gameTitle, description: c.gameTitle, archetype: "game",
    sources: [{ id: sourceId, label: "Project", path: c.unity.projectPath, contentGlobs: c.discovery.contentGlobs }], primarySourceId: sourceId,
    discovery: { initialDays: c.discovery.initialDays },
    captureTargets: [{ id: targetId, label: "Unity editor", kind: "unity-mcp", config: { ...c.unity.mcp, projectPath: c.unity.projectPath } }], defaultCaptureTargetId: targetId,
    narration, theme: c.theme,
    publishing: { ...publishing, attribution: c.publishing.attribution, connectionId },
    outputs: { enabled: ["portrait", "landscape"], articleTemplate: ARTICLE_TEMPLATE },
  };
}
