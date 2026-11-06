// Builds the photo bank (bank.json): a long list of real photos from Wikimedia Commons.
// Only links + year + city + credit are saved, never the pictures themselves.
// Run it once on your computer before you upload the game:   node build-bank.js 1000
// You can stop it any time (control + C). Next time it carries on where it stopped.
const fs = require("fs");
const path = require("path");
const { growBank, status } = require("./photos");

const FILE = path.join(__dirname, "bank.json");
const goal = Number(process.argv[2]) || 1000;
let bank = [];
try { bank = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
const tried = new Set();

const save = () => fs.writeFileSync(FILE, JSON.stringify(bank, null, 0).replace(/\},\{/g, "},\n{"));
const started = Date.now();
console.log(`\nPhoto bank: ${bank.length} photos now. Looking for ${Math.max(0, goal - bank.length)} more (goal ${goal}).`);
console.log("This takes a while (Wikimedia asks us to go slowly). You can leave it running.\n");
if (bank.length >= goal) { console.log("Already done. Nothing to do."); process.exit(0); }

let lastSave = 0;
growBank(bank, goal - bank.length, {
  tried,
  log: m => console.log("  " + m),
  onFound: p => {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`  ${String(bank.length).padStart(4)} / ${goal}   ${p.year}  ${p.city.padEnd(16)} ${mins} min`);
    if (bank.length - lastSave >= 10) { save(); lastSave = bank.length; }
  }
}).then(n => {
  save();
  const byDec = {};
  bank.forEach(p => { const d = Math.floor(p.year / 10) * 10 + "s"; byDec[d] = (byDec[d] || 0) + 1; });
  console.log(`\nDone. Added ${n}. The bank has ${bank.length} photos:`);
  console.log("  " + Object.keys(byDec).sort().map(d => `${d}: ${byDec[d]}`).join("   "));
  console.log("\nSaved in bank.json. You can close this window.\n");
}).catch(e => { save(); console.log("\nStopped: " + e.message + (status.note ? ` (${status.note})` : "") + "\nWhat we found so far is saved. Run it again later to continue.\n"); process.exit(1); });

process.on("SIGINT", () => { save(); console.log(`\nStopped. ${bank.length} photos saved in bank.json.\n`); process.exit(0); });
