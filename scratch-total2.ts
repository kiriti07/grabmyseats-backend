import fs from "node:fs";
import path from "node:path";
import { extractTextFromImage } from "./src/lib/ocr";
import { parseListingText } from "./src/lib/parseListingText";

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
    const { text, lines } = await extractTextFromImage(buffer);
    const fields = parseListingText(text, lines);
    console.log(file, "-> totalAmountPaid:", fields.totalAmountPaid);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
