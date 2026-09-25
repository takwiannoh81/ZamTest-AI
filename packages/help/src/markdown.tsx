import type { ReactNode } from "react";

/**
 * The small Markdown the docs and the help assistant use (## / ### headings,
 * paragraphs, - and 1. lists, **bold**, `code`, [links](https://...)), turned
 * into React elements: no HTML is ever inserted, so a translation or an answer
 * cannot bring in scripts.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = inline(heading[2]!);
      blocks.push(level <= 2 ? <h3 key={key++}>{content}</h3> : <h4 key={key++}>{content}</h4>);
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      i++;
      blocks.push(
        <pre key={key++}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: ReactNode[] = [];
      while (i < lines.length && pattern.test(lines[i]!)) {
        let item = lines[i]!.replace(pattern, "");
        // Wrapped lines of the same item.
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!) && !bullet.test(lines[i + 1]!) && !numbered.test(lines[i + 1]!)) {
          item += " " + lines[++i]!.trim();
        }
        items.push(<li key={items.length}>{inline(item)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4})\s/.test(lines[i]!) && !bullet.test(lines[i]!) && !numbered.test(lines[i]!) && !/^```/.test(lines[i]!)) {
      paragraph.push(lines[i]!.trim());
      i++;
    }
    blocks.push(<p key={key++}>{inline(paragraph.join(" "))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

/** **bold**, `code` and [links](https://...) inside a line. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) out.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={k++}>{token.slice(1, -1)}</code>);
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const href = link[2]!;
      // Only web and mail links.
      out.push(
        /^(https?:|mailto:)/i.test(href) ? (
          <a key={k++} href={href} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          link[1]
        ),
      );
    }
    last = match.index! + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
