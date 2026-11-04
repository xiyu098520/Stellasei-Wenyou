"use client";

export type TextProvider = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type Settings = {
  text: TextProvider;
  assistant: TextProvider;
  voice: {
    provider: string;
    apiKey: string;
    defaultVoiceId: string;
    model: string;
    speed: number;
    // 念出来的语言：zh 跟正文走，ja 念日文（音色是日文声线时用）
    lang: "zh" | "ja";
    // 只给设置页「测一下」试听用，剧情台词的语气由演出引擎按句标注
    tone?: string;
  };
  search: {
    provider: "bocha" | "tavily";
    apiKey: string;
  };
  image: {
    enabled: boolean;
  };
};

export const defaultSettings: Settings = {
  text: {
    provider: "自定义",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "",
  },
  assistant: {
    provider: "自定义",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "",
  },
  voice: {
    provider: "ElevenLabs",
    apiKey: "",
    defaultVoiceId: "21m00Tcm4TlvDq8ikWAM",
    model: "eleven_multilingual_v2",
    speed: 1,
    lang: "zh",
    tone: "",
  },
  search: {
    provider: "bocha",
    apiKey: "",
  },
  image: { enabled: false },
};

const KEY = "wenyou.settings";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw);
    return {
      text: { ...defaultSettings.text, ...parsed.text },
      assistant: { ...defaultSettings.assistant, ...parsed.assistant },
      voice: { ...defaultSettings.voice, ...parsed.voice },
      search: { ...defaultSettings.search, ...parsed.search },
      image: { ...defaultSettings.image, ...parsed.image },
    };
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
  window.dispatchEvent(new Event("wenyou:settings"));
}
