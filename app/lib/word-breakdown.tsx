type WordBreakdownProps = {
  breakdown: string | null | undefined;
};

export function hasBreakdown(breakdown: string | null | undefined): boolean {
  return Boolean(breakdown && breakdown.trim() !== "");
}

export function WordBreakdown({ breakdown }: WordBreakdownProps) {
  if (!hasBreakdown(breakdown)) return null;

  const parts = breakdown!
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  return (
    <div
      style={{
        borderTop: "0.5px solid rgba(0,0,0,0.1)",
        paddingTop: 12,
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ fontSize: 18, lineHeight: 1.2 }}>💡</span>
        <div>
          {parts.map((part, i) => (
            <p
              key={i}
              style={{
                margin: i === parts.length - 1 ? 0 : "0 0 4px",
                fontSize: 14,
                color: "inherit",
              }}
            >
              {part}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

type CardWithBreakdown = { id: string; breakdown?: string | null };

/** Renders one WordBreakdown block per card that has breakdown text. */
export function WordBreakdownList({
  cards,
  cardIds,
}: {
  cards: CardWithBreakdown[];
  cardIds: string[];
}) {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const id of cardIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = cards.find((c) => c.id === id);
    if (hasBreakdown(card?.breakdown)) {
      blocks.push(card!.breakdown!.trim());
    }
  }
  if (blocks.length === 0) return null;
  return (
    <>
      {blocks.map((text, i) => (
        <WordBreakdown key={`${i}-${text.slice(0, 12)}`} breakdown={text} />
      ))}
    </>
  );
}
