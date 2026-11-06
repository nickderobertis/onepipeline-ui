// SPIKE: throwaway stand-in for @onetaskgraph/ui's TaskMarkdown. Nothing here lands.
import Markdown from "react-markdown";

export function TaskMarkdown({
  source,
  clamp,
}: {
  readonly source: string;
  readonly clamp?: number;
}) {
  return (
    <div
      className="spike-md"
      data-clamp={clamp !== undefined}
      style={clamp === undefined ? undefined : { WebkitLineClamp: clamp }}
    >
      <Markdown
        components={{
          a: ({ href, children }) => (
            <a href={href} rel="noopener noreferrer" target="_blank">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <a href={String(src)} rel="noopener noreferrer" target="_blank">
              {alt || "image"}
            </a>
          ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
