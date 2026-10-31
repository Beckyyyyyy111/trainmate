// Model IDs live here so they can be swapped without touching the rest of the app.
export const MODELS = {
  // Multimodal understanding: text, audio and images in, JSON out.
  flash: 'gemini-3.8-flash',
  // Expressive speech output.
  tts: 'gemini-3.8-flash-tts',
};

export const TTS_VOICE = 'Kore';

// Demo only: the key is shipped to the browser. Put it in .env.local, never commit it.
export const GEMINI_API_KEY: string = import.meta.env.VITE_GEMINI_API_KEY ?? '';

export const hasGeminiKey = () => GEMINI_API_KEY.length > 0 && GEMINI_API_KEY !== 'paste-your-key-here';
