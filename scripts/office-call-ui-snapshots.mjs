import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outputDirectory = path.resolve(
  "docs/office-calling-phase-evidence/phase-6-assets",
);

const surfaces = [
  { name: "web", width: 1365, height: 900, title: "Office Calls", subtitle: "Web desktop / responsive contract" },
  { name: "ios", width: 430, height: 932, title: "অফিস কল", subtitle: "iOS native contract" },
  { name: "android", width: 412, height: 915, title: "Office Calls", subtitle: "Android native contract" },
];

const escapeXml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function snapshotSvg(surface) {
  const { width, height, title, subtitle } = surface;
  const margin = width > 600 ? 64 : 24;
  const contentWidth = width - margin * 2;
  const columns = width > 600 ? 4 : 2;
  const gap = 12;
  const cardWidth = (contentWidth - gap * (columns - 1)) / columns;
  const cardY = 190;
  const cards = [
    ["App voice call", "Private live audio"],
    ["Mobile call", "SIM / phone network"],
    ["Recorded PTT", "Hold to send voice"],
    ["Live walkie-talkie", "Office group live audio"],
  ];
  const cardsSvg = cards.map(([label, copy], index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * (cardWidth + gap);
    const y = cardY + row * 116;
    return `<rect x="${x}" y="${y}" width="${cardWidth}" height="100" rx="18" fill="#ffffff14" stroke="#ffffff24"/>
      <circle cx="${x + 30}" cy="${y + 32}" r="14" fill="#ff806d"/>
      <text x="${x + 52}" y="${y + 36}" class="card-title">${escapeXml(label)}</text>
      <text x="${x + 20}" y="${y + 72}" class="copy">${escapeXml(copy)}</text>`;
  }).join("\n");
  const sectionY = cardY + Math.ceil(cards.length / columns) * 116 + 20;
  const historyY = sectionY + 220;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071936"/><stop offset="0.5" stop-color="#2d1452"/><stop offset="1" stop-color="#691f50"/></linearGradient>
      <linearGradient id="action" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#ff775e"/><stop offset="1" stop-color="#e06191"/></linearGradient>
      <style>
        text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#fff}.title{font-size:${width > 600 ? 38 : 27}px;font-weight:800}.subtitle{font-size:14px;fill:#cbbcdf}.section{font-size:15px;font-weight:800;fill:#ffb3a8}.card-title{font-size:${width > 600 ? 15 : 13}px;font-weight:750}.copy{font-size:${width > 600 ? 13 : 11}px;fill:#d9cedf}.history{font-size:14px;font-weight:700}.meta{font-size:12px;fill:#cbbcdf}.badge{font-size:12px;font-weight:800}
      </style>
    </defs>
    <rect width="${width}" height="${height}" rx="${width > 600 ? 24 : 0}" fill="url(#bg)"/>
    <text x="${margin}" y="72" class="title">${escapeXml(title)}</text>
    <text x="${margin}" y="103" class="subtitle">${escapeXml(subtitle)}</text>
    <rect x="${margin}" y="126" width="${contentWidth}" height="2" rx="1" fill="#ffffff20"/>
    <text x="${margin}" y="166" class="section">COMMUNICATION MODES</text>
    ${cardsSvg}
    <rect x="${margin}" y="${sectionY}" width="${contentWidth}" height="188" rx="22" fill="#ffffff12" stroke="#ffffff24"/>
    <text x="${margin + 22}" y="${sectionY + 38}" class="section">DIRECT CALL</text>
    <circle cx="${margin + 42}" cy="${sectionY + 82}" r="21" fill="#ae68d7"/><text x="${margin + 75}" y="${sectionY + 88}" class="history">Mustahid</text>
    <rect x="${margin + contentWidth - 96}" y="${sectionY + 61}" width="74" height="42" rx="21" fill="#08a56b"/><text x="${margin + contentWidth - 73}" y="${sectionY + 87}" class="badge">CALL</text>
    <rect x="${margin + 22}" y="${sectionY + 122}" width="${contentWidth - 44}" height="48" rx="16" fill="url(#action)"/><text x="${margin + contentWidth / 2}" y="${sectionY + 152}" text-anchor="middle" class="history">HOLD FOR RECORDED PTT</text>
    <text x="${margin}" y="${historyY}" class="section">RECENT CALLS</text>
    <rect x="${margin}" y="${historyY + 22}" width="${contentWidth}" height="98" rx="18" fill="#ffffff12" stroke="#ffffff24"/>
    <text x="${margin + 22}" y="${historyY + 56}" class="history">Outgoing · Mustahid</text><text x="${margin + 22}" y="${historyY + 82}" class="meta">Completed · 02:14 · 3:11 PM</text>
    <rect x="${margin + contentWidth - 112}" y="${historyY + 47}" width="90" height="30" rx="15" fill="#0d9169"/><text x="${margin + contentWidth - 67}" y="${historyY + 67}" text-anchor="middle" class="badge">COMPLETED</text>
    <text x="${margin}" y="${height - 32}" class="meta">Deterministic UI contract snapshot · Phase 6</text>
  </svg>`;
}

await mkdir(outputDirectory, { recursive: true });
for (const surface of surfaces) {
  await sharp(Buffer.from(snapshotSvg(surface)))
    .png()
    .toFile(path.join(outputDirectory, `${surface.name}-calls-contract.png`));
}

console.log(`Wrote ${surfaces.length} snapshots to ${outputDirectory}`);
