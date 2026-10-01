import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./styles.css";
import App from "./App";
import { initDrafts } from "./drafts";
void initDrafts().then(() => createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)).catch(() => {
  document.getElementById("root")!.textContent = "无法恢复本地草稿。请确认浏览器为最新版本、允许保存本地数据，然后重试。已有草稿未删除。";
});
