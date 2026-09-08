export const ALL_CATEGORIES = "__all__";

type CategoryCard = {
  category?: string | null;
};

const normalize = (category: string | null | undefined) => category?.trim() ?? "";

/**
 * Build the category dropdown options.
 *
 * When `onlyUnmastered` is true ("Not yet mastered" is active), categories whose
 * cards are all mastered are dropped. The currently selected category is always
 * kept so the select never renders a value that is missing from its options.
 */
export function buildCategoryOptions<T extends CategoryCard>(
  cards: T[],
  {
    onlyUnmastered,
    isMastered,
    selected,
  }: {
    onlyUnmastered: boolean;
    isMastered: (card: T) => boolean;
    selected: string;
  }
): string[] {
  const remaining = new Map<string, number>();

  for (const card of cards) {
    const category = normalize(card.category);
    if (!category) continue;
    const left = remaining.get(category) ?? 0;
    remaining.set(category, left + (isMastered(card) ? 0 : 1));
  }

  return [...remaining.entries()]
    .filter(([category, left]) => !onlyUnmastered || left > 0 || category === selected)
    .map(([category]) => category)
    .sort((a, b) => a.localeCompare(b));
}

export function filterByCategory<T extends CategoryCard>(cards: T[], selected: string): T[] {
  if (selected === ALL_CATEGORIES) return cards;
  return cards.filter((card) => normalize(card.category) === selected);
}

export function CategoryFilterSelect({
  value,
  categories,
  onChange,
}: {
  value: string;
  categories: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "6px 12px",
          borderRadius: "20px",
          border: value === ALL_CATEGORIES ? "1px solid #ccc" : "2px solid #ff9800",
          background: value === ALL_CATEGORIES ? "white" : "#fff3e0",
          color: "#111",
          fontSize: "13px",
          fontWeight: value === ALL_CATEGORIES ? "normal" : "bold",
          cursor: "pointer",
          maxWidth: "100%",
        }}
      >
        <option value={ALL_CATEGORIES}>All categories</option>
        {categories.map((category) => (
          <option key={category} value={category}>
            {category}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CategoryNotice({
  tone,
  title,
  detail,
}: {
  tone: "success" | "info";
  title: string;
  detail: string;
}) {
  const palette =
    tone === "success"
      ? { background: "#e8f5e9", border: "#4caf50", title: "#2e7d32" }
      : { background: "#e3f2fd", border: "#90caf9", title: "#1565c0" };

  return (
    <div
      style={{
        background: palette.background,
        border: `1px solid ${palette.border}`,
        borderRadius: "8px",
        padding: "24px",
        marginBottom: "1rem",
        textAlign: "center",
      }}
    >
      <p style={{ margin: 0, color: palette.title, fontWeight: "bold", fontSize: "18px" }}>
        {title}
      </p>
      <p style={{ margin: "8px 0 0", color: "#666", fontSize: "14px" }}>{detail}</p>
    </div>
  );
}
