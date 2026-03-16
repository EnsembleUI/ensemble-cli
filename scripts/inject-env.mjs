import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', 'src', 'config', 'env.ts');

const replacements = [
  {
    placeholder: `'__ENSEMBLE_FIREBASE_API_KEY__'`,
    value: process.env.ENSEMBLE_FIREBASE_API_KEY,
  },
];

let text = fs.readFileSync(envPath, 'utf8');

for (const { placeholder, value } of replacements) {
  if (!value) continue;
  const literal = `'${value}'`;
  text = text.split(placeholder).join(literal);
}

fs.writeFileSync(envPath, text, 'utf8');
