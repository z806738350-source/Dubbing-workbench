// Paid diagnostic: runs the real analysis pipeline against an isolated copy.
// Only the authorized first chapter is submitted. No drafts are adopted.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { join } from "node:path";
import { openStore } from "../server/store.mjs";
import { createDomain } from "../server/domain.mjs";
import { createAnalysis } from "../server/analysis.mjs";

const model = process.argv[2];
const replayDirectory = process.argv[3];
if (
  !["gemini-3.6-flash", "gemini-3.8-flash", "DeepSeek-V4-Pro"].includes(model)
)
  throw new Error("Choose an explicitly authorized comparison model");
process.loadEnvFile(".env.kunpo");
if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.KUNPO_API_KEY;
if (!key) throw new Error("Missing API key");
const baseUrl =
  (process.env.KUNPO_BASE_URL || "https://llm.ziy.cc/v1")
    .replace(/\/$/, "")
    .replace(/\/v1$/, "") + "/v1";
const nativeFetch = globalThis.fetch;
const local = await nativeFetch("http://127.0.0.1:4318/api/state").then((r) =>
  r.json(),
);
const chapter = local.chapters.find(
  (c) => c.id === "8af46485-7c77-4917-ba15-325059ee335d",
);
if (!chapter) throw new Error("Authorized chapter missing");
const project = local.projects.find((p) => p.id === chapter.projectId);
const directory = join(
  "data/live-smoke/model-comparison",
  `${model}-${Date.now()}`,
);
mkdirSync(directory, { recursive: true });
const store = openStore(directory);
store.put("projects", project);
store.put("chapters", chapter, project.id);
for (const role of local.roles.filter((r) => r.projectId === project.id))
  store.put("roles", role, project.id);
const calls = [];
const safe = (value) =>
  JSON.stringify(value, null, 2)
    .replaceAll(key, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
const save = (name, value) => writeFileSync(join(directory, name), safe(value));
globalThis.fetch = async (url, init) => {
  const n = calls.length + 1,
    started = Date.now();
  const request = JSON.parse(init.body);
  save(`request-${n}.json`, request);
  console.log(JSON.stringify({ model, batch: n, stage: "sending" }));
  const call = { batch: n, startedAt: new Date(started).toISOString() };
  calls.push(call);
  try {
    const replay =
      replayDirectory && join(replayDirectory, `response-${n}.json`);
    if (replay && existsSync(replay)) {
      const previousRequest = JSON.parse(
        readFileSync(join(replayDirectory, `request-${n}.json`), "utf8"),
      );
      // A complete earlier response can be replayed at a higher token ceiling.
      delete previousRequest.max_tokens;
      if (Object.hasOwn(request, "max_tokens"))
        previousRequest.max_tokens = request.max_tokens;
      deepStrictEqual(request, previousRequest);
      const data = JSON.parse(readFileSync(replay, "utf8"));
      const originalCall = JSON.parse(
        readFileSync(join(replayDirectory, "calls.json"), "utf8"),
      )[n - 1];
      Object.assign(call, originalCall, { replayed: true });
      save(`response-${n}.json`, data);
      console.log(
        JSON.stringify({ model, batch: n, stage: "replayed without charge" }),
      );
      return Response.json(data, { status: originalCall.status });
    }
    const response = await nativeFetch(url, init);
    const raw = await response.clone().text();
    Object.assign(call, {
      status: response.status,
      elapsedMs: Date.now() - started,
    });
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    save(`response-${n}.json`, data);
    call.finishReason = data.choices?.[0]?.finish_reason;
    call.usage = data.usage;
    if (!response.ok) call.error = data.error || data;
    console.log(
      safe({
        model,
        batch: n,
        status: call.status,
        elapsedMs: call.elapsedMs,
        finishReason: call.finishReason,
        totalTokens: call.usage?.total_tokens,
        error: call.error,
      }),
    );
    return response;
  } catch (error) {
    Object.assign(call, {
      elapsedMs: Date.now() - started,
      errorType: error.name,
    });
    throw error;
  } finally {
    save("calls.json", calls);
  }
};
const analysis = createAnalysis(store, createDomain(store), { key, baseUrl });
const record = await analysis.start({
  chapterId: chapter.id,
  revision: chapter.revision,
  model,
});
await analysis.close();
const result = store.get("suggestions", record.id);
save("result.json", result);
console.log(
  safe({
    directory,
    model,
    status: result.status,
    error: result.error,
    doneChunks: result.doneChunks,
    totalChunks: result.totalChunks,
    items: result.items.length,
  }),
);
store.close();
