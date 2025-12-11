export const KeyWords = ["Coco", "ENS", "Bot"];

// splits by any non-word character
export function containsAllKeywords(message: string): boolean {
  const tokens = message.toLowerCase().split(/\W+/);
  return KeyWords.every((kw) => tokens.includes(kw.toLowerCase()));
}
