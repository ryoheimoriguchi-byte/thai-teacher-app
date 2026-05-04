export type AppUser = {
    id: string;
    name: string;
    language: "TH" | "JP";
    flag: string;
  };
  
  export const USERS: AppUser[] = [
    {
      id: "04c08f29-b048-4333-98d6-194eddff2006",
      name: "Dad",
      language: "TH",
      flag: "🇹🇭",
    },
    {
      id: "a088138c-a25e-4112-809f-02d1b63dc45a",
      name: "Mirei",
      language: "JP",
      flag: "🇯🇵",
    },
  ];