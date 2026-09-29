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
  <title>Quarterback — AI Coding Runtime: Intent to Verified Result</title>
  <meta name="description" content="Quarterback is a local-first AI coding runtime. Turns natural-language requests into verified code changes — DSA pipeline, majority-vote LLM judgment, zero API keys required.">

  <!-- Canonical -->
  <link rel="canonical" href="https://quaterback.velorallc.workers.dev/">

  <!-- Favicon -->
  <link rel="icon" type="image/png" href="./favicon.png">
  <link rel="apple-touch-icon" href="./favicon.png">

  <!-- Open Graph -->
  <meta property="og:type"        content="website">
  <meta property="og:site_name"   content="Quarterback">
  <meta property="og:url"         content="https://quaterback.velorallc.workers.dev/">
  <meta property="og:title"       content="Quarterback — AI Coding Runtime: Intent to Verified Result">
  <meta property="og:description" content="Local-first AI coding runtime. Turns natural-language requests into verified code changes — DSA pipeline, majority-vote LLM judgment, zero API keys. 6/6 tasks correct vs 2/6 baseline.">
  <meta property="og:image"       content="https://quaterback.velorallc.workers.dev/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt"   content="Quarterback — AI coding runtime diagram showing Intent → Context → Agent → Verify pipeline">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="Quarterback — AI Coding Runtime: Intent to Verified Result">
  <meta name="twitter:description" content="Local-first AI coding runtime. DSA pipeline + majority-vote LLM judgment. 6/6 tasks correct vs 2/6 baseline. Zero API keys.">
  <meta name="twitter:image"       content="https://quaterback.velorallc.workers.dev/og-image.png">

  <!-- Security -->
  <meta http-equiv="X-Content-Type-Options" content="nosniff">
  <meta http-equiv="X-Frame-Options" content="DENY">
  <meta name="referrer" content="strict-origin-when-cross-origin">

  <!-- JSON-LD structured data -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Quarterback",
    "description": "Local-first AI coding runtime that turns natural-language requests into verified code changes. Uses a deterministic DSA pipeline and majority-vote LLM judgment. Zero API keys required.",
    "url": "https://quaterback.velorallc.workers.dev/",
    "applicationCategory": "DeveloperApplication",
    "operatingSystem": "macOS, Linux, Windows",
    "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    "author": { "@type": "Organization", "name": "Velora", "url": "https://velorallc.netlify.app/" }
  }
  </script>

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
