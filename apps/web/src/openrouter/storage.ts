export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-3.5-sonnet';

export const SUGGESTED_OPENROUTER_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (recommended)' },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku (faster, cheaper)' },
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'google/gemini-pro-1.5', label: 'Gemini Pro 1.5' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B Instruct' },
];

const API_KEY_STORAGE_KEY = 'openrouter:apiKey';
const MODEL_STORAGE_KEY = 'openrouter:model';

export function loadOpenRouterApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveOpenRouterApiKey(value: string): void {
  try {
    if (value) {
      localStorage.setItem(API_KEY_STORAGE_KEY, value);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  } catch {
    // storage may be unavailable in some environments
  }
}

export function loadOpenRouterModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_OPENROUTER_MODEL;
  } catch {
    return DEFAULT_OPENROUTER_MODEL;
  }
}

export function saveOpenRouterModel(value: string): void {
  try {
    if (value) {
      localStorage.setItem(MODEL_STORAGE_KEY, value);
    } else {
      localStorage.removeItem(MODEL_STORAGE_KEY);
    }
  } catch {
    // storage may be unavailable in some environments
  }
}

export interface OpenRouterSettings {
  apiKey: string;
  model: string;
}

/**
 * These settings are now editable from two places — the global Settings dialog
 * and the editor's own toolbar — so localStorage alone is not enough: whichever
 * component is *not* doing the writing would keep serving a stale copy until it
 * remounted. Writers go through {@link saveOpenRouterSettings}, readers keep
 * themselves current with {@link subscribeToOpenRouterSettings}.
 */
const SETTINGS_CHANGED_EVENT = 'openrouter:settings-changed';

export function loadOpenRouterSettings(): OpenRouterSettings {
  return { apiKey: loadOpenRouterApiKey(), model: loadOpenRouterModel() };
}

/** Persists trimmed settings, notifies every subscriber, returns what was stored. */
export function saveOpenRouterSettings(next: OpenRouterSettings): OpenRouterSettings {
  const resolved: OpenRouterSettings = {
    apiKey: next.apiKey.trim(),
    model: next.model.trim() || DEFAULT_OPENROUTER_MODEL,
  };

  saveOpenRouterApiKey(resolved.apiKey);
  saveOpenRouterModel(resolved.model);

  try {
    window.dispatchEvent(
      new CustomEvent<OpenRouterSettings>(SETTINGS_CHANGED_EVENT, { detail: resolved }),
    );
  } catch {
    // no window (or no CustomEvent) — the write still landed
  }

  return resolved;
}

/** Subscribe to settings written by any other surface. Returns an unsubscribe fn. */
export function subscribeToOpenRouterSettings(
  listener: (next: OpenRouterSettings) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OpenRouterSettings>).detail;
    if (detail) {
      listener(detail);
    }
  };

  window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
}
