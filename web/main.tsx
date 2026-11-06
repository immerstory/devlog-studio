import React from "react";
import { createRoot } from "react-dom/client";
import extensions from "virtual:devlog-extensions";
import { App } from "./App";
import { installExtension } from "../video/extensions";
import "./globals.css";
import "./styles.css";

extensions.forEach(installExtension);

createRoot(document.getElementById("root")!).render(<App />);
