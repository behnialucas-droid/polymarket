const fs = require('fs');
const path = require('path');

function processDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(fullPath);
    } else if (entry.isFile() && fullPath.endsWith('page.tsx')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      
      content = content.replace(/export default function (\w+)\((.*?)\)/, 'export default async function $1($2)');
      
      const importsMatch = content.match(/import\s+{([^}]+)}\s+from\s+['"].*queries(\.ts)?['"]/);
      if (importsMatch) {
        const queryFns = importsMatch[1].split(',').map(s => {
           let token = s.trim().split(' as ');
           return token.length > 1 ? token[1].trim() : token[0].trim();
        });
        for (const fn of queryFns) {
           const regex = new RegExp(`(?<!await\\s+)(${fn}\\(.*?\\))`, 'g');
           content = content.replace(regex, 'await $1');
        }
      }
      fs.writeFileSync(fullPath, content);
      console.log(`Refactored ${fullPath}`);
    }
  }
}
processDir('./app');

let layout = fs.readFileSync('./app/layout.tsx', 'utf8');
layout = layout.replace(/export default function RootLayout/, 'export default async function RootLayout');
layout = layout.replace(/(?<!await\s+)(hasDemoData\(\))/, 'await $1');
fs.writeFileSync('./app/layout.tsx', layout);
console.log('Refactored layout.tsx');

