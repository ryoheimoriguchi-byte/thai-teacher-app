import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const h46 =
  "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
const k46 =
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
const h25 = "がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ";
const k25 = "ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ";

const pairs = [];
for (let i = 0; i < 46; i++) pairs.push([h46[i], 1 + i]);
for (let i = 0; i < 25; i++) pairs.push([h25[i], 47 + i]);
for (let i = 0; i < 46; i++) pairs.push([k46[i], 72 + i]);
for (let i = 0; i < 25; i++) pairs.push([k25[i], 118 + i]);

const esc = (s) => s.replace(/'/g, "''");

const valueLines = pairs.map(
  ([w, o]) => `  ('${esc(w)}', ${o})`
);

const sql = `-- Add display_order for Japanese character cards (gojūon + daku/han-daku order).
-- Word rows (type = 'word') keep display_order NULL.

begin;

alter table public.cards
  add column if not exists display_order integer;

update public.cards as c
set display_order = m.ord
from (
  values
${valueLines.join(",\n")}
) as m(word, ord)
where c.type = 'character'
  and c.word = m.word;

commit;
`;

const out = path.join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260513130000_add_display_order.sql"
);
fs.writeFileSync(out, sql, "utf8");
console.log("Wrote", out, "pairs:", pairs.length);
