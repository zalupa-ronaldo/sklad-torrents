/**
 * NTFS file index on the existing PC agent.
 * Loaded only for /v1/index/*. Job routes stay in server.mjs.
 */
export async function handleFileIndex(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "index") return false;
  try {
    const index = await loadIndex();
    if (req.method === "GET" && parts[2] === "health") {
      send(res, 200, await index.health());
      return true;
    }
    if (req.method === "GET" && parts[2] === "status") {
      const volume = url.searchParams.get("volume") || undefined;
      const health = await index.health();
      send(res, 200, { ...health, statuses: index.status(volume) });
      return true;
    }
    if (req.method === "GET" && parts[2] === "search") {
      const query = url.searchParams.get("q") || "";
      const volume = url.searchParams.get("volume") || undefined;
      const directoriesOnly = url.searchParams.get("directories") === "1";
      send(res, 200, { hits: index.search(query, { volume, directoriesOnly, limit: 80 }) });
      return true;
    }
    if (req.method === "POST" && parts[2] === "build") {
      const body = await readJson(req);
      send(res, 200, await index.build(body));
      return true;
    }
    send(res, 404, { error: "Нет такого метода индекса." });
    return true;
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : "Индекс не ответил." });
    return true;
  }
}

let loading;

function loadIndex() {
  if (!loading) {
    loading = import("../../src/addons/media-games/file-index/agent-runtime.ts")
      .then((mod) => mod.agentIndex())
      .catch((error) => {
        loading = undefined;
        const detail = error instanceof Error ? error.message : "импорт";
        throw new Error(`Индекс MFT не загрузился (${detail}).`);
      });
  }
  return loading;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Слишком большой запрос."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Не удалось разобрать запрос."));
      }
    });
    req.on("error", () => reject(new Error("Не удалось прочитать запрос.")));
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
