import { createContext } from "react";
import type { CaptureTarget } from "../shared/projects";

/** The project's capture targets and its default target, for the shot editor. */
export const CaptureTargetsContext = createContext<{ targets: CaptureTarget[]; defaultId?: string }>({ targets: [] });
