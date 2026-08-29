/** Renders the Markdown a model writes into the small HTML subset Telegram actually displays. */

const ESCAPES: Array<[RegExp, string]> = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
];

function escapeHtml(text: string): string {
  return ESCAPES.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

export function toTelegramHtml(markdown: string): string {
  // Escape first: every regex below then operates on text that can no longer produce a stray tag, and the markdown punctuation it matches.
  let s = escapeHtml(markdown);

  // Fenced and inline code before anything else, so markup inside code spans is shown rather than interpreted.
  s = s.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.replace(/\n$/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Links. A self-link ([url]) is what small models produce around a payment URL; showing it once, unwrapped, beats a 100-character label.
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    const href = url.replace(/"/g, "&quot;");
    const text = label.trim();
    if (!text || text === url.trim()) return url;
    return `<a href="${href}">${text}</a>`;
  });

  // Headings become bold lines; Telegram has no heading tag.
  s = s.replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");

  // Bullets before emphasis, so a leading "* " is never read as italic.
  s = s.replace(/^[ \t]*[-*][ \t]+/gm, "• ");

  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])__([^_\n]+)__(?=[\s).,!?:;]|$)/g, "$1<b>$2</b>");
  // Single underscores only when clearly word-delimited: identifiers like chk_01m1rk4mfz...
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");

  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** The same content with all markup removed, for the plain-text retry. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
      label.trim() === url.trim() || !label.trim() ? url : `${label}: ${url}`
    )
    .replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/(^|[\s(])__([^_\n]+)__(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/^[ \t]*[-*][ \t]+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
