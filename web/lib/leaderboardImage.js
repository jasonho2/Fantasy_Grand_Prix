// Renders a cup leaderboard to a PNG (drawn directly on a <canvas> -- no
// screenshot library needed) and copies it to the clipboard as an image.
// Used by the Contests page's "Copy" button: the image always shows the
// table as currently filtered/sorted (Mode, Sort by), even when the panel
// is in Chart view. Colors come from the page's own CSS variables, so the
// image matches whichever theme (light/dark) the viewer is using.

const SCALE = 2; // render at 2x so the pasted image stays sharp
const PAD = 16;
const ROW_H = 34;
const HEAD_H = 28;
const LOGO = 20;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Best effort: a logo that can't be loaded without tainting the canvas
// (cross-origin host without CORS) is skipped and drawn as a plain dot,
// same fallback TeamLogo uses on the page.
async function loadLogo(src) {
  if (!src) return null;
  try {
    const res = await fetch(src, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export async function renderLeaderboardPng({ heading, subheading, weeks, liveWeek, rows, podiumRankFor, logos, crowns }) {
  const colors = {
    bg: cssVar("--panel", "#ffffff"),
    border: cssVar("--border", "#c7cbd3"),
    text: cssVar("--text", "#14161a"),
    dim: cssVar("--text-dim", "#5b6169"),
    win: cssVar("--win", "#0f7a45"),
    loss: cssVar("--loss", "#b02e2e"),
    podiumBg: [null, cssVar("--podium-1-bg", "#fbf4dc"), cssVar("--podium-2-bg", "#eef1f5"), cssVar("--podium-3-bg", "#f8eadf")],
    podiumBar: [null, cssVar("--podium-1-bar", "#c9a53c"), cssVar("--podium-2-bar", "#9aa4b2"), cssVar("--podium-3-bar", "#b87a4b")],
  };

  const logoImgs = await Promise.all(rows.map((r) => loadLogo(logos?.[r.team])));

  // Measure the Team column so long names fit on one line.
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `600 14px ${FONT}`;
  const longestName = Math.max(...rows.map((r) => measure.measureText(r.team).width), 60);
  const hasCrowns = rows.some((r) => crowns?.[r.team]?.count);
  const crownW = hasCrowns ? 30 : 0;
  const deltaW = 30;

  const cols = [
    { key: "rank", label: "", w: 46, align: "left" },
    { key: "team", label: "Team", w: LOGO + 8 + Math.min(longestName, 280) + crownW + deltaW + 8, align: "left" },
    ...weeks.map((wk, i) => ({ key: `wk${i}`, label: `Wk ${wk}${wk === liveWeek ? " ●" : ""}`, w: 50, align: "center", index: i })),
    { key: "total", label: "Total", w: 56, align: "center" },
    { key: "pf", label: "PF", w: 72, align: "right" },
  ];
  const tableW = cols.reduce((s, c) => s + c.w, 0);
  const width = tableW + PAD * 2;
  const titleH = subheading ? 54 : 36;
  const height = PAD + titleH + HEAD_H + rows.length * ROW_H + PAD + 18;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  // Card background
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);

  // Title
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colors.text;
  ctx.font = `700 17px ${FONT}`;
  ctx.fillText(heading, PAD, PAD + 18);
  if (subheading) {
    ctx.fillStyle = colors.dim;
    ctx.font = `500 13px ${FONT}`;
    ctx.fillText(subheading, PAD, PAD + 40);
  }

  // Header row
  let y = PAD + titleH;
  ctx.font = `700 12px ${FONT}`;
  ctx.fillStyle = colors.dim;
  ctx.textBaseline = "middle";
  let x = PAD;
  for (const c of cols) {
    ctx.textAlign = c.align;
    const tx = c.align === "left" ? x + 4 : c.align === "center" ? x + c.w / 2 : x + c.w - 4;
    ctx.fillText(c.label, tx, y + HEAD_H / 2);
    x += c.w;
  }
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y + HEAD_H - 0.5);
  ctx.lineTo(PAD + tableW, y + HEAD_H - 0.5);
  ctx.stroke();
  y += HEAD_H;

  // Body rows
  rows.forEach((row, ri) => {
    const podium = podiumRankFor(row);
    if (podium) {
      ctx.fillStyle = colors.podiumBg[podium];
      ctx.fillRect(PAD, y, tableW, ROW_H);
      ctx.fillStyle = colors.podiumBar[podium];
      ctx.fillRect(PAD, y, 3, ROW_H);
    }
    const mid = y + ROW_H / 2;
    const bold = row.displayRank === 1;
    let cx = PAD;
    for (const c of cols) {
      ctx.fillStyle = colors.text;
      ctx.font = `${bold ? 700 : 400} 14px ${FONT}`;
      if (c.key === "rank") {
        ctx.textAlign = "left";
        ctx.fillText(ordinal(row.displayRank), cx + 8, mid);
      } else if (c.key === "team") {
        const img = logoImgs[ri];
        const lx = cx + 4;
        ctx.save();
        ctx.beginPath();
        ctx.arc(lx + LOGO / 2, mid, LOGO / 2, 0, Math.PI * 2);
        ctx.clip();
        if (img) ctx.drawImage(img, lx, mid - LOGO / 2, LOGO, LOGO);
        else {
          ctx.fillStyle = colors.border;
          ctx.fillRect(lx, mid - LOGO / 2, LOGO, LOGO);
        }
        ctx.restore();
        ctx.fillStyle = colors.text;
        ctx.font = `${bold ? 700 : 600} 14px ${FONT}`;
        ctx.textAlign = "left";
        const nameX = lx + LOGO + 8;
        ctx.fillText(row.team, nameX, mid);
        let after = nameX + measure.measureText(row.team).width + 8;
        const crown = crowns?.[row.team];
        if (crown?.count) {
          ctx.font = `18px ${FONT}`;
          ctx.fillText("\u{1F451}", after, mid);
          ctx.font = `800 9px ${FONT}`;
          ctx.fillStyle = "#4a2c00";
          ctx.textAlign = "center";
          ctx.fillText(String(crown.count), after + 10, mid + 2);
          ctx.textAlign = "left";
          after += 26;
        }
        if (row.rankDelta) {
          ctx.font = `700 11px ${FONT}`;
          ctx.fillStyle = row.rankDelta > 0 ? colors.win : colors.loss;
          ctx.fillText(`${row.rankDelta > 0 ? "▲" : "▼"}${Math.abs(row.rankDelta)}`, after, mid);
        }
      } else if (c.key.startsWith("wk")) {
        const v = row.weekly_points[c.index];
        ctx.textAlign = "center";
        ctx.fillStyle = v == null ? colors.dim : colors.text;
        ctx.fillText(v == null ? "—" : String(v), cx + c.w / 2, mid);
      } else if (c.key === "total") {
        ctx.textAlign = "center";
        ctx.font = `700 14px ${FONT}`;
        ctx.fillText(String(row.contest_points), cx + c.w / 2, mid);
      } else if (c.key === "pf") {
        ctx.textAlign = "right";
        ctx.fillText(String(row.fantasy_points), cx + c.w - 4, mid);
      }
      cx += c.w;
    }
    ctx.strokeStyle = colors.border;
    ctx.beginPath();
    ctx.moveTo(PAD, y + ROW_H - 0.5);
    ctx.lineTo(PAD + tableW, y + ROW_H - 0.5);
    ctx.stroke();
    y += ROW_H;
  });

  // Footer
  ctx.textAlign = "right";
  ctx.font = `500 11px ${FONT}`;
  ctx.fillStyle = colors.dim;
  ctx.fillText("fantasy-grand-prix.vercel.app", PAD + tableW, y + 14);

  // Outer border
  ctx.strokeStyle = colors.border;
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 10);
  ctx.stroke();

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render image"))), "image/png")
  );
}

// Copies the PNG to the clipboard. The ClipboardItem gets the *promise* of
// the blob (not an awaited blob) so Safari still treats the write as part
// of the original click. Browsers that can't put images on the clipboard
// (e.g. older Firefox) get the PNG downloaded instead.
// Returns "copied" | "downloaded" | "failed".
export async function copyLeaderboardImage(renderArgs, filename = "leaderboard.png") {
  const blobPromise = renderLeaderboardPng(renderArgs);
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blobPromise })]);
      return "copied";
    }
  } catch {
    // fall through to download
  }
  try {
    const blob = await blobPromise;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return "downloaded";
  } catch {
    return "failed";
  }
}
