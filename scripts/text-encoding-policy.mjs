const MOJIBAKE_PATTERNS = [
  /\uFFFD/u,
  /(?:\u7e3a|\u7e67|\u8b41|\u9666|\u873f|\u8389|\u8373|\u8b16|\u879f|\u9015|\u9aef|\u9b06){3,}/u,
  /\u7e3a/u,
  /\u8b41\u30fb/u,
];

export function containsLikelyMojibake(text) {
  return MOJIBAKE_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}
