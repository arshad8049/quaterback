// Run: node build.js
// Assembles all section files in src/ into a single index.html
const fs = require('fs');

const sections = [
  'nav',
  'hero',
  'social-proof',
  'today-vs-future',
  'the-gap',
  'north-star-metric',
  'the-loop',
  'task-contract',
  'verification',
  'repair',
  'report',
  'positioning',
  'beta-cta',
  'footer',
];

let body = '';
for (const s of sections) {
  const content = fs.readFileSync(`src/${s}.html`, 'utf8').trim();
  body += `\n\n  <!-- ============================================================ -->\n`;
  body += `  <!-- SECTION: ${s.toUpperCase()} → edit: src/${s}.html -->\n`;
  body += `  <!-- ============================================================ -->\n`;
  body += '  ' + content.split('\n').join('\n  ') + '\n';
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quarterback — Intent to Verified Result</title>

  <!-- Favicon -->
  <link rel="icon" type="image/png" href="./favicon.png">
  <link rel="apple-touch-icon" href="./favicon.png">

  <!-- Fonts → edit: src/styles/fonts.css -->
  <link rel="stylesheet" href="./src/styles/fonts.css">

  <!-- Styles → edit: src/styles/main.css -->
  <link rel="stylesheet" href="./src/styles/main.css">

  <!-- Scripts (order matters) -->
  <script src="./src/scripts/react.js"></script>
  <script src="./src/scripts/react-dom.js"></script>
  <script src="./src/scripts/dc-runtime.js"></script>
</head>
<body>
<div style="width: 100%; background: #0D100F; color: #F4F1EA; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; -webkit-font-smoothing: antialiased;">${body}
</div>

<!-- Interactions → edit: src/scripts/interactions.js -->
<script src="./src/scripts/interactions.js" defer></script>
</body>
</html>
`;

fs.writeFileSync('index.html', html);
console.log(`Built index.html (${html.length} chars)`);
