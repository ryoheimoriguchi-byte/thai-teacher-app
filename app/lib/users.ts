export type AppUser = {
  id: string;
  name: string;
  language: "TH" | "JP";
  flag: string;
};

export const LANGUAGE_MAP: Record<string, "TH" | "JP"> = {
  "04c08f29-b048-4333-98d6-194eddff2006": "TH", // Dad
  "a088138c-a25e-4112-809f-02d1b63dc45a": "JP", // Mirei
};

export const FLAG_MAP: Record<"TH" | "JP", string> = {
  TH: "🇹🇭",
  JP: "🇯🇵",
};