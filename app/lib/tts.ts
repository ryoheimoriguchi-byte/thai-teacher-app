/**
 * Web Speech API による読み上げ。クライアントからのみ呼び出すこと。
 */

const PREFERRED_VOICE_NAMES: Record<string, readonly string[]> = {
  ja: ["Kyoko"],
  th: ["Kanya", "Microsoft Pattara - Thai (Thailand)"],
};

function normalizeLangCode(lang: string): string {
  const part = lang.trim().split(/[-_]/)[0];
  return part ? part.toLowerCase() : "";
}

function pickVoice(
  voices: SpeechSynthesisVoice[],
  langCode: string
): SpeechSynthesisVoice | undefined {
  const code = langCode.toLowerCase();
  if (!code) return undefined;

  const preferred = PREFERRED_VOICE_NAMES[code];
  if (preferred?.length) {
    for (const name of preferred) {
      const v = voices.find((voice) => voice.name === name);
      if (v) return v;
    }
  }

  return voices.find((v) => v.lang.toLowerCase().startsWith(code));
}

/**
 * @param text 読み上げテキスト
 * @param lang BCP 47 風（例: ja-JP, th-TH）。utterance.lang にそのまま設定する。
 */
export function speak(text: string, lang: string): void {
  if (typeof window === "undefined") return;

  try {
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.7;
    utterance.volume = 1.0;
    utterance.pitch = 1.0;

    const langCode = normalizeLangCode(lang);

    const trySpeak = () => {
      const voices = window.speechSynthesis.getVoices();
      const voice = pickVoice(voices, langCode);
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
      window.speechSynthesis.onvoiceschanged = null;
    };

    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.onvoiceschanged = trySpeak;
    } else {
      trySpeak();
    }
  } catch (e) {
    console.error("Speech error:", e);
  }
}
