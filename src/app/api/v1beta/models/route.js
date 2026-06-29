import { PROVIDER_MODELS } from "@/shared/constants/models";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET() {
  try {
    const models = [];
    const seen = new Set();
    const addModel = (name, provider, model) => {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName: model.name || model.id,
        description: `${provider} model: ${model.name || model.id}`,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    };
    
    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        addModel(`models/${provider}/${model.id}`, provider, model);
        if (provider === "gemini" || provider === "gemini-tts-models") {
          addModel(`models/${model.id}`, provider, model);
        }
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}

