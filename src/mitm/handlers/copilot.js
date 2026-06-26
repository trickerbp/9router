const { err } = require("../logger");
const { fetchRouter, watchClientAbort, pipeSSE } = require("./base");

// Map Copilot endpoint → 9Router path
const URL_MAP = {
  "/chat/completions": "/v1/chat/completions",
  "/v1/messages":      "/v1/messages",
  "/responses":        "/v1/responses",
};

function resolveRouterPath(reqUrl) {
  for (const [pattern, routerPath] of Object.entries(URL_MAP)) {
    if (reqUrl.includes(pattern)) return routerPath;
  }
  return "/v1/chat/completions";
}

/**
 * Intercept Copilot request — replace model and forward to matching 9Router endpoint
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  try {
    const body = JSON.parse(bodyBuffer.toString());
    body.model = mappedModel;
    const routerPath = resolveRouterPath(req.url);
    const { controller, cleanup } = watchClientAbort(req, res);
    try {
      const routerRes = await fetchRouter(body, routerPath, req.headers, controller.signal);
      await pipeSSE(routerRes, res);
    } finally {
      cleanup();
    }
  } catch (error) {
    err(`[copilot] ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
  }
}

module.exports = { intercept };
