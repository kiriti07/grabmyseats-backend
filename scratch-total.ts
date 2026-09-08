import fs from "node:fs";
import path from "node:path";
import { extractTextFromImage } from "./src/lib/ocr";

const files = [
  "irumudi-app-share.jpeg",
  "drishyam3-app-share.jpeg",
  "ustaad-bhagat-singh-app-share.jpeg",
  "irumudi-static-card.jpg",
  "hokum-static-card.jpeg",
];

async function main() {
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(__dirname, "src/lib/__fixtures__/tickets", file));
    const { text } = await extractTextFromImage(buffer);
    const line = text.split("\n").find((l) => /total/i.test(l));
    console.log(file, "->", JSON.stringify(line ?? "(no Total line found)"));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
