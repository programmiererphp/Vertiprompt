const API_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Fetches the list of available models from OpenRouter.
 * @returns {Promise<Array>} A promise that resolves to an array of model objects.
 */
export async function fetchModels() {
  try {
    const response = await fetch(`${API_BASE_URL}/models`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.data;
  } catch (error) {
    console.error("Failed to fetch models:", error);
    return [];
  }
}

/**
 * Calls the OpenRouter Chat Completions API.
 * @param {object} options
 * @param {string} options.apiKey - The user's OpenRouter API key.
 * @param {string} options.model - The model to use for the completion.
 * @param {Array} options.messages - The array of message objects.
 * @param {number} options.max_tokens - The maximum number of tokens to generate.
 * @param {number} options.temperature - The sampling temperature.
 * @param {object} [options.response_format] - Optional response format object (e.g., { type: "json_object" }).
 * @returns {Promise<object>} A promise that resolves to the API response data.
 */
export async function callOpenRouter({ apiKey, model, messages, max_tokens, temperature, response_format }) {
  if (!apiKey) {
    throw new Error("OpenRouter API key is missing.");
  }
  
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://vertiprompt.github.io", // Replace with your actual URL
    "X-Title": "VertiPrompt"
  };
  
  const bodyPayload = {
    model,
    messages,
    max_tokens,
    temperature,
  };
  
  // Add response_format only if it's provided
  if (response_format) {
    bodyPayload.response_format = response_format;
  }
  
  const body = JSON.stringify(bodyPayload);
  
  const response = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body
  });
  
  const responseData = await response.json();
  
  if (!response.ok) {
    const error = new Error(responseData.error?.message || `HTTP Error: ${response.status}`);
    error.status = response.status;
    error.data = responseData;
    throw error;
  }
  
  return responseData;
}