// Writes the privacy policy and account deletion pages to ../docs for GitHub Pages,
// so the URLs given to the app stores stay up even while the API server sleeps.
//   SUPPORT_EMAIL=you@example.com npm run pages
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_NAME ||= 'eCampus MMU';
process.env.SUPPORT_EMAIL ||= 'samuel.ocen@mmu.ac.ug';
const WEB_URL = process.env.WEB_URL || 'https://ecampus-mmu.onrender.com/';

const { privacyPage, deletionPage } = await import('../src/routes/public-pages.js');
const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');

const write = (rel, html) => {
  const file = path.join(docs, rel, 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  console.log('wrote', path.relative(process.cwd(), file));
};

write('privacy', privacyPage({ deletionHref: '../account-deletion/' }));
write('account-deletion', deletionPage({ webHref: WEB_URL }));
// Plain static files: no Jekyll processing.
fs.writeFileSync(path.join(docs, '.nojekyll'), '');
