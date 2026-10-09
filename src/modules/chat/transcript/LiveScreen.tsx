type LiveScreenProps = {
  lines: string[];
};

/**
 * What the Claude TUI is printing at this moment (thinking spinner, streamed
 * text, running tool output) before it lands in the transcript.
 */
export default function LiveScreen({ lines }: LiveScreenProps) {
  if (lines.length === 0) {
    return null;
  }
  return (
    <div className="mx-auto w-full max-w-4xl px-3 sm:px-4" data-testid="live-screen">
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-dashed bg-muted/40 p-2 font-mono text-[11px] leading-snug text-muted-foreground">
        {lines.join('\n')}
      </pre>
    </div>
  );
}
